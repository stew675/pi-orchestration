// ---------------------------------------------------------------------------
// Shared formatting for captured sub-agent output lines.
// Used by failure diagnostics (runner.ts) to produce readable summaries of
// what the sub-agent was doing before it failed.
// ---------------------------------------------------------------------------

import { tryParseSubAgentEvent, SubAgentEvent, getEventToolName, getEventParams } from "../core/types";

export const MAX_DIAGNOSTIC_MESSAGE_LEN = 400;
export const MAX_TOOL_RESULT_LEN = 320;
const MAX_BASH_CMD_LEN = 160;
const MAX_PARAMS_PREVIEW_LEN = 240;

/** Default maximum lines for truncated captured output display. */
const DEFAULT_MAX_CAPTURED_LINES = 200;
/** Number of head/tail lines to keep when truncating captured output. */
const CAPTURED_OUTPUT_HEAD_LINES = 100;
const CAPTURED_OUTPUT_TAIL_LINES = 100;

/** Parse a raw JSON event line into a single-line plain-text summary.
 *
 * Handles both legacy event types (tool_call / tool_result) and the newer
 * streaming format (tool_execution_start / tool_execution_end).
 */
export function formatLine(raw: string): string | null {
    const ev = tryParseSubAgentEvent(raw);
    if (!ev) return null;

    switch (ev.type) {
        case "message_end": {
            const role = String(ev.message?.role ?? "");
            if (!["user", "assistant"].includes(role)) return null;
            const text = extractText(ev.message);
            // For assistant messages, also check toolCall parts
            const toolCalls = extractToolCalls(ev.message);
            if (!text && toolCalls.length === 0) return null;

            let line = "";
            if (role === "user") {
                line = `[prompt] ${truncateText(text, MAX_DIAGNOSTIC_MESSAGE_LEN)}`;
            } else {
                // Assistant message - include text and tool call hints
                const parts: string[] = [];
                if (text) parts.push(truncateText(text, MAX_DIAGNOSTIC_MESSAGE_LEN));
                if (toolCalls.length > 0) {
                    parts.push(`→ called ${toolCalls.join(", ")}`);
                }
                line = parts.join(" | ");
            }
            return line;
        }

        case "tool_call":
        case "tool_execution_start": {
            const toolName = getEventToolName(ev);
            const summary = summarizeToolCall(toolName, getEventParams(ev));
            if (summary) return `→ ${toolName} ${summary}`;
            return `→ ${toolName}`;
        }

        case "tool_result":
        case "tool_execution_end": {
            const toolName = getEventToolName(ev);
            const { success, text } = parseToolResult(ev);
            const indicator = success ? "✓" : "✗";
            // Truncate long results to a single readable line.
            const truncated = truncateText(text, MAX_TOOL_RESULT_LEN);
            return `  [${indicator}] ${toolName}: ${truncated}`;
        }

        case "error": {
            const msg = typeof ev.message === "string" ? ev.message : JSON.stringify(ev);
            return `⚠ ${msg.slice(0, MAX_DIAGNOSTIC_MESSAGE_LEN)}`;
        }

        default:
            return null;
    }
}

/** Extract tool call names from an assistant message's content parts.
 * @public - shared utility used by both capture formatting and sub-agent spawner. */
export function extractToolCalls(message: unknown): string[] {
    if (!message || typeof message !== "object") return [];
    const content = (message as any).content;
    if (!Array.isArray(content)) return [];

    const names: string[] = [];
    for (const part of content) {
        if (part?.type === "toolCall" && typeof part.toolName === "string") {
            names.push(part.toolName);
        }
    }
    return names;
}

/** Truncate text with ellipsis. */
export function truncateText(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen - 3) + "…" : text;
}

/**
 * Extract plain text from a sub-agent message content block.
 * Handles both structured parts arrays and raw strings.
 */
export function extractText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const content = (message as any).content;
    if (Array.isArray(content)) {
        let text = "";
        for (const part of content) {
            if (part?.type === "text" && typeof part.text === "string") text += part.text;
            else if (typeof part === "string") text += part;
        }
        return text.trim();
    }
    if (typeof content === "string") return content.trim();
    return "";
}

/**
 * Produce a short one-line summary of a tool call for diagnostic display.
 */
export function summarizeToolCall(tool: string, params: Record<string, unknown>): string {
    switch (tool) {
        case "read":
            return typeof params.path === "string" ? params.path : "";
        case "write":
            return typeof params.path === "string" ? `→ ${params.path}` : "";
        case "edit":
            if (typeof params.path === "string") {
                const editCount = (params.edits as any[])?.length ?? 0;
                return `${params.path} (${editCount} edit(s))`;
            }
            break;
        case "bash":
            if (typeof params.command === "string") {
                const c = params.command;
                return c.length > MAX_BASH_CMD_LEN ? c.slice(0, MAX_BASH_CMD_LEN - 3) + "…" : c;
            }
            break;
        case "grep":
            if (typeof params.pattern === "string") {
                let s = `"${params.pattern}"`;
                if (typeof params.path === "string") s += ` in ${params.path}`;
                return s;
            }
            break;
        case "find":
            if (typeof params.pattern === "string") return `"${params.pattern}"`;
            break;
        case "ls":
            if (typeof params.path === "string" && params.path !== ".") return params.path;
            break;
    }
    // Fallback: show first few keys
    const keys = Object.keys(params);
    if (keys.length > 0) {
        const s = JSON.stringify(params);
        return s.length > MAX_PARAMS_PREVIEW_LEN ? s.slice(0, MAX_PARAMS_PREVIEW_LEN - 3) + "…" : s;
    }
    return "";
}

/**
 * Extract success status and text content from a tool_result or
 * tool_execution_end event.
 */
export function parseToolResult(ev: SubAgentEvent): { success: boolean; text: string } {
    const success = (ev as any).isError !== true && ev.success !== false;
    let text = "";

    // Direct string result (legacy format)
    if (typeof ev.result === "string") {
        text = ev.result.trim();
    }
    // Structured result with content array (newer streaming format)
    else if (ev.result && typeof ev.result === "object") {
        const r = ev.result as Record<string, unknown>;

        // Check for content array first (tool_execution_end format)
        if (Array.isArray(r.content)) {
            for (const part of r.content) {
                if (part?.type === "text" && typeof part.text === "string") {
                    text = part.text.trim();
                    break;
                }
            }
        }

        // Fallback: direct keys on result object
        if (!text) {
            for (const key of ["text", "output"]) {
                if (typeof r[key] === "string" && r[key]) {
                    text = String(r[key]).trim();
                    break;
                }
            }
        }
    }

    // Error messages
    if (!success && !text) {
        text = typeof ev.error === "string" ? ev.error : String(ev.error);
    }

    return { success, text };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format an array of raw JSON event lines into readable plain-text output.
 * Only includes lines that could be parsed and mapped to a summary.
 */
export function formatCapturedLines(rawLines: string[]): string[] {
    const formatted: string[] = [];
    for (const line of rawLines) {
        const formattedLine = formatLine(line);
        if (formattedLine !== null) {
            formatted.push(formattedLine);
        }
    }
    return formatted;
}

/**
 * Truncate an array of output lines to at most `maxLines`.
 * If within limit, joins all lines. Otherwise keeps first `headLines`,
 * a truncation marker, and last `tailLines`.
 */
export function truncateCapturedOutput(
    lines: string[],
    maxLines = DEFAULT_MAX_CAPTURED_LINES,
    headLines = CAPTURED_OUTPUT_HEAD_LINES,
    tailLines = CAPTURED_OUTPUT_TAIL_LINES
): string {
    if (lines.length === 0) return "";

    const header = `--- Captured sub-agent output (${lines.length} lines) ---`;

    if (lines.length <= maxLines) {
        return [header, ...lines].join("\n");
    }

    const truncatedCount = lines.length - headLines - tailLines;
    return [
        header,
        ...lines.slice(0, headLines),
        `... [${truncatedCount} middle lines truncated] ...`,
        ...lines.slice(-tailLines)
    ].join("\n");
}
