import * as fs from "node:fs";
import { truncateToWidth } from "@earendil-works/pi-tui";
import * as capture from "./capture";
import { tryParseSubAgentEvent } from "../core/types";

// ---------------------------------------------------------------------------
// Sub-agent monitor: captures JSON events and builds a progressive chat-like
// transcript — assistant text, tool calls with results inline.
// Looks like a read-only view of the sub-agent's own session.
// ---------------------------------------------------------------------------

/** A single entry in the transcript. */
export type Entry =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string }
    | { kind: "tool_call"; tool: string; summary: string }
    | { kind: "tool_result"; success: boolean; result: string };

let activeTaskId: string | null = null;
const tasks = new Map<
    string,
    {
        entries: Entry[];
        captureAccessor: (() => string[]) | null;
        label: string | null;
        logFile?: string;
    }
>();

/** Maximum number of transcript entries kept in memory. */
const MAX_ENTRIES = 500;
/** Poll interval (ms) for smooth overlay updates. */
export const MONITOR_POLL_INTERVAL_MS = 300;

function getTaskState(taskId: string) {
    if (!tasks.has(taskId)) {
        tasks.set(taskId, { entries: [], captureAccessor: null, label: null });
    }
    return tasks.get(taskId)!;
}

/** Reset all monitor state (called on session shutdown). */
export function resetMonitorState(): void {
    tasks.clear();
    activeTaskId = null;
    refreshListeners.clear();
}

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
function pushEntry(state: ReturnType<typeof getTaskState>, entry: Entry): void {
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) {
        state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    }
    notifyRefresh();
}

// ---------------------------------------------------------------------------
// Public API — called by runner.ts during sub-agent execution
// ---------------------------------------------------------------------------

/**
 * Register a task's state with the monitor.
 * @param taskId - Unique identifier for the running task.
 * @param label - Human-readable label (e.g., `sub-agent task_01`).
 * @param captureAccessor - Optional accessor to raw output lines for diagnostics.
 */
export function setCurrentTask(taskId: string, label: string | null, captureAccessor?: () => string[]): void {
    const state = getTaskState(taskId);
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
    getTaskState(taskId).logFile = logFile;
}

/**
 * Return the log file path for a task (if one was recorded).
 */
function getTaskLogFile(taskId: string): string | undefined {
    const state = tasks.get(taskId);
    return state?.logFile;
}

/** Clear the active task ID. */
export function clearActiveTask(): void {
    activeTaskId = null;
    notifyRefresh();
}

/** Clear all transcript entries for a specific task. */
export function clearEvents(taskId: string): void {
    getTaskState(taskId).entries = [];
}

/**
 * Ingest a single JSON line from `pi --mode json` stdout for a specific task.
 * Parses the event, updates the per-task transcript, and triggers UI refresh.
 */
export function ingestLine(taskId: string, rawLine: string): void {
    const ev = tryParseSubAgentEvent(rawLine);
    if (!ev) return;

    const state = getTaskState(taskId);
    activeTaskId = taskId; // Auto-switch view to the most recently active task

    switch (ev.type) {
        case "message_end": {
            const role = String(ev.message?.role ?? "");
            if (!["user", "assistant"].includes(role)) break;
            pushEntry(state, { kind: role as "user" | "assistant", text: capture.extractText(ev.message!) });
            break;
        }

        // Streaming tool events — don't create transcript entries (we display model-
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

/**
 * Return captured sub-agent output as truncated plain text for failure diagnostics.
 * Reads from the process-manager's capture buffer (the single source of truth),
 * set via setCurrentTask(). Returns empty string if no accessor is registered.
 */
export function getCapturedLines(taskId: string): string {
    const state = tasks.get(taskId);
    if (!state || !state.captureAccessor) return "";
    return capture.truncateCapturedOutput(state.captureAccessor());
}

/**
 * Return the extracted transcript for a task.
 * The permanent log file (under agent-logs/) already contains formatted plain-text
 * — no extraction needed. Falls back to in-memory captured lines if not yet written.
 */
export function getFullTranscript(taskId: string): string {
    const logFile = getTaskLogFile(taskId);
    if (logFile) {
        try {
            // Already extracted plain-text — read directly.
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
// Public transcript accessors — used by ui.ts for the combined overlay
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
    const state = tasks.get(activeTaskId);
    if (!state) return null;
    return {
        taskId: activeTaskId,
        label: state.label,
        entries: [...state.entries] // shallow copy for safety
    };
}

// ---------------------------------------------------------------------------
// Transcript renderer — builds ANSI-styled lines from entries (used by ui.ts)
// ---------------------------------------------------------------------------

export type ThemeLike = { fg: (color: string | symbol, text: string) => string };

/** Truncate multi-line text to a max number of lines. */
function truncateToLines(text: string, maxLines: number): string {
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join("\n") + "\n…";
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
                const prefix = theme.fg("muted", "→ ");
                const toolLabel = theme.fg("accent", entry.tool);
                const summary = entry.summary ? ` ${entry.summary}` : "";
                lines.push(truncateToWidth(prefix + toolLabel + summary, width));
                break;
            }

            case "tool_result": {
                if (!entry.result) {
                    // No result text — just show status indicator on same visual line as preceding tool_call
                    const indicator = entry.success ? theme.fg("success", " ✓") : theme.fg("error", " ✗");
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
        // Check approximate display width — split at spaces
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
