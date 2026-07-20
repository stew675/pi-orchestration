import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ModelRef, Task, SubAgentEvent } from "../core/types";
import {
    ARTIFACT_PRODUCING_TOOLS,
    FULL_TOOLS,
    READ_ONLY_TOOLS,
    isTaskReadOnly,
    tryParseSubAgentEvent,
    getEventToolName,
    getEventParams,
    isToolCallEvent
} from "../core/types";
import { OrchestratorState } from "../core";
import { spawnAgent } from "../process/process-manager";
import { LoopDetector } from "../process/loop-detector";
import * as monitor from "../process/monitor";
import { isPathSafe } from "../context/context-builder";

/** Result of a sub-agent process execution. */
export interface SubAgentResult {
    code: number | null;
    discoveredArtifacts: Set<string>;
    lastAssistantText?: string;
    /** True if at least one assistant message_end event was received. */
    receivedAssistantMessage: boolean;
    loopKilled: boolean;
    killed: boolean;
    spawnError?: Error;
    /** Path to the extracted transcript log file (under .pi/orchestration/agent-logs/). */
    logFile?: string;
    /** Captured stderr diagnostics. */
    stderrDiagnostics?: string;
}

/** Options for spawning a sub-agent process. */
export interface SubAgentOptions {
    taskId: string;
    promptFile: string;
    description: string;
    taskType?: Task["taskType"];
    timeoutMs?: number;
    model?: ModelRef;
}

/**
 * Spawn a `pi --mode json` sub-agent process and wait for it to complete.
 * Wires stdout to loop detector, monitor, artifact discovery, and message capture.
 *
 * Logging: extracted plain-text lines are accumulated in memory, then written
 * once to `.pi/orchestration/agent-logs/{taskId}.log` on process close.
 */
export async function runSubAgent(options: SubAgentOptions): Promise<SubAgentResult> {
    const isReadOnly = isTaskReadOnly(options.taskType);

    // The permanent extracted log path (created by process-manager on close).
    const logFile = path.join(process.cwd(), CONFIG_DIR_NAME, "orchestration", "agent-logs", `${options.taskId}.log`);

    return await new Promise<SubAgentResult>((resolve) => {
        const args = buildSpawnArgs(isReadOnly, options.model, options.description, options.promptFile);

        const discoveredArtifacts = new Set<string>();
        let lastAssistantText: string | undefined;
        let receivedAssistantMessage = false;
        let loopKilled = false;

        const loopDetector = new LoopDetector({
            onLoopDetected: (info) => {
                const p = OrchestratorState.pi;
                if (p) { try { p.appendEntry("orchestration-status", { title: "Loop detected", message: `[sub-agent ${options.taskId}] Loop detected - cycle of ${info.cycleLen} event(s), ${info.cycles} repetitions. Killing process.`, timestamp: Date.now() }); } catch {} }
                loopKilled = true;
                if (!child.killed) child.kill("SIGTERM");
            }
        });

        let child: ChildProcess;
        let clearTimeout: () => void;
        let capturedLines: () => string[];
        let getStderrDiagnostics: () => string;

        try {
            const spawnRes = spawnAgent(
                args,
                {
                    timeoutMs: options.timeoutMs ?? OrchestratorState.taskTimeoutMs,
                    label: `sub-agent ${options.taskId}`,
                    taskId: options.taskId
                },
                (line) => {
                    // Feed every raw line to the monitor for /om-status
                    monitor.ingestLine(options.taskId, line);

                    const event = tryParseSubAgentEvent(line);
                    if (event) {
                        // Feed events to the loop detector
                        loopDetector.ingest(event);
                        if (isToolCallEvent(event)) {
                            const toolName = getEventToolName(event);
                            if (
                                ARTIFACT_PRODUCING_TOOLS.includes(toolName as (typeof ARTIFACT_PRODUCING_TOOLS)[number])
                            ) {
                                const params = getEventParams(event);
                                const filePath = params.path;
                                if (typeof filePath === "string") {
                                    const resolved = path.resolve(process.cwd(), filePath);
                                    if (isPathSafe(resolved)) {
                                        discoveredArtifacts.add(filePath);
                                    }
                                }
                            }
                        }
                        // Capture assistant message_end events.
                        if (event.type === "message_end" && event.message?.role === "assistant") {
                            receivedAssistantMessage = true;
                            // For read-only tasks, also capture the text content as the summary
                            if (isReadOnly) {
                                lastAssistantText = extractAssistantText(event.message.content || []);
                            }
                        }
                    }
                }
            );
            child = spawnRes.child;
            clearTimeout = spawnRes.clearTimeout;
            capturedLines = spawnRes.capturedLines;
            getStderrDiagnostics = spawnRes.getStderrDiagnostics;
        } catch (err: any) {
            resolve({
                code: null,
                discoveredArtifacts,
                receivedAssistantMessage: false,
                loopKilled: false,
                killed: false,
                spawnError: err,
                logFile
            });
            return;
        }

        // Wire the process-manager's capture buffer into monitor so both
        // /om-status and failure diagnostics read from a single source of truth.
        const taggedId = `implementation-${options.taskId}`;
        monitor.registerAgent(taggedId, child);
        monitor.setCurrentTask(options.taskId, `sub-agent ${options.taskId}`, capturedLines);
        monitor.clearEvents(options.taskId);

        // Shared cleanup + resolve for close/error handlers.
        const finishSubAgent = (result: SubAgentResult) => {
            clearTimeout();
            monitor.clearActiveTask();
            resolve(result);
        };

        child.on("close", (code: number | null) => {
            finishSubAgent({
                code,
                discoveredArtifacts,
                lastAssistantText,
                receivedAssistantMessage,
                loopKilled,
                killed: child.killed,
                logFile,
                stderrDiagnostics: getStderrDiagnostics ? getStderrDiagnostics() : undefined
            });
        });

        child.on("error", (err: Error) => {
            finishSubAgent({
                code: null,
                discoveredArtifacts,
                lastAssistantText,
                receivedAssistantMessage,
                loopKilled: false,
                killed: child.killed,
                spawnError: err,
                logFile,
                stderrDiagnostics: getStderrDiagnostics ? getStderrDiagnostics() : undefined
            });
        });
    });
}

/** Extract trimmed text from the first text part in a message's content array. */
function extractAssistantText(content: unknown[]): string | undefined {
    for (const raw of content) {
        const part = raw as Record<string, unknown>;
        if (part.type === "text") return String(part.text).trim();
    }
}

/** Options for a generic read-only sub-agent (validator, summarizer, code-reviewer). */
export interface ReadOnlyAgentOptions<T> {
    /** Tagged ID for monitor registration (e.g., "validator-task_01"). */
    taggedId: string;
    /** CLI arguments to pass to pi. */
    args: string[];
    /** Human-readable label for TUI notifications. */
    label: string;
    /** Timeout in ms (passed to spawnAgent). */
    timeoutMs: number;
    /** Task ID used for permanent log path (optional, uses taggedId if omitted). */
    taskId?: string;
    /** Called for every parsed event. Return a truthy value to resolve the agent immediately with that result. */
    onEvent: (event: SubAgentEvent) => T | null;
    /** Extract assistant text from message_end events (optional, stored in result). */
    captureAssistantText?: boolean;
}

/** Result of a generic read-only sub-agent execution. */
export type ReadOnlyAgentResult<T> =
    | { resolved: true; value: T; killedByWatchdog?: "idle_timeout" | "max_turns"; lastAssistantText?: string; code: number | null; killed: boolean }
    | { resolved: false; code: number | null; killedByWatchdog?: "idle_timeout" | "max_turns"; lastAssistantText?: string; killed: boolean };

/** Spawn a generic read-only sub-agent with standard monitoring and watchdog enforcement.
 *
 * Shared by validator, summarizer, and code-reviewer to eliminate duplicated spawn boilerplate.
 * Handles: CLI arg building → spawnAgent → monitor registration → event parsing →
 * assistant text capture → watchdog kill detection → process close resolution.
 */
export async function runReadOnlyAgent<T>(options: ReadOnlyAgentOptions<T>): Promise<ReadOnlyAgentResult<T>> {
    const { taggedId, args, label, timeoutMs, onEvent, captureAssistantText = false } = options;
    const logTaskId = options.taskId ?? taggedId;

    return await new Promise((resolve) => {
        let lastAssistantText: string | undefined;
        let earlyResult: T | null = null;

        const { child, clearTimeout } = spawnAgent(
            args,
            {
                timeoutMs,
                label,
                taskId: logTaskId
            },
            (line) => {
                // Feed every raw line to the monitor for JSON parsing.
                // skipActive: true so the agent doesn't hijack the /om-status view.
                monitor.ingestLine(taggedId, line, { skipActive: true });

                const event = tryParseSubAgentEvent(line);
                if (!event) return;

                // Capture early result (e.g., tool call verdict) but keep running until close.
                if (earlyResult === null) {
                    earlyResult = onEvent(event);
                }

                // Capture assistant text for debugging / feedback fallback.
                if (captureAssistantText && event.type === "message_end" && event.message?.role === "assistant") {
                    for (const part of event.message.content || []) {
                        const partObj = part as Record<string, unknown>;
                        if (partObj.type === "text") {
                            lastAssistantText = String(partObj.text).trim();
                        }
                    }
                }
            }
        );

        // Register with the unified monitor so watchdog can enforce idle/turns limits.
        monitor.registerAgent(taggedId, child);

        child.on("close", (code) => {
            clearTimeout();
            // Don't clear active task - another sub-agent may be running concurrently

            if (earlyResult !== null) {
                const monState = monitor.getMonitoredAgent(taggedId);
                resolve({
                    resolved: true,
                    value: earlyResult,
                    killedByWatchdog: monState?.killedByWatchdog ?? undefined,
                    lastAssistantText,
                    code,
                    killed: child.killed
                });
                return;
            }

            // Check if watchdog killed this agent for idle/turns reasons.
            const monState = monitor.getMonitoredAgent(taggedId);
            const killReason = monState?.killedByWatchdog ?? null;

            resolve({
                resolved: false,
                code,
                killedByWatchdog: killReason ?? undefined,
                lastAssistantText,
                killed: child.killed
            });
        });

        child.on("error", () => {
            clearTimeout();
            const monState = monitor.getMonitoredAgent(taggedId);
            if (earlyResult !== null) {
                resolve({
                    resolved: true,
                    value: earlyResult,
                    killedByWatchdog: monState?.killedByWatchdog ?? undefined,
                    lastAssistantText,
                    code: null,
                    killed: child.killed
                });
            } else {
                resolve({ resolved: false, code: null, killedByWatchdog: monState?.killedByWatchdog ?? undefined, lastAssistantText, killed: child.killed });
            }
        });
    });
}

/** Build CLI args for the sub-agent process. */
function buildSpawnArgs(
    isReadOnly: boolean,
    model: ModelRef | undefined,
    description: string,
    promptFile: string
): string[] {
    const args = [
        "--mode",
        "json",
        "--no-session",
        "--tools",
        isReadOnly ? READ_ONLY_TOOLS : FULL_TOOLS,
        "--append-system-prompt",
        promptFile
    ];
    if (model) {
        args.push("--model", `${model.provider}/${model.id}`);
    }
    args.push("-p", description);
    return args;
}
