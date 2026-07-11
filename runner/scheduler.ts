import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef, OrchestrationPlan, Task } from "../core/types";
import { ACTIVE_TASK_STATUSES } from "../core/types";
import { OrchestratorState } from "../core";
import { StateManager } from "../context/state-manager";
import { notifyOrchestrator, savePlanSafely, buildFinalReviewMessage } from "./utils";

// ---------------------------------------------------------------------------
// Scheduling lock — ensures only one scheduling decision runs at a time.
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
            const plan = StateManager.loadPlan();
            if (!plan) {
                console.error(`Runner: No plan found.`);
                notifyOrchestrator(
                    pi,
                    "System: plan.json is corrupted or unreadable. Execution stopped. Run /om-reset to start fresh."
                );
                return;
            }

            // Hard stop for paused/failed plans
            if (plan.status === "paused" || plan.status === "failed") {
                return;
            }

            // Block scheduling while orchestrator is replanning
            if (plan.status === "planning") {
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
                    plan.status = "paused";
                    savePlanSafely(plan);
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
                    plan.status = "paused";
                    savePlanSafely(plan);
                    notifyOrchestrator(
                        pi,
                        `System: Execution stalled. Some tasks have incomplete or missing dependencies.`
                    );
                    return;
                }

                // allCompleted — handled after lock release (fall through)
            } else {
                taskToRun = readyTasks[0];
            }
        } finally {
            releaseSchedulingLock();
        }

        // All tasks completed — finish the plan
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
                console.error("Sibling runner error:", err);
            });
        })
        .catch((err: Error) => {
            console.error("Failed to spawn sibling runner:", err);
        });
}

// ---------------------------------------------------------------------------
// Plan completion
// ---------------------------------------------------------------------------

async function finishPlan(pi: ExtensionAPI, _model?: ModelRef): Promise<void> {
    const { awaitAllSummaries } = await import("./summarizer");
    await awaitAllSummaries();

    const finalPlan = StateManager.loadPlan();
    if (!finalPlan) return;

    // All tasks completed - enter final review (must wake orchestrator)
    if (finalPlan.tasks.every((t) => t.status === "completed")) {
        finalPlan.status = "reviewing";
        savePlanSafely(finalPlan);

        // Build a contextual wakeup message with task summaries so the orchestrator
        // has everything it needs to decide — no need for redundant verification tasks.
        const reviewMessage = buildFinalReviewMessage(finalPlan);
        notifyOrchestrator(pi, reviewMessage, { tuiVisible: false });
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
