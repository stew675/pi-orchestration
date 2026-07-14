import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StateManager } from "../context/state-manager";
import { PLANNING_HINT_EDIT } from "../context/prompts";
import { killAllProcesses } from "../process/process-manager";
import { buildFinalReviewMessage } from "../runner/utils";
import { Runner } from "../runner";
import {
    OrchestratorState,
    requireActive,
    setOrchestrationMode,
    recoverInterruptedTasks,
    requestSystemPromptRestore,
    captureCurrentModel,
    switchToOrchestrationModel,
    restoreMainModel,
    enterPlanningMode,
    exitPlanningMode
} from "../core";
import { showOrchestratorStatus, setOrchestrationEditor, clearUI, refreshBorder } from "../ui/ui";
import { openSettingsMenu } from "../settings/settings-menu";
import { AcceptOrEditDialog } from "../ui/accept-or-edit-dialog";
import type { OrchestrationPlan, Task } from "../core/types";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";

/**
 * Enter orchestration mode: capture current model, optionally switch to
 * the configured orchestration model, and set up UI/editor.
 */
async function enterOrchestrationMode(pi: ExtensionAPI, ctx: ExtensionContext) {
    // Capture the currently active main model before switching
    if (ctx.model && OrchestratorState.originalMainModel === undefined) {
        captureCurrentModel({ provider: ctx.model.provider, id: ctx.model.id });
    }

    // Switch to orchestration model if configured
    if (OrchestratorState.orchestrationModel) {
        const switched = await switchToOrchestrationModel(pi, ctx);
        if (!switched) {
            ctx.ui.notify(
                `Orchestration model ${OrchestratorState.orchestrationModel.provider}/${OrchestratorState.orchestrationModel.id} unavailable - using current model instead.`,
                "warning"
            );
        } else {
            const orchStr = `${OrchestratorState.orchestrationModel.provider}/${OrchestratorState.orchestrationModel.id}`;
            ctx.ui.notify(`Switched to orchestration model: ${orchStr}`, "info");
        }
    }

    setOrchestrationEditor(true, ctx);
}

/**
 * Exit orchestration mode: kill processes, restore normal Pi mode, preserve plan.
 */
async function exitOrchestration(pi: ExtensionAPI, ctx: ExtensionContext) {
    killAllProcesses("SIGKILL");

    // Plan is intentionally NOT cleared - incomplete plans on disk
    // are preserved so they can be resumed later via /om-enable.
    setOrchestrationMode(false, false, false, pi, refreshBorder);
    requestSystemPromptRestore();

    // Restore the original main model if one was captured
    const restored = await restoreMainModel(pi, ctx);
    if (restored) {
        ctx.ui.notify("Restored original main model.", "info");
    } else if (OrchestratorState.originalMainModel !== undefined) {
        // Still defined → restore failed (auth issue or not found)
        const orig = OrchestratorState.originalMainModel;
        ctx.ui.notify(
            `Cannot restore original model ${orig.provider}/${orig.id} - staying on current model.`,
            "warning"
        );
    }

    clearUI(ctx);
    setOrchestrationEditor(false, ctx);
    ctx.ui.notify("Orchestration exited. Returned to normal Pi mode. Plan preserved on disk for later resume.", "info");
}

// --- Strategy-map leaf handlers for resumePlanExecution ---

/** Send a structured orchestrator wake-up message as a follow-up turn. */
function sendResumeMessage(pi: ExtensionAPI, content: string) {
    pi.sendMessage(
        { customType: "orchestrator_event", content, display: false },
        { deliverAs: "followUp", triggerTurn: true }
    );
}

function handleResumeReview(_plan: OrchestrationPlan, pi: ExtensionAPI) {
    sendResumeMessage(
        pi,
        `System: Resuming from review state. All tasks completed. Inspect the project files and verify they satisfy the original goal. If deficiencies exist, use orchestrate_add_task to add remediation tasks. If everything meets the goal, call orchestrate_approve_goal to finish.`
    );
}

function handleResumeExecutingOrPaused(plan: OrchestrationPlan, pi: ExtensionAPI) {
    const clarifyingTask = (plan.tasks || []).find((t: Task) => t.status === "awaiting_clarification");
    if (clarifyingTask) {
        sendResumeMessage(
            pi,
            `System: Resuming. Task '${clarifyingTask.id}' is awaiting clarification: "${clarifyingTask.clarificationQuery}". Ask the user for the answer, then use orchestrate_resume_task.`
        );
        return;
    }

    const next = findNextTaskToRun(plan);
    if (!next) {
        plan.status = "reviewing";
        StateManager.savePlan(plan);
        const reviewMessage = buildFinalReviewMessage(
            plan,
            "System: All tasks completed on resume. Entering FINAL REVIEW."
        );
        sendResumeMessage(pi, reviewMessage);
        return;
    }

    if (next.status === "failed") {
        sendResumeMessage(
            pi,
            `System: Resuming. Task '${next.id}' is in failed state. Use orchestrate_check_status to inspect, then orchestrate_replan to recover before resuming execution.`
        );
        return;
    }

    plan.status = "executing";
    plan.currentTaskId = next.id;
    StateManager.savePlan(plan);
    sendResumeMessage(
        pi,
        `System: Resuming execution. Task '${next.id}' is the next to run. Call orchestrate_start_task("${next.id}") to begin, then yield control.`
    );
}

function handleResumePlanning(_plan: OrchestrationPlan, pi: ExtensionAPI) {
    sendResumeMessage(
        pi,
        `System: Resuming from planning state. Use orchestrate_get_plan to review the current tasks, then use orchestrate_start_task to begin execution.`
    );
}

function handleResumeFailed(plan: OrchestrationPlan, pi: ExtensionAPI) {
    plan.status = "paused";
    StateManager.savePlan(plan);
    sendResumeMessage(
        pi,
        `System: Resuming from failed state. Use orchestrate_check_status to inspect, then orchestrate_replan to recover.`
    );
}

/**
 * Resume execution of an existing plan. Common logic shared by /om-enable and /om-resume.
 *
 * Sends a follow-up user message so the orchestrator wakes up after its current turn
 * completes (if any). This avoids the race that occurs when sending a user message and
 * spawning the Runner simultaneously - both would try to send messages to the agent at
 * the same time. By using deliverAs: "followUp" we let the orchestrator drive execution
 * through its normal tool flow (orchestrate_start_task → Runner), which is inherently
 * safe and idempotent.
 */
function resumePlanExecution(_stalePlan: unknown, pi: ExtensionAPI) {
    const plan = StateManager.loadPlan();
    if (!plan) return;

    killAllProcesses("SIGKILL");

    const handlers: Record<string, (p: OrchestrationPlan, pi: ExtensionAPI) => void> = {
        reviewing: handleResumeReview,
        executing: handleResumeExecutingOrPaused,
        paused: handleResumeExecutingOrPaused,
        planning: handleResumePlanning,
        failed: handleResumeFailed
    };

    const handler = handlers[plan.status];
    if (handler) {
        handler(plan, pi);
    }
}

/** Find the next task that needs work, or null if all done. */
function findNextTaskToRun(plan: OrchestrationPlan): Task | null {
    const currentTask = plan.currentTaskId ? plan.tasks.find((t: Task) => t.id === plan.currentTaskId) : undefined;
    if (currentTask && currentTask.status !== "completed") {
        return currentTask;
    }
    const completedTaskIds = new Set(plan.tasks.filter((t) => t.status === "completed").map((t) => t.id));
    const readyTask = plan.tasks.find((t) => {
        if (t.status !== "pending" && t.status !== "failed") return false;
        const deps = t.dependencies || [];
        return deps.every((depId) => completedTaskIds.has(depId));
    });
    if (readyTask) return readyTask;

    const nonCompleted = plan.tasks.find((t) => t.status !== "completed");
    return nonCompleted || null;
}

// --- /om-enable toggle-ON helper functions ---

/**
 * Shared bootstrap for entering planning mode with a clean context.
 * Used by multiple /om-enable toggle-ON paths.
 */
async function enterPlanningWithCleanContext(pi: ExtensionAPI, ctx: ExtensionContext) {
    await enterOrchestrationMode(pi, ctx);
    setOrchestrationMode(true, false, true, pi, refreshBorder);
    OrchestratorState.shouldResetContext = true;
    // Reset planning hint one-shot flags for a fresh session
    OrchestratorState._preWriteHintSent = false;
    await enterPlanningMode(pi, ctx);
}

/**
 * Handle the "resume existing incomplete plan" path of /om-enable toggle ON.
 */
async function handleResumeExistingPlan(plan: OrchestrationPlan, pi: ExtensionAPI, ctx: ExtensionContext) {
    const resume = await ctx.ui.confirm(
        "Resume existing orchestration?",
        `Found incomplete plan: "${plan.goal}" (${plan.status}).\n\nSelect Yes to resume, or No to discard and start fresh.`
    );

    if (resume) {
        // Resume the existing plan
        await enterOrchestrationMode(pi, ctx);
        setOrchestrationMode(true, true, false, pi, refreshBorder);
        OrchestratorState.shouldResetContext = true;
        OrchestratorState._manualPause = false;
        OrchestratorState._pauseReason = null;

        // Recover interrupted tasks
        const recovered = recoverInterruptedTasks(plan);
        if (recovered > 0) {
            StateManager.savePlan(plan);
        }

        ctx.ui.notify(
            recovered > 0
                ? `Resuming orchestration: "${plan.goal}" (${recovered} interrupted task(s) recovered).`
                : `Resuming orchestration: "${plan.goal}".`,
            "info"
        );

        resumePlanExecution(plan, pi);
    } else {
        // Discard - clear everything and start fresh
        StateManager.clearPlan();
        await enterPlanningWithCleanContext(pi, ctx);
        ctx.ui.notify("Previous plan discarded. Orchestration enabled in planning mode with a clean context.", "info");
    }
}

/**
 * Handle the "existing implementation-plan.md found" path of /om-enable toggle ON.
 */
async function handleExistingImplPlan(
    existingImplPlan: string,
    plan: OrchestrationPlan | null,
    pi: ExtensionAPI,
    ctx: ExtensionContext
) {
    const preview = existingImplPlan.length > 200 ? existingImplPlan.substring(0, 200) + "\u2026" : existingImplPlan;

    const useExisting = await ctx.ui.confirm(
        "Previous implementation plan found",
        `Found an existing implementation-plan.md on disk:\n\n${preview}\n\nUse this as a starting point (you can review and edit it), or discard and start fresh? Note: Entering planning mode will clear your current session context.`
    );

    if (useExisting) {
        // Keep implementation-plan.md; clear stale plan.json artifacts only
        if (plan && plan.status === "completed") {
            StateManager.clearPlanJsonOnly();
        }
        await enterPlanningWithCleanContext(pi, ctx);
        ctx.ui.notify("Planning mode enabled with existing plan on disk. Context cleared for clean slate.", "info");
        // Instruct the model to present the existing plan via orchestrate_present_plan,
        // which triggers the full plan display + Accept/Edit dialog automatically.
        pi.sendMessage(
            {
                customType: "orchestrator_event",
                content:
                    `System: A previous implementation plan exists on disk. ` +
                    `Call orchestrate_present_plan() to display it to the user, then STOP IMMEDIATELY.`,
                display: false
            },
            { triggerTurn: true }
        );
    } else {
        // Discard everything
        StateManager.clearPlan();
        await enterPlanningWithCleanContext(pi, ctx);
        ctx.ui.notify("Previous plan discarded. Orchestration enabled in planning mode with a clean context.", "info");
    }
}

/**
 * Handle the "fresh start / no existing plans" path of /om-enable toggle ON.
 */
async function handleFreshStart(plan: OrchestrationPlan | null, pi: ExtensionAPI, ctx: ExtensionContext) {
    if (plan && plan.status === "completed") {
        StateManager.clearPlan();
    }
    await enterPlanningWithCleanContext(pi, ctx);
    ctx.ui.notify("Orchestration enabled in planning mode with a clean context.", "info");
}

export function registerEnableCommand(pi: ExtensionAPI) {
    pi.registerCommand("om-enable", {
        description: "Toggle orchestration mode on/off",
        handler: async (_args, ctx) => {
            // --- Toggle OFF ---
            if (OrchestratorState.isActive) {
                const ok = await ctx.ui.confirm(
                    "Exit orchestration mode",
                    "Stop all running sub-agents and return to normal Pi mode?\nPlan will be preserved on disk for later resume."
                );
                if (ok) {
                    exitOrchestration(pi, ctx);
                }
                return;
            }

            // --- Toggle ON ---
            const ok = await ctx.ui.confirm(
                "Enable orchestration mode",
                "You are about to enable Orchestration Mode.\nThis will switch the agent into planning mode with restricted tool access.\n\nNote: Entering planning mode will clear your current session context for a clean slate.\n\nContinue?"
            );
            if (!ok) return;

            // Check for existing incomplete plan
            const plan = StateManager.loadPlan();
            if (plan && plan.status !== "completed") {
                await handleResumeExistingPlan(plan, pi, ctx);
                return;
            }

            // No incomplete plan - check for a previous implementation-plan.md on disk.
            // This covers two scenarios:
            // 1. plan.json is "completed" (full cycle finished) + implementation-plan.md exists
            // 2. No plan.json at all + orphaned implementation-plan.md from a prior session
            //
            // IMPORTANT: load the impl plan BEFORE clearing anything, since clearPlan() deletes it.
            const existingImplPlan = StateManager.loadImplementationPlan();
            if (existingImplPlan && existingImplPlan.trim()) {
                await handleExistingImplPlan(existingImplPlan, plan, pi, ctx);
                return;
            }

            // Clean slate - no existing plans on disk
            await handleFreshStart(plan, pi, ctx);
        }
    });
}

function extractGoalFromMarkdown(content: string): string {
    const lines = content.split("\n");
    for (const line of lines) {
        const lower = line.toLowerCase();
        if (lower.startsWith("# goal:") || lower.startsWith("# project goal:")) {
            return line.substring(line.indexOf(":") + 1).trim();
        }
        if (lower.startsWith("# implementation plan for:")) {
            return line.substring(line.indexOf(":") + 1).trim();
        }
        if (lower.startsWith("# implementation plan:")) {
            return line.substring(line.indexOf(":") + 1).trim();
        }
        if (lower.startsWith("#") && line.trim().length > 2) {
            // Fallback: use the first main header as the goal
            return line.replace(/^#+\s*/, "").trim();
        }
    }
    return "Implement the approved plan"; // generic fallback
}

/**
 * Start orchestration execution from the approved plan.
 * Shared by /om-accept command and the Accept/Edit dialog overlay.
 */
export async function startExecutionFromPlan(pi: ExtensionAPI, ctx: ExtensionContext) {
    // Guard: implementation-plan.md must exist and have content.
    const implPlan = StateManager.loadImplementationPlan();
    if (!implPlan || !implPlan.trim()) {
        ctx.ui.notify(
            "Cannot start execution - the implementation plan is empty. Please create a plan with the agent first.",
            "error"
        );
        return;
    }

    // Reset summarizer state to prevent stale entries from previous plans within this session
    Runner.resetSummarizer();

    // Immediate feedback so the user knows their input was received
    ctx.ui.notify("Plan approved - starting orchestration execution…", "info");

    // Exit planning mode (restore pre-planning model if one was captured)
    await exitPlanningMode(pi, ctx);
    OrchestratorState.shouldResetContext = true;
    OrchestratorState._manualPause = false;
    OrchestratorState._pauseReason = null;
    // Clear planning hint flags — no longer in planning
    OrchestratorState._preWriteHintSent = false;

    setOrchestrationMode(OrchestratorState.isActive, true, false, pi, refreshBorder);

    // Inject the full implementation plan directly into the wake-up message so it
    // survives context pruning and avoids system-prompt per-message token limits.
    const planPayload =
        implPlan && implPlan.trim() ? `\n\n--- Approved Implementation Plan ---\n${implPlan}\n--- End of Plan ---` : "";

    const plan = StateManager.loadPlan();
    if (plan && plan.status !== "completed" && plan.tasks.length > 0) {
        const pendingTasks = plan.tasks.filter((t) => t.status === "pending");
        ctx.ui.notify(`Execution approved! ${pendingTasks.length} task(s) ready. Waking orchestrator.`, "info");
        pi.sendMessage(
            {
                customType: "orchestrator_event",
                content: `System: Execution approved - the approved implementation plan is provided below. Proceed with orchestration.${planPayload}`,
                display: false
            },
            { triggerTurn: true }
        );
    } else {
        // Pre-initialize the plan with status "planning" so the orchestrator
        // can call orchestrate_add_task. Status transitions to "executing"
        // when the first task is started via orchestrate_start_task.
        const goal = extractGoalFromMarkdown(implPlan);
        const newPlan = {
            goal,
            status: "planning" as const,
            tasks: []
        };
        StateManager.savePlan(newPlan);

        ctx.ui.notify("Execution approved! Waking orchestrator to create tasks and begin.", "info");
        pi.sendMessage(
            {
                customType: "orchestrator_event",
                content: `System: Execution approved - the approved implementation plan is provided below. Build tasks from it using orchestrate_add_task, then use orchestrate_start_task to begin execution.${planPayload}`,
                display: false
            },
            { triggerTurn: true }
        );
    }
}

/**
 * Show the Accept/Edit dialog overlay after a plan was written/edited.
 */
export async function showAcceptOrEditDialog(pi: ExtensionAPI, ctx: ExtensionContext) {
    const result = await ctx.ui.custom<{
        accepted?: boolean;
        cancelled?: boolean;
        feedback?: string;
    }>(
        (tui, theme, _keybindings, done) => {
            const dialog = new AcceptOrEditDialog((color, s) => theme.fg(color as Parameters<typeof theme.fg>[0], s));
            dialog.onDone = (result) => done(result);

            return {
                render(width: number): string[] {
                    const borderLine = new DynamicBorder((s) => theme.fg("accent", s)).render(width)[0] || "";
                    const content = dialog.render(width);
                    return [borderLine, ...content, borderLine];
                },
                invalidate(): void {
                    dialog.invalidate();
                },
                handleInput(data: string): void {
                    dialog.handleInput(data);
                    tui.requestRender();
                }
            };
        },
        {
            overlay: true,
            overlayOptions: { anchor: "bottom-left", margin: 0, width: "100%" },
            onHandle: (h) => h.focus()
        }
    );

    if (!result) return;

    if (result.accepted) {
        startExecutionFromPlan(pi, ctx);
    } else if (result.feedback && result.feedback.trim()) {
        /* Send user feedback back to the agent so it can refine the plan.
         * Prepended with PLANNING_HINT_EDIT for thoroughness guidance-in-the-moment.
         * display: false avoids the [undefined] source label since the user's input
         * is already visible in the Accept/Edit dialog itself. */
        pi.sendMessage(
            {
                content: `${PLANNING_HINT_EDIT}\n\n${result.feedback}`,
                customType: "user_feedback",
                display: false
            },
            { triggerTurn: true }
        );
    }
    // cancelled - just dismiss, user gets back to normal command line
}

/**
 * Register all orchestration commands (called at extension init so they appear in autocomplete).
 * Each handler guards with requireActive() so they only execute when mode is active.
 */
export function registerOrchestrationCommands(pi: ExtensionAPI) {
    pi.registerCommand("om-status", {
        description: "Show combined orchestration status + sub-agent activity overlay",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;
            await showOrchestratorStatus(ctx);
        }
    });

    pi.registerCommand("om-settings", {
        description: "Open orchestration settings (models, summarization concurrency)",
        handler: async (_args, ctx) => {
            await openSettingsMenu(ctx, pi);
        }
    });

    pi.registerCommand("om-plan", {
        description: "Toggle orchestration planning mode on/off",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;

            // --- Toggle OFF (exit planning mode) ---
            if (OrchestratorState.planningMode) {
                await exitPlanningMode(pi, ctx);
                setOrchestrationMode(
                    OrchestratorState.isActive,
                    OrchestratorState.isExecuting,
                    false,
                    pi,
                    refreshBorder
                );
                ctx.ui.notify("Planning mode exited. Implementation plan preserved on disk.", "info");
                return;
            }

            // --- Toggle ON (enter planning mode) ---
            // Guard: cannot enter planning while execution is active
            const plan = StateManager.loadPlan();
            if (OrchestratorState.isExecuting && plan && ["executing", "paused", "pausing"].includes(plan.status)) {
                ctx.ui.notify(
                    "Cannot enter planning mode while orchestration is running.\nUse /om-pause or /om-stop first.",
                    "warning"
                );
                return;
            }

            // Check for existing plan on disk
            const existingPlan = StateManager.loadPlan();
            if (existingPlan) {
                const choice = await ctx.ui.confirm(
                    "Resume editing existing plan?",
                    `Found existing plan: "${existingPlan.goal}" (${existingPlan.status}).\n\nSelect Yes to continue editing, or No to discard and start fresh.`
                );

                if (!choice) {
                    // Discard - clear everything and start fresh
                    StateManager.clearPlan();
                }
            }

            setOrchestrationMode(OrchestratorState.isActive, false, true, pi, refreshBorder);
            OrchestratorState.shouldResetContext = true;
            // Reset planning hint one-shot flags
            OrchestratorState._preWriteHintSent = false;
            await enterPlanningMode(pi, ctx);
            ctx.ui.notify(
                "Planning mode enabled with a clean context. Discuss your goal with the orchestrator to build an implementation plan.",
                "info"
            );
            // Wake up the planner so it's in its proper conversational state
            // (waiting for user input) rather than sitting idle after context reset.
            pi.sendMessage(
                {
                    customType: "orchestrator_event",
                    content:
                        "System: Planning mode is active with a clean context. " +
                        "Wait for the user to provide their goal or requirements, then explore and build an implementation plan.",
                    display: false
                },
                { triggerTurn: true }
            );
        }
    });

    pi.registerCommand("om-pause", {
        description: "Gracefully pause orchestration (lets current task finish)",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;
            OrchestratorState._manualPause = true;
            OrchestratorState._pauseReason = "pause";
            const plan = StateManager.loadPlan();
            if (plan && plan.status === "executing") {
                // Graceful pause: set status to 'pausing' so the Runner finishes
                // the current task before stopping. No processes are killed.
                plan.status = "pausing";
                StateManager.savePlan(plan);
                ctx.ui.notify(
                    "Orchestration pausing gracefully - current task will finish, then execution stops.",
                    "warning"
                );
                // Notify the orchestrator LLM so it knows a pause was requested
                pi.sendMessage(
                    {
                        customType: "orchestrator_event",
                        content:
                            "System: User requested graceful pause. Execution will stop after the current task completes.",
                        display: false
                    },
                    { deliverAs: "nextTurn" }
                );
            } else {
                ctx.ui.notify("Nothing to pause. Orchestration is not actively executing.", "info");
            }
        }
    });

    pi.registerCommand("om-resume", {
        description: "Resume orchestration from the last known state (after crash or pause)",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;
            const plan = StateManager.loadPlan();
            if (!plan) {
                ctx.ui.notify("No orchestration plan found. Describe a goal or plan with the agent.", "warning");
                return;
            }
            OrchestratorState._manualPause = false;
            OrchestratorState._pauseReason = null;

            if (plan.status === "completed") {
                ctx.ui.notify(
                    `Plan already completed. Goal: "${plan.goal}". Use /om-reset to clear and start fresh.`,
                    "info"
                );
                return;
            }

            // Recover interrupted tasks
            const recovered = recoverInterruptedTasks(plan);
            if (recovered > 0) {
                StateManager.savePlan(plan);
            }

            await exitPlanningMode(pi, ctx);
            setOrchestrationMode(OrchestratorState.isActive, true, false, pi, refreshBorder);

            ctx.ui.notify(
                recovered > 0
                    ? `Resuming: "${plan.goal}" (${recovered} interrupted task(s) recovered).`
                    : `Resuming: "${plan.goal}".`,
                "info"
            );

            resumePlanExecution(plan, pi);
        }
    });

    pi.registerCommand("om-stop", {
        description: "Immediately stop all running sub-agents and mark plan as paused (can be resumed later)",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;
            OrchestratorState._manualPause = true;
            OrchestratorState._pauseReason = "stop";
            const plan = StateManager.loadPlan();
            if (!plan) {
                ctx.ui.notify("No active orchestration plan.", "warning");
                return;
            }

            // Kill running processes immediately
            killAllProcesses("SIGKILL");

            // Mark plan as paused (preserves all state for later resume)
            plan.status = "paused";
            StateManager.savePlan(plan);

            ctx.ui.notify("Orchestration stopped. Plan preserved - use /om-resume to continue.", "warning");
        }
    });

    pi.registerCommand("om-reset", {
        description: "Clear current orchestration plan and state",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;
            const ok = await ctx.ui.confirm("Reset", "Are you sure you want to clear the orchestration plan?");
            if (ok) {
                killAllProcesses("SIGKILL");

                StateManager.clearPlan();
                await exitPlanningMode(pi, ctx);
                OrchestratorState._manualPause = false;
                OrchestratorState._pauseReason = null;
                setOrchestrationMode(OrchestratorState.isActive, false, false, pi, refreshBorder);
                ctx.ui.notify("Orchestration plan cleared. Describe a new goal to start planning.", "info");
            }
        }
    });
}
