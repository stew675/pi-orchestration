import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef, OrchestrationPlan, Task } from "../core/types";
import { ACTIVE_TASK_STATUSES } from "../core/types";
import { OrchestratorState } from "../core";
import { PersistenceManager } from "../context/persistence";
import { notifyOrchestrator, buildFinalReviewMessage, notifyTuiOnly } from "./utils";
import * as fs from "fs";
import { getCurrentOrchestrationState, transitionTo } from "../core/state-machine";
import { refreshUiStatus } from "../ui/ui";

// ---------------------------------------------------------------------------
// Scheduling lock - ensures only one scheduling decision runs at a time.
// ---------------------------------------------------------------------------

let schedulingLock = Promise.resolve();

/**
 * Entry point for task execution. Runs the main scheduling loop: discovers
 * ready tasks, enforces concurrency limits, and delegates to executor.
 */
export async function runTasks(
    pi: ExtensionAPI,
    model?: ModelRef,
    clarificationData?: { taskId: string; answer: string }
): Promise<void> {
    // Inform user via UI that execution is starting
    pi.sendMessage(
        {
            customType: "orchestrator_event",
            content: `System: Starting flat task execution loop.`,
            display: false
        },
        { deliverAs: "nextTurn" }
    );

    while (true) {
        await schedulingLock;
        let releaseSchedulingLock!: () => void;
        schedulingLock = new Promise<void>((r) => (releaseSchedulingLock = r));

        let taskToRun: Task | undefined;

        try {
            const plan = OrchestratorState.plan;
            if (!plan) {
                notifyTuiOnly(pi, "Runner: No plan found.");
                notifyOrchestrator(
                    pi,
                    "System: No orchestration plan available. Execution stopped. Run /om-reset to start fresh."
                );
                return;
            }

            // Get current state from state machine
            const currentState = getCurrentOrchestrationState();

            // Hard stop for paused/failed plans
            if (currentState === "paused" || currentState === "failed") {
                return;
            }

            // Block scheduling while orchestrator is replanning
            if (currentState === "planning") {
                return;
            }

            const countingAsyncSummaries = OrchestratorState.summarizationConcurrency >= 1;

            // Enforce parallel implementation tasks limit.
            const activeImplementationTasks = countActiveImplementationTasks(plan, countingAsyncSummaries);
            if (activeImplementationTasks.length >= OrchestratorState.parallelTasks) {
                return;
            }

            // Find all pending tasks whose dependencies are completed
            const readyTasks = findReadyTasks(plan);

            if (readyTasks.length > 1) {
                // Sort tasks descending by their transitive dependent count to prioritize bottlenecks (critical path)
                readyTasks.sort((a, b) => {
                    const countA = getTransitiveDependentCount(plan, a.id);
                    const countB = getTransitiveDependentCount(plan, b.id);
                    return countB - countA;
                });
            }

            if (readyTasks.length === 0) {
                const active = countActiveImplementationTasks(plan, countingAsyncSummaries);
                if (active.length > 0) {
                    return; // Someone is already executing or waiting
                }

                if (countingAsyncSummaries) {
                    const summarizingTasks = (plan.tasks || []).filter((t) => t.status === "summarizing");
                    if (summarizingTasks.length > 0) {
                        return; // Async summaries in-flight
                    }
                }

                const failedTasks = (plan.tasks || []).filter((t) => t.status === "failed");
                if (failedTasks.length > 0) {
                    // Transition to paused state
                    if (!transitionTo("paused")) {
                        notifyTuiOnly(pi, "Failed to transition to paused state due to failed tasks");
                    }
                    refreshUiStatus();
                    // Include failed task's feedback so orchestrator has context for recovery
                    const failedDetails = failedTasks
                        .map((t) => {
                            const fb = t.validatorFeedback
                                ? t.validatorFeedback.split("\n")[0].slice(0, 200)
                                : "no feedback";
                            return `${t.id} (${fb})`;
                        })
                        .join("; ");
                    notifyOrchestrator(
                        pi,
                        `System: Execution paused because a task failed. Failed: ${failedDetails}.\n` +
                            `Use orchestrate_replan to enter recovery mode, then fix the task with orchestrate_edit_task or delete and recreate it.`
                    );
                    return;
                }

                const allCompleted = (plan.tasks || []).every((t) => t.status === "completed");
                if (!allCompleted) {
                    // Transition to paused state
                    if (!transitionTo("paused")) {
                        notifyTuiOnly(pi, "Failed to transition to paused state due to stalled execution");
                    }
                    refreshUiStatus();
                    notifyOrchestrator(
                        pi,
                        `System: Execution stalled. Some tasks have incomplete or missing dependencies.`
                    );
                    return;
                }

                // allCompleted - handled after lock release (fall through)
            } else {
                taskToRun = readyTasks[0];
            }
        } finally {
            releaseSchedulingLock();
        }

        // All tasks completed - finish the plan
        if (!taskToRun) {
            await finishPlan(pi, model);
            return;
        }

        const currentClarification = clarificationData;

        // Fire off a sibling runner to fill remaining parallel slots.
        if (OrchestratorState.parallelTasks > 1) {
            spawnSiblingRunner(pi, model);
        }

        // Execute the selected task via the executor module
        const { executeTask } = await import("./executor");
        if (!(await executeTask(taskToRun, model, currentClarification, pi))) {
            return;
        }
    }
}

/** Spawn a sibling runner for parallel task execution. */
function spawnSiblingRunner(pi: ExtensionAPI, model?: ModelRef): void {
    // Use dynamic import to avoid circular dependency (scheduler → runner → scheduler).
    import("../runner")
        .then(({ Runner }) => {
            Runner.runTasks(pi, model).catch((err: Error) => {
                notifyTuiOnly(pi, "Sibling runner error: " + String(err));
            });
        })
        .catch((err: Error) => {
            notifyTuiOnly(pi, "Failed to spawn sibling runner: " + String(err));
        });
}

// ---------------------------------------------------------------------------
// Plan completion
// ---------------------------------------------------------------------------

async function finishPlan(pi: ExtensionAPI, _model?: ModelRef): Promise<void> {
    const { awaitAllSummaries } = await import("./summarizer");
    await awaitAllSummaries();

    const finalPlan = OrchestratorState.plan;
    if (!finalPlan) return;

    // All tasks completed - enter final review (must wake orchestrator)
    if (finalPlan.tasks.every((t) => t.status === "completed")) {
        const codeReviewModel = OrchestratorState.codeReviewModel;
        if (codeReviewModel) {
            if (!transitionTo("code_review")) {
                notifyTuiOnly(pi, "Failed to transition to code_review state");
            }

            // Refresh UI immediately so the status line shows CODE_REVIEW
            refreshUiStatus();

            // Delete old code-review.md if present
            PersistenceManager.deleteCodeReview();

            // Notify TUI only — do NOT wake the orchestrator while
            // the sub-agent is still running. It will be notified after verdict.
            notifyTuiOnly(pi, `System: Starting automated Code Review (${codeReviewModel.provider}/${codeReviewModel.id})...`);

            try {
                const { runCodeReview } = await import("./code-reviewer");
                // Use return value only to detect sub-agent failure (timeout/kill/process error).
                // The actual verdict is read from disk — tool call results can fail due to model
                // inconsistencies, and the disk file written by the tool execute handler is source of truth.
                const result = await runCodeReview(pi, codeReviewModel);

                // If the sub-agent itself failed (timed out, killed, process error), fall through to normal review
                if (!result.approved && result.feedback) {
                    notifyOrchestrator(
                        pi,
                        `System: Code review sub-agent did not produce a verdict (${result.feedback}). Proceeding to final review without code review.`,
                        { tuiVisible: true }
                    );
                }
            } catch (err) {
                notifyTuiOnly(pi, "Code review execution failed: " + String(err));
                notifyOrchestrator(
                    pi,
                    `System: Code review sub-agent error (${err instanceof Error ? err.message : String(err)}). Proceeding to final review without code review.`,
                    { tuiVisible: true }
                );
            }

            // Inspect the resulting code-review.md file on disk (source of truth)
            let approved = false;
            let rejected = false;
            const codeReviewPath = PersistenceManager.getCodeReviewPath();
            if (fs.existsSync(codeReviewPath)) {
                const content = fs.readFileSync(codeReviewPath, "utf-8");
                const firstLine = content.split("\n")[0].trim();
                if (firstLine === "APPROVED") {
                    approved = true;
                } else if (firstLine === "CHANGES NEEDED") {
                    rejected = true;
                }
            }

            const updatedPlan = OrchestratorState.plan;
            if (!updatedPlan) return;

            if (approved) {
                notifyTuiOnly(pi, "System: Code review APPROVED — entering FINAL REVIEW.");
                if (!updatedPlan.attributes) updatedPlan.attributes = [];
                updatedPlan.attributes = updatedPlan.attributes.filter(a => a !== "CODE_REVIEW_REJECTED");
                if (!updatedPlan.attributes.includes("CODE_REVIEW_APPROVED")) {
                    updatedPlan.attributes.push("CODE_REVIEW_APPROVED");
                }
                // Code review passed — proceed to final verification
                if (!transitionTo("verifying")) {
                    notifyTuiOnly(pi, "Failed to transition to verifying state");
                }
                refreshUiStatus();
                const reviewMessage = buildFinalReviewMessage(updatedPlan, "System: Code review APPROVED. Entering FINAL REVIEW.");
                notifyOrchestrator(pi, reviewMessage, { tuiVisible: false });
            } else if (rejected) {
                notifyTuiOnly(pi, "System: Code review REJECTED — changes needed.");
                if (!updatedPlan.attributes) updatedPlan.attributes = [];
                updatedPlan.attributes = updatedPlan.attributes.filter(a => a !== "CODE_REVIEW_APPROVED");
                if (!updatedPlan.attributes.includes("CODE_REVIEW_REJECTED")) {
                    updatedPlan.attributes.push("CODE_REVIEW_REJECTED");
                }
                // Code review rejected — remain in code_review and wake orchestrator for remediation
                if (!transitionTo("code_review")) {
                    notifyTuiOnly(pi, "Failed to transition to code_review state");
                }
                refreshUiStatus();

                const wakeMessage = [
                    "System: Code review complete. Changes are required before final approval.",
                    "Please read the .pi/orchestration/plans/code-review.md file and take action upon the contents of that file.",
                    "",
                    "Review Instructions for Orchestrator:",
                    "1. Analyze the true priority of the recommendations within the code review.",
                    "2. Ignore all items of Low priority or lower.",
                    "3. Analyze the remaining items for false-positives and reject those.",
                    "4. If any review items remain, issue remedial tasks to correct them (use orchestrate_add_task, orchestrate_edit_task, etc., and then orchestrate_start_task).",
                    "5. If you find that nothing in the code-review requires further action, you MUST call orchestrate_complete_review to exit the CODE_REVIEW phase."
                ].join("\n");
                notifyOrchestrator(pi, wakeMessage, { tuiVisible: true });
            } else {
                notifyTuiOnly(pi, "System: Code review sub-agent produced no verdict — proceeding to FINAL REVIEW.");
                if (!transitionTo("verifying")) {
                    notifyTuiOnly(pi, "Failed to transition to verifying state");
                }
                refreshUiStatus();
                const reviewMessage = buildFinalReviewMessage(updatedPlan);
                notifyOrchestrator(pi, reviewMessage, { tuiVisible: false });
            }
        } else {
            if (!transitionTo("verifying")) {
                notifyTuiOnly(pi, "Failed to transition to verifying state");
            }
            refreshUiStatus();

            // Build a contextual wakeup message with task summaries so the orchestrator
            // has everything it needs to decide - no need for redundant verification tasks.
            const reviewMessage = buildFinalReviewMessage(finalPlan);
            notifyOrchestrator(pi, reviewMessage, { tuiVisible: false });
        }
    }
}

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

/** Count active implementation tasks (excluding summarizing when async summaries are enabled). */
function countActiveImplementationTasks(plan: OrchestrationPlan, countingAsyncSummaries: boolean): Task[] {
    return (plan.tasks || []).filter((t: Task) => {
        if (!ACTIVE_TASK_STATUSES.includes(t.status as any)) return false;
        if (countingAsyncSummaries && t.status === "summarizing") return false;
        return true;
    });
}

/** Find all pending tasks whose dependencies are completed. */
function findReadyTasks(plan: OrchestrationPlan): Task[] {
    return (plan.tasks || []).filter((t) => {
        if (t.status !== "pending") return false;
        const deps = t.dependencies || [];
        return deps.every((depId) => {
            const depTask = plan.tasks.find((x) => x.id === depId);
            return depTask && depTask.status === "completed";
        });
    });
}

/** Count transitive dependents of a task using DFS to determine bottleneck priorities. */
function getTransitiveDependentCount(plan: OrchestrationPlan, taskId: string): number {
    const visited = new Set<string>();
    function dfs(currentId: string) {
        for (const t of plan.tasks || []) {
            if (t.dependencies?.includes(currentId) && !visited.has(t.id)) {
                visited.add(t.id);
                dfs(t.id);
            }
        }
    }
    dfs(taskId);
    return visited.size;
}
