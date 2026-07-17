import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as capture from "./capture";
import { tryParseSubAgentEvent, getEventToolName, getEventParams } from "../core/types";

/** Maximum number of raw output lines kept per process for diagnostics. */
const MAX_CAPTURED_LINES = 2000;
/** Grace period (ms) between SIGTERM and SIGKILL when killing a timed-out sub-agent. */
const SIGKILL_GRACE_MS = 5000;

/** Tracks all active child processes for shutdown cleanup. */
export const activeProcesses = new Map<ChildProcess, { label: string }>();

/** Options passed to spawnAgent. */
export interface SpawnOptions {
    cwd?: string;
    timeoutMs?: number;
    label?: string;
    /** Task ID used for permanent log path in agent-logs/. Extracted transcript is accumulated in memory and written once on process close. */
    taskId?: string;
}

/** Kill all tracked child processes with the given signal (default SIGKILL). Used during shutdown. */
export function killAllProcesses(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
    for (const child of activeProcesses.keys()) {
        try {
            child.kill(signal);
        } catch (err) {
            const childInfo = activeProcesses.get(child);
            console.warn(
                `Failed to kill process '${childInfo?.label ?? "unknown"}': ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }
    activeProcesses.clear();
}

/** Resolve the `pi` binary path for spawning sub-agents. */
function resolvePiBinary(): string {
    return "pi";
}

/** Callback invoked for each complete stdout line (already trimmed). */
export type StdoutHandler = (line: string) => void;

/** Captured output accessor returned by spawnAgent. */
type CaptureAccessor = () => string[];

export interface SpawnResult {
    child: ChildProcess;
    /** Explicitly cancel the watchdog timer before process exits. */
    clearTimeout: () => void;
    /** Captured output as formatted plain-text lines (populated during execution). */
    capturedLines: CaptureAccessor;
    /** Captured raw stderr lines for diagnostics in case of failures. */
    getStderrDiagnostics: () => string;
}

/**
 * Spawn a `pi` sub-agent with standardized lifecycle management:
 * - stdout line buffering + callback dispatch
 * - stderr passthrough to console
 * - configurable timeout → SIGTERM → 5s grace → SIGKILL
 * - automatic tracking in activeProcesses (removed on close/error)
 * - internal capture buffer for failure diagnostics and /om-status
 *
 * Logging: extracted plain-text lines are accumulated in memory, then written
 * once to `.pi/orchestration/agent-logs/{taskId}.log` when the process exits.
 */
export function spawnAgent(args: string[], options: SpawnOptions, onStdoutLine?: StdoutHandler): SpawnResult {
    const piBinary = resolvePiBinary();
    const { cwd = process.cwd(), timeoutMs, label = "agent", taskId } = options;

    // In-memory buffers.
    const capturedRaw: string[] = []; // raw JSON for failure diagnostics (capped)
    const extractedLines: string[] = []; // formatted plain-text → written on close

    const child = spawn(piBinary, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG ?? "en_US.UTF-8",
            PI_ORCHESTRATION_SUB_AGENT: "true",
            ...(process.env.HTTP_PROXY && { HTTP_PROXY: process.env.HTTP_PROXY }),
            ...(process.env.HTTPS_PROXY && { HTTPS_PROXY: process.env.HTTPS_PROXY }),
            ...(process.env.NO_PROXY && { NO_PROXY: process.env.NO_PROXY }),
            ...(process.env.NODE_ENV && { NODE_ENV: process.env.NODE_ENV })
        }
    });

    activeProcesses.set(child, { label });

    const cleanup = () => activeProcesses.delete(child);
    child.on("close", cleanup);

    const rawStderrLines: string[] = [];
    child.stderr.on("data", (data) => {
        const str = data.toString();
        console.error(`[${label}] ${str.trim()}`);

        const lines = str.split("\n");
        for (const line of lines) {
            if (line.trim()) {
                rawStderrLines.push(line.trim());
                if (rawStderrLines.length > 50) {
                    rawStderrLines.shift();
                }
            }
        }
    });

    let buffer = "";
    const processLine = (line: string): void => {
        if (!line.trim()) return;

        // In-memory capture (capped for diagnostics)
        capturedRaw.push(line);
        if (capturedRaw.length > MAX_CAPTURED_LINES) {
            capturedRaw.shift();
        }

        // Feed through streaming extractor - accumulate formatted output in memory.
        const extractedLine = formatAndExtract(line);
        if (extractedLine !== null) {
            extractedLines.push(extractedLine);
        }

        onStdoutLine?.(line);
    };

    child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            processLine(line);
        }
    });

    // Shared helper: flush the extracted transcript buffer to a permanent log file.
    const flushExtractedBuffer = () => {
        if (!taskId || extractedLines.length === 0) return;
        try {
            const { CONFIG_DIR_NAME } = require("@earendil-works/pi-coding-agent");
            const logDir = path.join(process.cwd(), CONFIG_DIR_NAME, "orchestration", "agent-logs");
            fs.mkdirSync(logDir, { recursive: true });

            const content = `--- Sub-agent session transcript (${extractedLines.length} events) ---\n${extractedLines.join("\n")}`;
            const permanentPath = path.join(logDir, `${taskId}.log`);
            fs.writeFileSync(permanentPath, content, "utf-8");
        } catch (e) {
            console.warn(`Failed to write log for ${taskId}:`, e);
        }
    };

    child.on("close", () => {
        if (buffer.trim()) {
            processLine(buffer.trim());
        }
        flushExtractedBuffer();
    });

    // Flush diagnostic buffer on spawn failure so data isn't lost before cleanup.
    child.on("error", () => {
        if (buffer.trim()) processLine(buffer.trim());
        flushExtractedBuffer();
        cleanup();
    });

    // Watchdog timer - tracks both the initial timeout and the 5s SIGKILL grace
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let graceId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
        timeoutId = setTimeout(() => {
            if (!child.killed) {
                console.warn(`[${label}] Timeout after ${timeoutMs}ms, killing process`);
                child.kill("SIGTERM");
                graceId = setTimeout(() => {
                    if (!child.killed) {
                        try {
                            child.kill("SIGKILL");
                        } catch {
                            /* process already dead */
                        }
                    }
                }, SIGKILL_GRACE_MS);
            }
        }, timeoutMs);
    }

    return {
        child,
        clearTimeout: () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (graceId) clearTimeout(graceId);
        },
        capturedLines: () => capture.formatCapturedLines(capturedRaw),
        getStderrDiagnostics: () => rawStderrLines.join("\n")
    };
}

/** Format a single raw line into extracted plain-text, or null if skipped.
 *
 * Reuses the same extraction logic as capture.ts (extractText, summarizeToolCall,
 * parseToolResult) so there is only one implementation of these formatters. The
 * wrapper here adds a skip for streaming deltas and delegates to the shared functions.
 */
function formatAndExtract(rawLine: string): string | null {
    const ev = tryParseSubAgentEvent(rawLine);
    if (!ev) return null;
    if (ev.type === "message_update") return null; // skip streaming deltas

    switch (ev.type) {
        case "message_end": {
            const role = String(ev.message?.role ?? "");
            if (!["user", "assistant"].includes(role)) return null;
            const text = capture.extractText(ev.message);
            // extractToolCalls is private in capture.ts - inline the small helper here
            const toolCalls = extractToolCallNames(ev.message);
            if (!text && toolCalls.length === 0) return null;

            let line = "";
            if (role === "user") {
                line = `[prompt] ${capture.truncateText(text, capture.MAX_DIAGNOSTIC_MESSAGE_LEN)}`;
            } else {
                const parts: string[] = [];
                if (text) parts.push(capture.truncateText(text, capture.MAX_DIAGNOSTIC_MESSAGE_LEN));
                if (toolCalls.length > 0) parts.push(`→ called ${toolCalls.join(", ")}`);
                line = parts.join(" | ");
            }
            return line;
        }

        case "tool_call":
        case "tool_execution_start": {
            const toolName = getEventToolName(ev);
            const params = getEventParams(ev);
            return `→ ${capture.summarizeToolCall(toolName, params)}`;
        }

        case "tool_result":
        case "tool_execution_end": {
            const toolName = getEventToolName(ev);
            const { success, text: resultText } = capture.parseToolResult(ev);
            const indicator = success ? "✓" : "✗";
            return `  [${indicator}] ${toolName}: ${capture.truncateText(resultText, capture.MAX_TOOL_RESULT_LEN)}`;
        }

        case "error": {
            const msg = typeof ev.message === "string" ? ev.message : JSON.stringify(ev);
            return `⚠ ${msg.slice(0, capture.MAX_DIAGNOSTIC_MESSAGE_LEN)}`;
        }

        default:
            return null;
    }
}

/** Extract tool call names from an assistant message's content parts.
 * (Kept here because it's only needed by the process-manager wrapper.) */
function extractToolCallNames(message: unknown): string[] {
    if (!message || typeof message !== "object") return [];
    const content = (message as any).content;
    if (!Array.isArray(content)) return [];
    const names: string[] = [];
    for (const part of content) {
        if (part?.type === "toolCall" && typeof part.toolName === "string") names.push(part.toolName);
    }
    return names;
}
