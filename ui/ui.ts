import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, DynamicBorder, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Container, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { onPlanChange } from "../context/persistence";
import {
    OrchestratorState,
    buildStatusSummary,
    computeExecutionPhaseLabel,
    stripTaskPrefix,
    truncateToSentence,
    getPlanDb
} from "../core";
import type { PlanDatabase } from "../core/plan-database";
import { getCurrentOrchestrationState, isActive as stateIsActive, type OrchestrationState } from "../core/state-machine";
import {
    MONITOR_POLL_INTERVAL_MS,
    getActiveTaskInfo,
    renderTranscript,
    onMonitorChange,
    type ThemeLike
} from "../process/monitor";
import { MAX_CLARIFICATIONS, Task } from "../core/types";

// ---------------------------------------------------------------------------
// OrchestrationEditor - extends CustomEditor to color the input border based
// on orchestration mode (derived from explicit boolean flags):
//   amber  = planning mode
//   green  = executing mode
//   red    = executing but plan is paused/failed
//   violet = idle (orchestration active, not planning or executing)
// ---------------------------------------------------------------------------

/**
 * Replace the border characters (─) in an ANSI-styled line with a new color.
 * Walks the string byte-by-byte, skipping over CSI escape sequences so we
 * only recolor visible characters.
 * Uses the standard CSI terminator range (@-~) for robustness with extended
 * color formats (256-color, truecolor).
 */
function recolorBorderChars(line: string, borderColor: (s: string) => string): string {
    let out = "";
    let i = 0;
    while (i < line.length) {
        // Detect CSI escape sequence (\x1b[ … <terminator>)
        if (line[i] === "\x1b" && i + 1 < line.length && line[i + 1] === "[") {
            let j = i + 2;
            // Skip intermediate bytes (digits, letters a-z, etc.) until terminator
            while (j < line.length && !(line[j] >= "@" && line[j] <= "~")) j++;
            if (j < line.length) j++; // consume final terminator byte
            out += line.slice(i, j);
            i = j;
        } else {
            const ch = line[i];
            out += ch === "\u2500" ? borderColor(ch) : ch;
            i++;
        }
    }
    return out;
}

type SemanticColor = "success" | "warning" | "error" | "accent" | "text" | "dim" | "muted" | "mdHeading" | "border" | "borderAccent";

/** Resolve the semantic color for orchestration phase display. Uses state machine directly. */
function getOrchestrationPhaseColor(): ((s: string) => string) | null {
    if (!stateIsActive(OrchestratorState.currentState) || !OrchestratorState.theme) return null;

    const planDb = getPlanDb();
    // No plan yet - orchestration is active, so we're in the initial planning phase.
    if (!planDb) {
        return OrchestratorState.theme.fg.bind(OrchestratorState.theme, "mdHeading");
    }

    // Get canonical state from state machine
    const state = getCurrentOrchestrationState();
    const color: SemanticColor = STATE_COLORS[state] ?? "text";

    return OrchestratorState.theme.fg.bind(OrchestratorState.theme, color);
}

class OrchestrationEditor extends CustomEditor {
    constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings);
    }

    override render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length < 2) return lines;

        const phaseColor = getOrchestrationPhaseColor();
        if (!phaseColor) return lines;

        // Recolor top and bottom border lines
        lines[0] = recolorBorderChars(lines[0], phaseColor);
        lines[lines.length - 1] = recolorBorderChars(lines[lines.length - 1], phaseColor);
        return lines;
    }
}

/**
 * Install or remove the OrchestrationEditor.
 * When installed, the border color is computed dynamically on every render
 * based on OrchestratorState + current plan status.
 */
let orchestrationTui: TUI | undefined;

export function setOrchestrationEditor(install: boolean, ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (install) {
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            orchestrationTui = tui;
            return new OrchestrationEditor(tui, theme, keybindings);
        });
    } else {
        orchestrationTui = undefined;
        ctx.ui.setEditorComponent(undefined);
    }
}

/** Request a re-render so the border reflects the current plan state. */
export function refreshBorder() {
    orchestrationTui?.requestRender();
}

/** Update the footer status line and widget from any context (not just hooks).
 * Uses OrchestratorState.pi as fallback when ctx is not available. */
export function refreshUiStatus(ctx?: ExtensionContext) {
    const targetCtx = ctx || (OrchestratorState.pi as unknown as ExtensionContext);
    if (!targetCtx) return;

    // Guard: ExtensionAPI (OrchestratorState.pi) lacks a .ui property;
    // only proceed with UI updates when a real ExtensionContext is available.
    if (!targetCtx.ui) return;

    // Update footer status line
    if (stateIsActive(OrchestratorState.currentState)) {
        const planDb = getPlanDb();
        if (planDb) {
            targetCtx.ui.setStatus("orchestrator", buildStatusSummary());
        }
    }

    // Update widget content and border color
    updateWidget(targetCtx);
    refreshBorder();
}

// ---------------------------------------------------------------------------
// Shared display logic for widget and overlay (M2: deduplication)
// ---------------------------------------------------------------------------

interface PlanDisplayOptions {
    /** Shorter progress bar for compact widget display */
    compact?: boolean;
    /** Show detailed task info (overlay) or summary only (widget) */
    detailed?: boolean;
}

/** Lookup table mapping orchestration states to semantic colors. */
const STATE_COLORS: Record<OrchestrationState, SemanticColor> = {
    inactive: "text",
    planning: "mdHeading",
    plan_review: "borderAccent",
    plan_reviewed: "mdHeading",
    setup: "warning",
    implementing: "success",
    replanning: "warning",
    pausing: "warning",
    paused: "warning",
    stopped: "error",
    resuming: "success",
    failed: "error",
    verifying: "accent",
    completed: "border",
    code_review: "borderAccent"
};

/** Lookup table mapping execution phase labels to semantic colors (for backward compatibility). */
const PHASE_LABEL_COLORS: Record<string, SemanticColor> = {
    PLANNING: "mdHeading",
    SETUP: "warning",
    IMPLEMENTING: "success",
    REPLANNING: "warning",
    VERIFYING: "accent",
    PLAN_REVIEW: "borderAccent",
    CODE_REVIEW: "borderAccent",
    PAUSED: "warning",
    STOPPED: "error",
    COMPLETED: "border",
    FAILED: "error"
};

function resolveStatusLabelAndColor(
    phaseLabel: string | null | undefined,
): { label: string; color: SemanticColor } {
    if (phaseLabel) {
        return { label: phaseLabel, color: PHASE_LABEL_COLORS[phaseLabel] ?? "text" };
    }
    // Fallback: should not normally happen now that computeExecutionPhaseLabel is exhaustive.
    return { label: "COMPLETED", color: "accent" };
}

/** Strategy map for phase-detail message rendering. */
const PHASE_DETAIL_RENDERERS: Record<
    string,
    (lines: string[], planDb: PlanDatabase, theme: { fg: (color: SemanticColor, text: string) => string }) => void
> = {
    VERIFYING: (lines, _planDb, t) => {
        lines.push(t.fg("warning", "  -> Awaiting final verification by orchestrator"));
        lines.push(t.fg("dim", "  Use /om-resume to wake the reviewer if nothing happens"));
    },
    PLAN_REVIEW: (lines, _planDb, t) => {
        lines.push(t.fg("warning", "  -> Plan review in progress"));
        lines.push(t.fg("dim", "  Reviewer model is evaluating the implementation plan"));
    },
    CODE_REVIEW: (lines, _planDb, t) => {
        lines.push(t.fg("warning", "  -> Code review in progress or actions required"));
        lines.push(t.fg("dim", "  Read .pi/orchestration/plans/code-review.md for findings"));
    },
    SETUP: (lines, _planDb, t) => {
        lines.push(t.fg("warning", "  -> Setting up task execution environment"));
        lines.push(t.fg("dim", "  Tasks are being prepared for implementation"));
    },
    REPLANNING: (lines, planDb, t) => {
        const tasks = planDb.getTasks();
        const clarifyingTask = tasks.find((t2: Task) => t2.status === "awaiting_clarification");
        if (clarifyingTask) {
            const attempts = clarifyingTask.clarificationAttempts || 1;
            lines.push(
                t.fg(
                    "error",
                    `  -> Waiting for: "${clarifyingTask.clarificationQuery}" (${attempts}/${MAX_CLARIFICATIONS})`
                )
            );
            lines.push(t.fg("dim", "  Use /om-resume to continue"));
        } else {
            const failedTasks = tasks.filter((t2: Task) => t2.status === "failed");
            if (failedTasks.length > 0) {
                lines.push(t.fg("error", `  -> ${failedTasks.length} task(s) failed - awaiting orchestrator decision`));
                lines.push(t.fg("dim", "  Use /om-resume to wake the orchestrator"));
            } else {
                lines.push(t.fg("warning", "  -> Execution paused - awaiting orchestrator decision"));
                lines.push(t.fg("dim", "  Use /om-resume to continue"));
            }
        }
    },
    PAUSED: (lines, _planDb, t) => {
        lines.push(t.fg("warning", "  -> Execution paused by user (/om-pause)"));
        lines.push(t.fg("dim", "  Use /om-resume to continue"));
    },
    STOPPED: (lines, _planDb, t) => {
        lines.push(t.fg("error", "  -> Execution stopped by user (/om-stop)"));
        lines.push(t.fg("dim", "  Use /om-resume to continue or /om-reset to start fresh"));
    },
    PLANNING: (lines, _planDb, t) => {
        lines.push(t.fg("text", "  -> Building plan..."));
    },
    COMPLETED: (lines, _planDb, t) => {
        lines.push(t.fg("accent", "  -> All tasks completed. Orchestration finished."));
    },
    FAILED: (lines, _planDb, t) => {
        lines.push(t.fg("error", "  -> Plan failed"));
        lines.push(t.fg("dim", "  Use /om-resume to recover or /om-enable"));
    }
};

function appendPhaseDetailMessages(
    lines: string[],
    phaseLabel: string | null | undefined,
    planDb: PlanDatabase,
    theme: { fg: (color: SemanticColor, text: string) => string }
): void {
    if (phaseLabel && PHASE_DETAIL_RENDERERS[phaseLabel]) {
        PHASE_DETAIL_RENDERERS[phaseLabel](lines, planDb, theme);
    }
}

/** Map a single task's status to its display color using a lookup table. */
function resolveTaskStatusColor(status: string): SemanticColor {
    const STATUS_COLORS: Record<string, SemanticColor> = {
        running: "warning",
        validating: "warning",
        summarizing: "warning",
        awaiting_clarification: "error",
        failed: "error",
        completed: "success",
        pending: "dim"
    };
    return STATUS_COLORS[status] ?? "text";
}

/** @todo Extract active/pending/completed task rendering into separate functions for clarity. */
function buildPlanDisplay(
    planDb: PlanDatabase,
    theme: { fg: (color: SemanticColor, text: string) => string },
    options: PlanDisplayOptions = {}
): string[] {
    const { compact = false, detailed = false } = options;
    const lines: string[] = [];

    // Header with status and goal
    const phaseLabel = computeExecutionPhaseLabel();
    const { label: statusLabel, color: statusColor } = resolveStatusLabelAndColor(phaseLabel);
    lines.push(theme.fg(statusColor, `Orchestrator [${statusLabel}]`));
    const goal = planDb.getGoal();
    if (goal) {
        lines.push(`Goal: ${goal}`);
    }

    // Task progress bar
    const tasks = planDb.getTasks();
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t: Task) => t.status === "completed").length;
    if (totalTasks > 0) {
        const barLen = compact ? 20 : 30;
        const filled = Math.round((completedTasks / totalTasks) * barLen);
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        lines.push(theme.fg("dim", `  [${bar}] ${completedTasks}/${totalTasks} tasks`));
    }

    // Phase-specific detail messages
    appendPhaseDetailMessages(lines, phaseLabel, planDb, theme);

    if (tasks.length > 0) {
        const activeTasks = tasks.filter((t: Task) => t.status !== "completed" && t.status !== "pending");
        const pendingTasks = tasks.filter((t: Task) => t.status === "pending");
        const completedTasksList = tasks.filter((t: Task) => t.status === "completed");

        if (detailed) {
            if (activeTasks.length > 0) {
                lines.push("");
                lines.push(theme.fg("accent", "Active Tasks:"));
                for (const task of activeTasks) {
                    const tStatusColor = resolveTaskStatusColor(task.status);
                    lines.push(
                        theme.fg(
                            tStatusColor,
                            `  ▶ ${stripTaskPrefix(task.id)} [${task.status}] ${truncateToSentence(task.description)}`
                        )
                    );
                    if (task.clarificationQuery) {
                        const attempts = task.clarificationAttempts || 1;
                        lines.push(
                            theme.fg("error", `     "${task.clarificationQuery}" (${attempts}/${MAX_CLARIFICATIONS})`)
                        );
                    }
                }
            }

            if (pendingTasks.length > 0) {
                lines.push("");
                lines.push(theme.fg("accent", "Pending Tasks:"));
                for (const task of pendingTasks) {
                    lines.push(
                        theme.fg("dim", `  ○ ${stripTaskPrefix(task.id)}: ${truncateToSentence(task.description)}`)
                    );
                }
            }

            if (completedTasksList.length > 0) {
                lines.push("");
                lines.push(theme.fg("success", "Completed Tasks:"));
                for (const task of completedTasksList) {
                    lines.push(
                        theme.fg("success", `  ✓ ${stripTaskPrefix(task.id)}: ${truncateToSentence(task.description)}`)
                    );
                }
            }
        } else {
            // Compact widget view - show all active tasks
            if (activeTasks.length > 0) {
                // Group by status category for compact single-line rendering
                const runningTasks = activeTasks.filter(
                    (t: Task) => t.status === "running" || t.status === "validating" || t.status === "summarizing"
                );
                const errorTasks = activeTasks.filter(
                    (t: Task) => t.status === "awaiting_clarification" || t.status === "failed"
                );
                const otherActive = activeTasks.filter(
                    (t: Task) => !runningTasks.includes(t) && !errorTasks.includes(t)
                );

                if (runningTasks.length > 0) {
                    const labels = runningTasks.map((t: Task) => `${stripTaskPrefix(t.id)} [${t.status}]`).join(", ");
                    lines.push(theme.fg("warning", `Task: ${labels}`));
                }
                for (const task of errorTasks) {
                    const tStatusColor = resolveTaskStatusColor(task.status);
                    lines.push(theme.fg(tStatusColor, `Task: ${stripTaskPrefix(task.id)} [${task.status}]`));
                    if (task.clarificationQuery) {
                        const attempts = task.clarificationAttempts || 1;
                        lines.push(
                            theme.fg("error", `     "${task.clarificationQuery}" (${attempts}/${MAX_CLARIFICATIONS})`)
                        );
                    }
                }
                for (const task of otherActive) {
                    lines.push(theme.fg("text", `Task: ${stripTaskPrefix(task.id)} [${task.status}]`));
                }
            } else if (pendingTasks.length > 0) {
                const activeTask = pendingTasks[0];
                const tStatusColor = resolveTaskStatusColor(activeTask.status);
                lines.push(theme.fg(tStatusColor, `Task: ${stripTaskPrefix(activeTask.id)} [${activeTask.status}]`));
            }
        }
    }

    return lines;
}

// ---------------------------------------------------------------------------
// Height-aware view builders for the /om-status overlay
// ---------------------------------------------------------------------------

/** Absolute maximum lines for the overlay content. */
const OVERLAY_MAX_LINES = 34;
/** Percentage of TUI height to use as a soft cap (framework enforces this). */
const OVERLAY_HEIGHT_PCT = 70;
/** Lines reserved inside the overlay: borders, blank separators, footer hint. */
const OVERLAY_RESERVED_LINES = 5;

/** Compute usable content lines for the overlay.
 * We use a fixed budget rather than trying to estimate terminal height from
 * render width - the width-based heuristic (width × 0.28) is unreliable across
 * different TUI layouts and can severely under-count available rows.
 *
 * The framework enforces the 70 % maxHeight cap, so if we emit more lines than
 * fit they are clipped / scrolled. We just need a generous-enough budget that
 * actually fills the space on typical terminals (40 – 60 rows). */
function computeOverlayContentLines(_tuiWidth: number): number {
    return Math.max(OVERLAY_RESERVED_LINES, OVERLAY_MAX_LINES - OVERLAY_RESERVED_LINES);
}

/**
 * Append task entries into `lines` until the budget is exhausted.
 * Each entry costs 1 line (plus optional extra for clarification queries).
 * Returns the number of hidden entries (for truncation indicator). */
function appendTasksWithinBudget(
    lines: string[],
    tasks: Task[],
    theme: { fg: (color: SemanticColor, text: string) => string },
    width: number,
    maxContentLines: number
): number {
    let shown = 0;
    for (const task of tasks) {
        // Reserve room for a possible truncation indicator line at the end.
        if (lines.length >= maxContentLines - 1) break;
        lines.push(
            theme.fg(
                "dim",
                truncateToWidth(`  ○ ${stripTaskPrefix(task.id)}: ${truncateToSentence(task.description)}`, width)
            )
        );
        shown++;
    }
    return tasks.length - shown;
}

/**
 * Append completed task entries into `lines` until the budget is exhausted.
 */
function appendCompletedTasksWithinBudget(
    lines: string[],
    tasks: Task[],
    theme: { fg: (color: SemanticColor, text: string) => string },
    width: number,
    maxContentLines: number
): number {
    let shown = 0;
    for (const task of tasks) {
        if (lines.length >= maxContentLines - 1) break;
        lines.push(
            theme.fg(
                "success",
                truncateToWidth(`  ✓ ${stripTaskPrefix(task.id)}: ${truncateToSentence(task.description)}`, width)
            )
        );
        shown++;
    }
    return tasks.length - shown;
}

/** Build the task-list view with height-aware section rendering. */
function buildTaskListView(
    planDb: PlanDatabase,
    theme: { fg: (color: SemanticColor, text: string) => string },
    width: number,
    maxContentLines: number
): string[] {
    const lines: string[] = [];

    // --- Header (label + goal + progress bar + phase detail messages) ---
    const phaseLabel = computeExecutionPhaseLabel();
    const { label: statusLabel, color: statusColor } = resolveStatusLabelAndColor(phaseLabel);
    lines.push(theme.fg(statusColor, `Orchestrator [${statusLabel}]`));
    const goal = planDb.getGoal();
    if (goal) {
        lines.push(truncateToWidth(`Goal: ${goal}`, width));
    }

    const tasks = planDb.getTasks();
    const totalTasks = tasks.length;
    const completedCount = tasks.filter((t: Task) => t.status === "completed").length;
    if (totalTasks > 0) {
        const barLen = 30;
        const filled = Math.round((completedCount / totalTasks) * barLen);
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        lines.push(theme.fg("dim", `  [${bar}] ${completedCount}/${totalTasks} tasks`));
    }

    appendPhaseDetailMessages(lines, phaseLabel, planDb, theme);

    // --- Remaining budget for task sections ---
    let remaining = maxContentLines - lines.length;
    if (remaining < 3) return lines; // not enough space for any section

    const activeTasks = tasks.filter((t: Task) => t.status !== "completed" && t.status !== "pending");
    const pendingTasks = tasks.filter((t: Task) => t.status === "pending");
    const completedTasksList = tasks.filter((t: Task) => t.status === "completed");

    // --- Active tasks (always shown, amber-highlighted) ---
    if (activeTasks.length > 0 && remaining >= 2) {
        lines.push("");
        lines.push(theme.fg("accent", "Active Tasks:"));
        for (const task of activeTasks) {
            const tStatusColor = resolveTaskStatusColor(task.status);
            lines.push(
                theme.fg(
                    tStatusColor,
                    truncateToWidth(
                        `  ▶ ${stripTaskPrefix(task.id)} [${task.status}] ${truncateToSentence(task.description)}`,
                        width
                    )
                )
            );
            if (task.clarificationQuery) {
                const attempts = task.clarificationAttempts || 1;
                lines.push(
                    theme.fg(
                        "error",
                        truncateToWidth(`     "${task.clarificationQuery}" (${attempts}/${MAX_CLARIFICATIONS})`, width)
                    )
                );
            }
        }
    }

    remaining = maxContentLines - lines.length;

    // --- Pending tasks (fill remaining space) ---
    if (pendingTasks.length > 0 && remaining >= 2) {
        lines.push("");
        lines.push(theme.fg("accent", "Pending Tasks:"));
        const hidden = appendTasksWithinBudget(lines, pendingTasks, theme, width, maxContentLines);
        if (hidden > 0) {
            lines.push(theme.fg("dim", `  … (${hidden} more pending tasks hidden)`));
        }
    }

    remaining = maxContentLines - lines.length;

    // --- Completed tasks (fill any leftover space) ---
    if (completedTasksList.length > 0 && remaining >= 2) {
        lines.push("");
        lines.push(theme.fg("success", "Completed Tasks:"));
        const hidden = appendCompletedTasksWithinBudget(lines, completedTasksList, theme, width, maxContentLines);
        if (hidden > 0) {
            lines.push(theme.fg("success", `  … (${hidden} more completed tasks hidden)`));
        }
    }

    return lines;
}

/** Build the sub-agent monitor view with reversed transcript (newest first).
 * Layout: task goal header → "Agent Console Output:" → reversed console lines.
 */
function buildMonitorView(
    taskInfo: ReturnType<typeof getActiveTaskInfo>,
    planDb: PlanDatabase,
    theme: { fg: (color: any, text: string) => string },
    width: number,
    maxContentLines: number
): string[] {
    const lines: string[] = [];

    if (!taskInfo || !taskInfo.label) {
        lines.push(theme.fg("muted", "No sub-agent running"));
        return lines;
    }

    // --- Task goal header (like task-list view) ---
    const activeTask = planDb.getTasks().find((t: Task) => t.id === taskInfo.taskId);
    if (activeTask) {
        const statusColor = resolveTaskStatusColor(activeTask.status);
        lines.push(
            theme.fg(
                statusColor,
                truncateToWidth(
                    `${stripTaskPrefix(activeTask.id)} [${activeTask.status}] ${truncateToSentence(activeTask.description)}`,
                    width
                )
            )
        );
    }

    lines.push("");
    lines.push(theme.fg("accent", "Agent Console Output (newest lines first):"));
    lines.push("");

    // --- Render transcript (entries reversed so newest message is at top) ---
    const transcriptEntries = taskInfo.entries || [];
    if (transcriptEntries.length > 0) {
        // Reverse entries (not rendered lines) so each message keeps its
        // internal line order intact, while newer messages appear first.
        const reversedEntries = [...transcriptEntries].reverse();
        const renderedLines = renderTranscript(reversedEntries, theme as unknown as ThemeLike, width);
        let remaining = maxContentLines - lines.length;
        if (remaining >= 1) {
            if (renderedLines.length > remaining) {
                lines.push(...renderedLines.slice(0, remaining));
                lines.push(theme.fg("dim", `… (${renderedLines.length - remaining} older lines hidden below)`));
            } else {
                lines.push(...renderedLines);
            }
        }
    }

    return lines;
}

// ---------------------------------------------------------------------------
// Public UI functions
// ---------------------------------------------------------------------------

/**
 * Open the dual-view live-updating overlay: task list ↔ sub-agent monitor.
 *
 * Task List View:
 *   ── top border (phase color) ──
 *   navigation hint
 *   status header, goal, progress bar
 *   state-specific messages
 *   active / pending / completed tasks (height-aware)
 *   ── bottom border (phase color) ──
 *
 * Monitor View:
 *   ── top border (phase color) ──
 *   navigation hint
 *   task goal header (id, status, description)
 *   "Agent Console Output:" label
 *   transcript lines reversed (newest first so clipping never hides recent activity)
 *   ── bottom border (phase color) ──
 *
 * Enter toggles between views. Escape closes.
 * Auto-refreshes on plan-change and monitor-change events.
 */
export async function showOrchestratorStatus(ctx: ExtensionContext) {
    const planDb = getPlanDb();
    if (!planDb) return;

    await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
            let currentPlanDb = planDb;
            let unsubscribed = false;
            let cachedWidth = 0;
            let cachedLines: string[] | null = null;
            let viewMode: "tasks" | "monitor" = "tasks";

            function getPhaseColorFn(): ((s: string) => string) | null {
                return getOrchestrationPhaseColor() ?? null;
            }

            function buildRenderContent(width: number): Container {
                const phaseColor = getPhaseColorFn();
                const borderColorFn = (s: string) =>
                    phaseColor ? phaseColor(s) : theme.fg("customMessageLabel" as Parameters<typeof theme.fg>[0], s);

                const maxContentLines = computeOverlayContentLines(width);
                const hintLine = theme.fg(
                    "customMessageLabel" as Parameters<typeof theme.fg>[0],
                    viewMode === "tasks"
                        ? "Press Escape to close, or Press Enter to Monitor the Sub-Agents"
                        : "Press Escape to close, or Press Enter to view Task List"
                );

                let contentLines: string[];

                if (viewMode === "tasks") {
                    contentLines = buildTaskListView(
                        currentPlanDb,
                        ctx.ui.theme as unknown as typeof theme,
                        width,
                        maxContentLines - 2 // reserve hint + blank separator at top
                    );
                } else {
                    const taskInfo = getActiveTaskInfo();
                    contentLines = buildMonitorView(
                        taskInfo,
                        currentPlanDb,
                        theme,
                        width,
                        maxContentLines - 2 // reserve hint + blank separator at top
                    );
                }

                // Prepend navigation hint so it's always visible even if bottom is clipped
                const allLines: string[] = [hintLine, "", ...contentLines];

                const content = new Text(allLines.join("\n") + "\n", 0, 0);
                const container = new Container();
                container.addChild(new DynamicBorder(borderColorFn));
                container.addChild(content);
                container.addChild(new DynamicBorder(borderColorFn));
                return container;
            }

            // --- Event listeners for live updates ---
            const onPlanChanged = onPlanChange(() => {
                if (unsubscribed) return;
                const refreshedPlanDb = getPlanDb();
                if (refreshedPlanDb) {
                    currentPlanDb = refreshedPlanDb;
                    cachedLines = null;
                    tui.requestRender();
                }
            });

            const onMonitorChanged = onMonitorChange(() => {
                if (!unsubscribed) {
                    cachedLines = null;
                    tui.requestRender();
                }
            });

            function render(width: number): string[] {
                const container = buildRenderContent(width);
                if (cachedLines && cachedWidth === width) return cachedLines;
                const rendered = container.render(width);
                cachedLines = rendered.map((l) => truncateToWidth(l, width));
                cachedWidth = width;
                return cachedLines;
            }

            // Poll for smooth updates (new transcript events arrive asynchronously)
            const intervalId = setInterval(() => {
                if (!unsubscribed) {
                    cachedLines = null;
                    tui.requestRender();
                }
            }, MONITOR_POLL_INTERVAL_MS);

            return {
                render,
                invalidate() {
                    cachedLines = null;
                },
                handleInput(data: string) {
                    if (matchesKey(data, "escape")) {
                        done();
                    } else if (matchesKey(data, "return")) {
                        viewMode = viewMode === "tasks" ? "monitor" : "tasks";
                        cachedLines = null;
                        tui.requestRender();
                    }
                },
                onDispose() {
                    unsubscribed = true;
                    clearInterval(intervalId);
                    onPlanChanged(); // unsubscribe
                    onMonitorChanged(); // unsubscribe
                }
            };
        },
        {
            overlay: true,
            overlayOptions: { anchor: "top-left", width: "100%", maxHeight: `${OVERLAY_HEIGHT_PCT}%` },
            onHandle: (handle) => {
                handle.focus(); // CRITICAL: Focus the overlay so it receives keystrokes!
            }
        }
    );
}

/**
 * Set up the orchestrator status widget (compact display above the editor).
 *
 * Registers `session_start`, `turn_end`, and `session_shutdown` hooks.
 * On plan-change events, updates both the widget content and the footer
 * status line. Only clears its own listener on shutdown to avoid leaking.
 */
export function setupUIWidget(pi: ExtensionAPI) {
    let widgetCtx: ExtensionContext | undefined;
    let planChangeListenerCleanup: (() => void) | undefined;

    // Capture context on session start so the widget can show immediately
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
        widgetCtx = ctx;
        // Show widget immediately if there's an existing plan
        const planDb = getPlanDb();
        if (planDb && planDb.getStatus() !== "completed") {
            updateWidget(ctx);
        }
    });

    pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
        widgetCtx = ctx;
        // Refresh widget and status line after the turn completes (agent has processed).
        if (!stateIsActive(OrchestratorState.currentState)) {
            clearUI(ctx);
            return;
        }
        const planDb = getPlanDb();
        if (planDb && planDb.getStatus() !== "completed") {
            updateWidget(ctx);
            ctx.ui.setStatus("orchestrator", buildStatusSummary());
        }
    });

    // Register plan change listener and track cleanup handle
    planChangeListenerCleanup = onPlanChange(() => {
        if (!widgetCtx) return;
        if (!stateIsActive(OrchestratorState.currentState)) {
            clearUI(widgetCtx);
            return;
        }
        updateWidget(widgetCtx);
        refreshBorder();
        // Refresh footer status line
        const planDb = getPlanDb();
        if (widgetCtx) {
            if (planDb) {
                widgetCtx.ui.setStatus("orchestrator", buildStatusSummary());
            } else {
                widgetCtx.ui.setStatus("orchestrator", undefined);
            }
        }
    });

    // Clean up listeners on session shutdown to prevent duplicates after /reload
    pi.on("session_shutdown", async () => {
        if (planChangeListenerCleanup) {
            planChangeListenerCleanup();
            planChangeListenerCleanup = undefined;
        }
    });
}

/**
 * Explicitly clear all orchestration UI elements (widget + footer status).
 * Called on exit so the UI is cleaned up immediately, even if a plan file
 * still exists on disk.
 */
export function clearUI(ctx: ExtensionContext) {
    ctx.ui.setWidget("orchestrator-status", undefined);
    ctx.ui.setStatus("orchestrator", undefined);
}

function updateWidget(ctx: ExtensionContext) {
    if (!stateIsActive(OrchestratorState.currentState)) {
        ctx.ui.setWidget("orchestrator-status", undefined);
        return;
    }

    const planDb = getPlanDb();
    if (!planDb || planDb.getStatus() === "completed") {
        ctx.ui.setWidget("orchestrator-status", undefined);
        return;
    }

    // Use shared display builder for consistent widget/overlay rendering
    const lines = buildPlanDisplay(planDb, ctx.ui.theme, {
        compact: true,
        detailed: false
    });

    ctx.ui.setWidget("orchestrator-status", lines, { placement: "aboveEditor" });
}
