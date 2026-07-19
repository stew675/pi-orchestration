import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Task } from "../core/types";
import { MAX_CLARIFICATIONS } from "../core/types";
import { StateManager } from "../context/state-manager";
import { OrchestratorState } from "../core";
import { notifyOrchestrator, savePlanSafely, notifyTuiOnly } from "./utils";
import { transitionTo } from "../core/state-machine";

// --- Contextual recovery guidance strategies ---
const RECOVERY_STRATEGIES: Array<{
    keywords: RegExp[];
    message: string;
}> = [
    {
        keywords: [/truncated/, /partial summary/],
        message:
            "\nRecovery strategy: The validator could not verify the sub-agent's output. " +
            "Do NOT audit source files or re-read code - this wastes turns and doesn't fix the problem. " +
            "Instead, delete the failed task and recreate it with explicit instructions to write test results or build logs to a file (e.g., test_results.txt). " +
            "The validator can only inspect files - stdout claims are insufficient for verification. " +
            "If you've already retried this task more than once, consider using orchestrate_complete_task after personally verifying the work via read."
    },
    {
        keywords: [/timed out/, /killed due to repetitive loop/],
        message:
            "\nRecovery strategy: The sub-agent ran too long or entered a loop. " +
            "Consider simplifying the task, breaking it into smaller pieces, or using orchestrate_complete_task if you verify the work was actually done via read."
    }
];

const DEFAULT_RECOVERY_STRATEGY =
    "\nRecovery strategy: Inspect the validator feedback above to understand what went wrong. " +
    "If the sub-agent produced no verifiable file artifact, recreate the task with instructions to write results to a file (e.g., test_results.txt).";

/** Pick contextual recovery guidance based on keywords in the validator feedback. */
function pickRecoveryStrategy(feedback: string): string {
    for (const strategy of RECOVERY_STRATEGIES) {
        if (strategy.keywords.some((re) => re.test(feedback))) {
            return strategy.message;
        }
    }
    return DEFAULT_RECOVERY_STRATEGY;
}

/** Send a notification to the orchestrator and signal loop termination. */
function notifyAndStop(pi: ExtensionAPI | undefined, message: string): boolean {
    if (pi) {
        notifyOrchestrator(pi, message, { tuiVisible: false });
    }
    return false;
}

/** Archive the task result and prompt for audit/debugging. */
function archiveTask(task: Task): void {
    StateManager.archiveTaskResult(task.id, {
        status: task.status,
        summary: task.result?.summary,
        feedback: task.validatorFeedback
    });
    StateManager.archiveTaskPrompt(task.id);
}

/**
 * Process task result after sub-agent completes.
 * Returns true to continue the loop, false to stop.
 */
export function processTaskResult(task: Task, pi?: ExtensionAPI): boolean {
    try {
        const postPlan = StateManager.loadPlan();
        if (!postPlan) return false;

        const postTask = postPlan.tasks.find((t) => t.id === task.id);

        // Archive the result and move prompt to archive for debugging,
        // but skip if it's still summarizing (handled in finalizeTaskSummary).
        if (postTask && postTask.status !== "summarizing") {
            archiveTask(postTask);
        }

        // Handle clarification pause
        if (postTask?.status === "awaiting_clarification") {
            const attempts = postTask.clarificationAttempts || 1;
            return notifyAndStop(
                pi,
                `System: Task '${task.id}' is paused awaiting clarification (${attempts}/${MAX_CLARIFICATIONS}): "${postTask.clarificationQuery}". Use orchestrate_resume_task after asking the user.`
            );
        }

        // Handle failure
        if (postTask?.status === "failed") {
            // Transition to failed state
            if (!transitionTo("failed", postPlan)) {
                notifyTuiOnly(OrchestratorState.pi, "Failed to transition to failed state in post-processor");
            }
            savePlanSafely(postPlan);

            const feedback = postTask.validatorFeedback || "";
            const recoveryMsg = `Use orchestrate_replan to recover.`;

            return notifyAndStop(
                pi,
                `System: Task '${task.id}' failed. Feedback: ${feedback}. ${recoveryMsg}${pickRecoveryStrategy(feedback)}`
            );
        }

        // Check for graceful pause
        const afterTaskPlan = StateManager.loadPlan();
        if (afterTaskPlan?.status === "pausing") {
            // Transition to paused state
            if (!transitionTo("paused", afterTaskPlan)) {
                notifyTuiOnly(OrchestratorState.pi, "Failed to transition to paused state in post-processor");
            }
            savePlanSafely(afterTaskPlan);
            return notifyAndStop(pi, `System: Paused gracefully after task '${task.id}'.`);
        }

        return true;
    } catch (e) {
        notifyTuiOnly(OrchestratorState.pi, `Error in processTaskResult for task ${task.id}: ${String(e)}`);
        if (pi) {
            notifyOrchestrator(
                pi,
                `System: Internal error processing task '${task.id}': ${e instanceof Error ? e.message : String(e)}`
            );
        }
        return false;
    }
}
