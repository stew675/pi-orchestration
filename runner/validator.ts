import type { ModelRef } from "../core/types";
import { tryParseSubAgentEvent, SubAgentEvent, getEventToolName } from "../core/types";
import { OrchestratorState } from "../core";
import { StateManager } from "../context/state-manager";
import * as monitor from "../process/monitor";
import { spawnAgent } from "../process/process-manager";
import { buildValidatorContext } from "../context/context-builder";
import { parseValidateToolCall, VALIDATOR_TOOLS } from "../tools/validator-tools";
import { formatTimeout } from "../settings/time-utils";

// ---------------------------------------------------------------------------
// Feedback message constants
// ---------------------------------------------------------------------------

const FEEDBACK_TIMEOUT = "Validator timed out without issuing a verdict.";
const FEEDBACK_NO_OUTPUT = "Validator produced no output (empty response).";
const FEEDBACK_PROCESS_ERROR_PREFIX = "Validator process error: ";
const VALIDATOR_MAX_ATTEMPTS = 2;

/**
 * Validate a task by spawning validator sub-agent(s) with retry on non-verdict.
 *
 * The validator is given two tools: orchestrate_validate_pass and
 * orchestrate_validate_fail. Whichever it calls signals the verdict - no JSON
 * parsing needed. If neither tool is called before timeout, that counts as a
 * failure (retried once).
 */
export async function validateTask(
    taskId: string,
    taskDescription: string,
    artifactFiles: string[],
    model?: ModelRef,
    sessionTranscript?: string,
    transcriptLogFile?: string
): Promise<{ pass: boolean; feedback?: string }> {
    if (OrchestratorState.shuttingDown) {
        return { pass: false, feedback: "Validation skipped - orchestrator is shutting down." };
    }

    const context = buildValidatorContext(taskDescription, artifactFiles, sessionTranscript, transcriptLogFile);

    // Persist the validator prompt for debugging
    StateManager.persistValidationPrompt(taskId, context);

    const maxAttempts = VALIDATOR_MAX_ATTEMPTS;
    let finalResult: { pass: boolean; feedback?: string } = { pass: false, feedback: FEEDBACK_NO_OUTPUT };
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        finalResult = await runValidatorOnce(taskId, context, model, attempt + 1);

        // If we got a verdict (pass or fail), no retry needed.
        if (finalResult.feedback !== FEEDBACK_TIMEOUT) {
            break;
        }
        console.warn(`[validator] Attempt ${attempt + 1}/${maxAttempts}: no tool call, retrying...`);
    }

    // Persist the final validation response for debugging
    StateManager.persistValidationResponse(taskId, finalResult || { pass: false, feedback: FEEDBACK_TIMEOUT });

    return finalResult ?? { pass: false, feedback: FEEDBACK_TIMEOUT };
}

/** Spawn a single validator sub-agent and detect which validate tool it calls. */
async function runValidatorOnce(
    taskId: string,
    promptContent: string,
    model?: ModelRef,
    attempt: number = 1
): Promise<{ pass: boolean; feedback?: string }> {
    const monitorId = `${taskId}-validator`;
    return await new Promise((resolve) => {
        // Read-only file access + our two validate tools.
        const toolsArg = `read,ls,find,grep,${VALIDATOR_TOOLS}`;

        const args = ["--mode", "json", "--no-session", "--tools", toolsArg, "--append-system-prompt", promptContent];
        if (model) {
            args.push("--model", `${model.provider}/${model.id}`);
        }
        args.push("-p", `Validate the task and respond with JSON. (Attempt ${attempt})`);

        let verdict: "pass" | "fail" | null = null;
        // Capture any assistant text for feedback if no tool was called.
        let lastAssistantText: string | undefined;

        const { child, clearTimeout } = spawnAgent(
            args,
            {
                timeoutMs: OrchestratorState.validatorTimeoutMs,
                label: `validator ${taskId} attempt ${attempt}`,
                taskId: monitorId
            },
            (line) => {
                // Feed every raw line to the monitor for JSON parsing.
                // skipActive: true so the validator doesn't hijack the /om-status view.
                monitor.ingestLine(monitorId, line, { skipActive: true });

                const event = tryParseSubAgentEvent(line);
                if (!event) return;

                // Check for validate tool calls.
                if (verdict === null && isToolCallEvent(event)) {
                    const toolName = getEventToolName(event);
                    verdict = parseValidateToolCall(toolName);
                }

                // Capture assistant text for debugging / feedback fallback.
                if (event.type === "message_end" && event.message?.role === "assistant") {
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
        const taggedId = `validator-${taskId}`;
        monitor.registerAgent(taggedId, child);

        child.on("close", () => {
            clearTimeout();
            // Don't clear active task - another sub-agent may be running concurrently

            // Verdict from tool call - definitive.
            if (verdict === "pass") {
                resolve({ pass: true, feedback: "" });
                return;
            }
            if (verdict === "fail") {
                resolve({ pass: false, feedback: lastAssistantText || "" });
                return;
            }

            // Check if watchdog killed this agent for idle/turns reasons.
            const taggedId = `validator-${taskId}`;
            const monState = monitor.getMonitoredAgent(taggedId);
            const killReason = monState?.killedByWatchdog ?? null;

            if (killReason === "idle_timeout") {
                resolve({ pass: false, feedback: `Validator idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)}.` });
                return;
            }
            if (killReason === "max_turns") {
                resolve({ pass: false, feedback: `Validator exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns}.` });
                return;
            }

            // Killed by timeout or loop detector.
            if (child.killed) {
                resolve({ pass: false, feedback: FEEDBACK_TIMEOUT });
                return;
            }

            // Process exited cleanly but no validate tool was called.
            // If there's assistant text, include it as feedback for context.
            const feedback = lastAssistantText || "";
            if (feedback) {
                resolve({ pass: false, feedback });
            } else {
                resolve({ pass: false, feedback: FEEDBACK_NO_OUTPUT });
            }
        });

        child.on("error", (err) => {
            clearTimeout();
            // Don't clear active task - another sub-agent may be running concurrently
            resolve({ pass: false, feedback: `${FEEDBACK_PROCESS_ERROR_PREFIX}${err.message}` });
        });
    });
}

/** Check if an event is a tool call / execution start. */
function isToolCallEvent(ev: SubAgentEvent): boolean {
    return ev.type === "tool_call" || ev.type === "tool_execution_start";
}
