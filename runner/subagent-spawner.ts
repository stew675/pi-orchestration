import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ModelRef, Task } from "../core/types";
import {
    ARTIFACT_PRODUCING_TOOLS,
    FULL_TOOLS,
    READ_ONLY_TOOLS,
    isTaskReadOnly,
    tryParseSubAgentEvent,
    getEventToolName,
    getEventParams
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
                console.warn(
                    `[sub-agent ${options.taskId}] Loop detected - cycle of ${info.cycleLen} event(s), ${info.cycles} repetitions. Killing process.`
                );
                loopKilled = true;
                if (!child.killed) child.kill("SIGTERM");
            }
        });

        let child: ChildProcess;
        let clearTimeout: () => void;
        let capturedLines: () => string[];

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
                        const isToolCall = event.type === "tool_call" || event.type === "tool_execution_start";
                        if (isToolCall) {
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
                logFile
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
                logFile
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
