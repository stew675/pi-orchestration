import type { ModelRef } from "../core/types";
import { getEventToolName, isToolCallEvent } from "../core/types";
import { OrchestratorState } from "../core";
import { PersistenceManager } from "../context/persistence";
import { runReadOnlyAgent } from "./subagent-spawner";
import { buildValidatorContext } from "../context/context-builder";
import { parseValidateToolCall, VALIDATOR_TOOLS } from "../tools/validator-tools";
import { formatTimeout } from "../settings/time-utils";
import { notifyTuiOnly } from "./utils";

// ---------------------------------------------------------------------------
// Feedback message constants
// ---------------------------------------------------------------------------

const FEEDBACK_TIMEOUT = "Validator timed out without issuing a verdict.";
const FEEDBACK_NO_OUTPUT = "Validator produced no output (empty response).";
const VALIDATOR_MAX_ATTEMPTS = 2;

/**
 * Fallback regex-based verdict parser on the text output of the validator,
 * used when the model fails to invoke the validate pass/fail tools.
 */
function parseSemanticVerdict(text: string): "pass" | "fail" | null {
    const lines = text.split("\n").map((l) => l.trim().toUpperCase());

    for (const line of lines) {
        if (line.includes("VERDICT: PASS") || line.includes("VALIDATION: PASS") || line.includes("VERDICT: SUCCESS")) {
            return "pass";
        }
        if (line.includes("VERDICT: FAIL") || line.includes("VALIDATION: FAIL") || line.includes("VERDICT: FAILURE")) {
            return "fail";
        }
    }

    const textUpper = text.toUpperCase();
    if (textUpper.includes("VALIDATION PASS") || textUpper.includes("VERDICT IS PASS")) {
        return "pass";
    }
    if (textUpper.includes("VALIDATION FAIL") || textUpper.includes("VERDICT IS FAIL")) {
        return "fail";
    }

    return null;
}

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
    PersistenceManager.persistValidationPrompt(taskId, context);

    const maxAttempts = VALIDATOR_MAX_ATTEMPTS;
    let finalResult: { pass: boolean; feedback?: string } = { pass: false, feedback: FEEDBACK_NO_OUTPUT };
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        finalResult = await runValidatorOnce(taskId, context, model, attempt + 1);

        // If we got a verdict (pass or fail), no retry needed.
        if (finalResult.feedback !== FEEDBACK_TIMEOUT) {
            break;
        }
        notifyTuiOnly(OrchestratorState.pi, `[validator] Attempt ${attempt + 1}/${maxAttempts}: no tool call, retrying...`);
    }

    // Persist the final validation response for debugging
    PersistenceManager.persistValidationResponse(taskId, finalResult || { pass: false, feedback: FEEDBACK_TIMEOUT });

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
    // Read-only file access + our two validate tools.
    const toolsArg = `read,ls,find,grep,${VALIDATOR_TOOLS}`;

    const args = ["--mode", "json", "--no-session", "--tools", toolsArg, "--append-system-prompt", promptContent];
    if (model) {
        args.push("--model", `${model.provider}/${model.id}`);
    }
    args.push("-p", `Validate the task and respond with JSON. (Attempt ${attempt})`);

    const res = await runReadOnlyAgent<"pass" | "fail">({
        taggedId: `validator-${taskId}`,
        args,
        label: `validator ${taskId} attempt ${attempt}`,
        timeoutMs: OrchestratorState.validatorTimeoutMs,
        taskId: monitorId,
        captureAssistantText: true,
        onEvent: (event) => {
            if (isToolCallEvent(event)) {
                return parseValidateToolCall(getEventToolName(event));
            }
            return null;
        }
    });

    // Verdict from tool call - definitive.
    if (res.resolved) {
        if (res.value === "pass") {
            return { pass: true, feedback: "" };
        } else {
            return { pass: false, feedback: res.lastAssistantText || "" };
        }
    }

    if (res.killedByWatchdog === "idle_timeout") {
        return { pass: false, feedback: `Validator idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)}.` };
    }
    if (res.killedByWatchdog === "max_turns") {
        return { pass: false, feedback: `Validator exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns}.` };
    }

    // Killed by timeout or loop detector.
    if (res.killed) {
        return { pass: false, feedback: FEEDBACK_TIMEOUT };
    }

    // Fallback semantic verdict check on clean exit
    if (res.lastAssistantText) {
        const semanticVerdict = parseSemanticVerdict(res.lastAssistantText);
        if (semanticVerdict === "pass") {
            return { pass: true, feedback: "" };
        }
        if (semanticVerdict === "fail") {
            return { pass: false, feedback: res.lastAssistantText };
        }
    }

    // Process exited cleanly but no validate tool was called.
    // If there's assistant text, include it as feedback for context.
    const feedback = res.lastAssistantText || "";
    if (feedback) {
        return { pass: false, feedback };
    } else {
        return { pass: false, feedback: FEEDBACK_NO_OUTPUT };
    }
}


