import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OrchestrationPlan, Task } from "../core/types";
import type { PlanDatabase } from "../core/plan-database";
import { notifyTui } from "../core";

/**
 * Find the next task that needs work, or null if all done.
 * Checks currentTaskId first (if not completed), then finds a ready pending/failed task,
 * and finally returns any non-completed task as a fallback.
 */
export function findNextTaskToRun(planDb: PlanDatabase): Task | null {
    const tasks = planDb.getTasks();
    const currentTaskId = planDb.getCurrentTaskId();
    const currentTask = currentTaskId ? tasks.find((t) => t.id === currentTaskId) : undefined;
    if (currentTask && currentTask.status !== "completed") {
        return currentTask;
    }
    const completedTaskIds = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
    const readyTask = tasks.find((t) => {
        if (t.status !== "pending" && t.status !== "failed") return false;
        const deps = t.dependencies || [];
        return deps.every((depId) => completedTaskIds.has(depId));
    });
    if (readyTask) return readyTask;

    const nonCompleted = tasks.find((t) => t.status !== "completed");
    return nonCompleted || null;
}

/**
 * Reliable notification to the orchestrator.
 * Uses pi.sendMessage with triggerTurn for guaranteed delivery.
 *
 * @param message - System message sent to the orchestrator LLM
 * @param options.tuiVisible - Whether to also append a TUI status entry. Default true.
 *   Set false for multi-paragraph orchestrator guidance (recovery instructions, review
 *   messages) that are meant for the model only and would clutter the user's transcript.
 */
export function notifyOrchestrator(pi: ExtensionAPI, message: string, options?: { tuiVisible?: boolean }): void {
    try {
        const showTui = options?.tuiVisible !== false;

        if (showTui) {
            notifyTui(message, pi);
        }

        pi.sendMessage(
            {
                customType: "orchestrator_event",
                content: message,
                display: false
            },
            { triggerTurn: true }
        );
    } catch (e) {
        notifyTui("Notification failed: " + String(e));
    }
}

/**
 * TUI-only status update. Appends a visual entry but does NOT wake the orchestrator.
 * Use when background work is in progress and the orchestrator should not be disturbed.
 * If pi is undefined, falls back to OrchestratorState.pi internally.
 */
export function notifyTuiOnly(pi: ExtensionAPI | undefined, message: string): void {
    notifyTui(message, pi);
}

/**
 * Build a contextual "FINAL REVIEW" wakeup message with task summaries,
 * artifact file lists, and anti-redundancy instructions.
 *
 * Shared by scheduler.finishPlan() and commands.resumePlanExecution()
 * so both paths produce identical orchestrator guidance.
 */
export function buildFinalReviewMessage(plan: OrchestrationPlan, introLine?: string): string {
    const parts: string[] = [];
    const tasks = plan.tasks || [];

    parts.push(introLine ?? "System: All tasks completed. Entering FINAL REVIEW.");
    parts.push("");

    // Summarize build/test task results so the orchestrator can see what was already verified.
    const buildTasks = tasks.filter((t: Task) => t.taskType === "building");
    if (buildTasks.length > 0) {
        parts.push("Build/test tasks completed:");
        for (const bt of buildTasks) {
            const summaryFirstLine = bt.result?.summary ? bt.result.summary.split("\n")[0].slice(0, 200) : "";
            const artifactList =
                bt.result?.artifacts && bt.result.artifacts.length > 0 ? ` [${bt.result.artifacts.join(", ")}]` : "";
            parts.push(`  - ${bt.id}: ${summaryFirstLine}${artifactList}`);
        }
    }

    // List all deliverable files for quick reference.
    const artifactTasks = tasks.filter((t: Task) => t.result?.artifacts && t.result.artifacts.length > 0);
    if (artifactTasks.length > 0) {
        parts.push("");
        parts.push("Deliverable files created:");
        const allFiles = new Set<string>();
        for (const t of artifactTasks) {
            for (const f of t.result?.artifacts || []) allFiles.add(f);
        }
        parts.push(`  ${[...allFiles].join(", ")}`);
    }

    // Anti-redundancy guidance.
    parts.push("");
    parts.push("Review instructions:");
    parts.push(
        "1. Inspect the project files and verify they satisfy the original goal.",
        "2. If a build/compile/test task already ran successfully (see above), do NOT add another verification task - the work was already validated.",
        "3. Only add a remediation task if you find a genuine gap (e.g., missing file, unverified behavior). Check completed tasks first!",
        "4. You cannot run executables or compile code directly — you have no bash tool in this phase. If verification requires running something, create a task for it.",
        "5. If everything meets the goal, call orchestrate_approve_goal to finish."
    );

    return parts.join("\n");
}
