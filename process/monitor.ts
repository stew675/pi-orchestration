import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";
import * as capture from "./capture";
import { tryParseSubAgentEvent } from "../core/types";

// ---------------------------------------------------------------------------
// Sub-agent monitor: captures JSON events and builds a progressive chat-like
// transcript - assistant text, tool calls with results inline.
// Looks like a read-only view of the sub-agent's own session.
//
// Unified agent tracking: all sub-agents (task/validator/summary) are registered
// under tagged IDs. The monitor owns lifecycle — auto-cleanup on process close.
// ---------------------------------------------------------------------------

/** Watchdog kill reason set when idle or max-turns threshold is exceeded. */
export type KillReason = "idle_timeout" | "max_turns";

/** Per-agent tracking state managed by the monitoring system. */
export interface MonitoredAgent {
    entries: Entry[];
    captureAccessor: (() => string[]) | null;
    label: string | null;
    logFile?: string;
    /** Child process reference — set via registerAgent(), cleared on close. */
    childProcess: ChildProcess | null;
    /** Timestamp (ms) of last JSON event received; updated in ingestLine(). */
    lastActivityAt: number | null;
    /** Count of assistant message_end events seen so far. */
    turnCount: number;
    /** Set by the watchdog when it kills this agent for exceeding a threshold. */
    killedByWatchdog: KillReason | null;
}

/** Tagged IDs: "implementation-<taskId>", "validator-<taskId>", "summarization-<taskId>". */
type AgentId = string;
const agents = new Map<AgentId, MonitoredAgent>();

function getOrCreateAgent(id: AgentId): MonitoredAgent {
    if (!agents.has(id)) {
        agents.set(id, {
            entries: [],
            captureAccessor: null,
            label: null,
            childProcess: null,
            lastActivityAt: null,
            turnCount: 0,
            killedByWatchdog: null
        });
    }
    return agents.get(id)!;
}

/** A single entry in the transcript. */
export type Entry =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string }
    | { kind: "tool_call"; tool: string; summary: string }
    | { kind: "tool_result"; success: boolean; result: string };

/** Maximum number of transcript entries kept in memory. */
const MAX_ENTRIES = 500;
/** Poll interval (ms) for smooth overlay updates. */
export const MONITOR_POLL_INTERVAL_MS = 300;

let activeTaskId: string | null = null;

type RefreshFn = () => void;
const refreshListeners = new Set<RefreshFn>();

export function onMonitorChange(fn: RefreshFn): () => void {
    refreshListeners.add(fn);
    return () => refreshListeners.delete(fn);
}

function notifyRefresh() {
    for (const fn of refreshListeners) fn();
}

/** Push an entry to a task's transcript, trim to MAX_ENTRIES, and notify listeners. */
function pushEntry(agentState: MonitoredAgent, entry: Entry): void {
    agentState.entries.push(entry);
    if (agentState.entries.length > MAX_ENTRIES) {
        agentState.entries.splice(0, agentState.entries.length - MAX_ENTRIES);
    }
    notifyRefresh();
}

/** Reset TUI listener subscriptions and active-task pointer (called on session shutdown).
 * Per-agent state is managed via auto-cleanup in registerAgent() — no manual teardown needed. */
export function resetMonitorState(): void {
    refreshListeners.clear();
    activeTaskId = null;
}

// ---------------------------------------------------------------------------
// Public API — unified agent registration / transcript access
// ---------------------------------------------------------------------------

/**
 * Register a sub-agent with the monitoring system.
 *
 * Accepts tagged IDs: "implementation-<taskId>", "validator-<taskId>",
 * "summarization-<taskId>". Wires auto-cleanup on process close so callers
 * never need to unregister manually.
 *
 * @param id - Tagged agent identifier.
 * @param child - ChildProcess reference (for watchdog kill access).
 */
export function registerAgent(id: AgentId, child: ChildProcess): void {
    const state = getOrCreateAgent(id);
    state.childProcess = child;

    // Auto-cleanup on process close — removes the entry from tracking.
    child.on("close", () => {
        agents.delete(id);
    });
}

/**
 * Register a task's transcript state with the monitor (legacy API).
 *
 * @param taskId - Unique identifier for the running task.
 * @param label - Human-readable label (e.g., `sub-agent task_01`).
 * @param captureAccessor - Optional accessor to raw output lines for diagnostics.
 */
export function setCurrentTask(taskId: string, label: string | null, captureAccessor?: () => string[]): void {
    const state = getOrCreateAgent(taskId);
    state.label = label;
    if (captureAccessor !== undefined) {
        state.captureAccessor = captureAccessor || null;
    }
    activeTaskId = taskId;
}

/**
 * Store the log file path for a task so downstream code can reference it.
 */
export function setTaskLogFile(taskId: string, logFile: string): void {
    getOrCreateAgent(taskId).logFile = logFile;
}

/**
 * Return the log file path for a task (if one was recorded).
 */
function getTaskLogFile(taskId: string): string | undefined {
    return agents.get(taskId)?.logFile;
}

/** Clear the active task ID. */
export function clearActiveTask(): void {
    activeTaskId = null;
    notifyRefresh();
}

/** Clear all transcript entries for a specific task. */
export function clearEvents(taskId: string): void {
    getOrCreateAgent(taskId).entries = [];
}

// ---------------------------------------------------------------------------
// JSON stream ingestion — tracks activity timestamps and turn counts
// ---------------------------------------------------------------------------

/**
 * Ingest a single JSON line from `pi --mode json` stdout for a specific agent.
 * Parses the event, updates per-agent transcript + tracking counters, and
 * triggers UI refresh.
 *
 * @param taskId - Tagged agent identifier (e.g., "implementation-task_01").
 * @param rawLine - Raw JSON line to parse.
 * @param options - Optional configuration. Set `skipActive: true` to prevent
 *   updating the active task view (e.g., for validators/summarizers that should
 *   not appear in /om-status).
 */
export function ingestLine(
    taskId: string,
    rawLine: string,
    options?: { skipActive?: boolean }
): void {
    const ev = tryParseSubAgentEvent(rawLine);
    if (!ev) return;

    const state = getOrCreateAgent(taskId);

    // Update last-activity timestamp on every parsed event.
    state.lastActivityAt = Date.now();

    if (!options?.skipActive) {
        activeTaskId = taskId; // Auto-switch view to the most recently active task
    }

    switch (ev.type) {
        case "message_end": {
            const role = String(ev.message?.role ?? "");
            if (!["user", "assistant"].includes(role)) break;
            pushEntry(state, { kind: role as "user" | "assistant", text: capture.extractText(ev.message!) });

            // Count assistant turns for max-turns enforcement.
            if (role === "assistant") {
                state.turnCount++;
            }
            break;
        }

        // Streaming tool events - don't create transcript entries (we display model-
        // only output via message_end), but trigger a UI refresh so the overlay stays
        // responsive while tools are executing.
        case "tool_call":
        case "tool_execution_start":
        case "tool_result":
        case "tool_execution_end": {
            notifyRefresh();
            break;
        }

        case "error": {
            const msg = typeof ev.message === "string" ? (ev.message as string) : JSON.stringify(ev);
            pushEntry(state, { kind: "assistant", text: `⚠ ${msg.slice(0, capture.MAX_DIAGNOSTIC_MESSAGE_LEN)}` });
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Watchdog accessors — read-only view of agent tracking state
// ---------------------------------------------------------------------------

/** Return a snapshot of all registered agents (read-only). */
export function getAgentStates(): ReadonlyMap<string, MonitoredAgent> {
    return new Map(agents);
}

/** Look up the monitoring state for a specific agent ID. Returns null if not found. */
export function getMonitoredAgent(id: string): Readonly<MonitoredAgent> | null {
    const s = agents.get(id);
    return s ? s : null;
}

// ---------------------------------------------------------------------------
// Public transcript accessors — used by executor, validator, summarizer
// ---------------------------------------------------------------------------

/**
 * Return captured sub-agent output as truncated plain text for failure diagnostics.
 * Reads from the process-manager's capture buffer (the single source of truth),
 * set via setCurrentTask(). Returns empty string if no accessor is registered.
 */
export function getCapturedLines(taskId: string): string {
    const state = agents.get(taskId);
    if (!state || !state.captureAccessor) return "";
    return capture.truncateCapturedOutput(state.captureAccessor());
}

/**
 * Return the extracted transcript for a task.
 * The permanent log file (under agent-logs/) already contains formatted plain-text
 * - no extraction needed. Falls back to in-memory captured lines if not yet written.
 */
export function getFullTranscript(taskId: string): string {
    const logFile = getTaskLogFile(taskId);
    if (logFile) {
        try {
            // Already extracted plain-text - read directly.
            return fs.readFileSync(logFile, "utf-8");
        } catch {
            // File not yet written (process still closing or temp cleanup race).
            // Fall through to in-memory buffer.
        }
    }
    // Fallback: in-memory capture buffer (may be truncated)
    return getCapturedLines(taskId);
}

// ---------------------------------------------------------------------------
// Public transcript accessors - used by ui.ts for the combined overlay
// ---------------------------------------------------------------------------

/** Snapshot of the currently active task's transcript data. */
export interface ActiveTaskInfo {
    taskId: string;
    label: string | null;
    entries: Entry[];
}

/** Return the active task's transcript data (or null if no sub-agent running). */
export function getActiveTaskInfo(): ActiveTaskInfo | null {
    if (!activeTaskId) return null;
    const state = agents.get(activeTaskId);
    if (!state) return null;
    return {
        taskId: activeTaskId,
        label: state.label,
        entries: [...state.entries] // shallow copy for safety
    };
}

// ---------------------------------------------------------------------------
// Transcript renderer - builds ANSI-styled lines from entries (used by ui.ts)
// ---------------------------------------------------------------------------

export type ThemeLike = { fg: (color: string | symbol, text: string) => string };

/** Truncate multi-line text to a max number of lines. */
function truncateToLines(text: string, maxLines: number): string {
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join("\n") + "\n\u2026";
}

/** Render the transcript to an array of display lines. */
export function renderTranscript(entries: Entry[], theme: ThemeLike, width: number): string[] {
    const lines: string[] = [];

    for (const entry of entries) {
        switch (entry.kind) {
            case "user": {
                if (!entry.text) break;
                if (lines.length && lines[lines.length - 1] !== "") lines.push("");
                for (const line of wrapLines(entry.text, width)) {
                    lines.push(theme.fg("text", truncateToWidth(line, width)));
                }
                break;
            }

            case "assistant": {
                if (!entry.text) break;
                if (lines.length && lines[lines.length - 1] !== "") lines.push("");
                for (const line of wrapLines(entry.text, width)) {
                    lines.push(truncateToWidth(line, width));
                }
                break;
            }

            case "tool_call": {
                const prefix = theme.fg("muted", "\u2192 ");
                const toolLabel = theme.fg("accent", entry.tool);
                const summary = entry.summary ? ` ${entry.summary}` : "";
                lines.push(truncateToWidth(prefix + toolLabel + summary, width));
                break;
            }

            case "tool_result": {
                if (!entry.result) {
                    // No result text - just show status indicator on same visual line as preceding tool_call
                    const indicator = entry.success ? theme.fg("success", " \u2713") : theme.fg("error", " \u2717");
                    if (lines.length) lines[lines.length - 1] += indicator;
                    break;
                }

                // Truncate long results to keep the display manageable
                const truncated = truncateToLines(entry.result, entry.success ? 8 : 5);
                for (const line of wrapLines(truncated, width)) {
                    const color = entry.success ? "dim" : "error";
                    lines.push(theme.fg(color, truncateToWidth("  " + line, width)));
                }
                break;
            }
        }
    }

    return lines;
}

/** Simple word-wrap: split on newlines then wrap long lines at spaces. */
function wrapLines(text: string, maxWidth: number): string[] {
    const output: string[] = [];
    for (const rawLine of text.split("\n")) {
        if (!rawLine) {
            output.push("");
            continue;
        }
        // Check approximate display width - split at spaces
        let current = "";
        for (const word of rawLine.split(/(\s+)/)) {
            const test = current + word;
            if (test.length > maxWidth && current) {
                output.push(current.trimEnd());
                current = word;
            } else {
                current = test;
            }
        }
        if (current.trim()) output.push(current.trimEnd());
    }
    return output;
}
