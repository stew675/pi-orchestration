import { StateManager } from "../context/state-manager";
import { OrchestratorState, getPi, NOT_ACTIVE_MSG } from "../core";
import {
    detectCycle,
    detectFileConflicts,
    detectOversizedTasks,
    formatFileConflictError,
    getDependents,
    autoHealFileConflicts,
    healDependenciesOnDelete
} from "../validation/validation";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Render helpers (used by plan tools with renderShell: "self")
// ---------------------------------------------------------------------------

const MARKDOWN_OFFSET = 1;

/** Create a Markdown widget from plain text. */
function createMarkdown(text: string) {
    return new Markdown(text, MARKDOWN_OFFSET, MARKDOWN_OFFSET, getMarkdownTheme());
}

/** Render plan tool output as plain markdown - no colored box background. */
export const renderPlanResult = (result: any) => {
    const text = (result.content?.[0] as { type?: string; text?: string })?.text ?? "";
    return createMarkdown(text);
};

/** Render result for orchestrate_write_plan. */
export function renderWritePlanResult(_result: any, options: { isPartial: boolean }, _theme: any) {
    if (options.isPartial) return;
    // Plan already visible on screen from renderCall - return nothing to avoid redundancy.
    return { render: () => [], invalidate: () => {} };
}

/** Render the orchestrate_write_plan tool call with progressive streaming preview. */
export function renderWritePlanCall(_args: any, theme: any, context: { isPartial: boolean; argsComplete: boolean }) {
    const content = (_args as Record<string, unknown>)?.content;
    if (typeof content === "string" && content.trim().length > 0) {
        return createMarkdown(content);
    }
    // No content yet - show compact title
    const text = theme.fg("toolTitle", theme.bold("orchestrate_write_plan"));
    return { render: () => [text], invalidate: () => {} };
}

// ---------------------------------------------------------------------------
// Plan validation helpers (shared by task-crud tools)
// ---------------------------------------------------------------------------

/**
 * Performs safety checks on the plan to prevent circular dependencies and race conditions.
 * Throws an error if a critical violation is found.
 *
 * Note: dangling dependency detection has been moved to pre-mutation validators
 * (validateAddTask / validateEditTask) - the table should never reach save time
 * with invalid references.
 */
export async function validatePlan(plan: any, archivedTaskIds?: Set<string>) {
    // Automatically heal file conflicts by injecting dependencies in array-index order (Mechanism C: Implicit Safety Net)
    autoHealFileConflicts(plan.tasks || []);

    const cycle = detectCycle(plan);
    if (cycle) {
        if (cycle.length > 1 && cycle[0] !== cycle[cycle.length - 1]) {
            throw new Error(
                `Circular dependency detected in the task graph: ${cycle.join(" → ")}. Please review your task dependencies and remove the loop.`
            );
        }
        throw new Error(
            `Circular dependency detected in the task graph. Please review your task dependencies and remove the loop.`
        );
    }

    const conflicts = detectFileConflicts(plan, archivedTaskIds);
    if (conflicts.length > 0) {
        throw new Error(formatFileConflictError(conflicts));
    }

    const oversized = detectOversizedTasks(plan);
    if (oversized.length > 0) {
        const taskDetails = oversized
            .map(
                (t: any) =>
                    `\n- Task '${t.taskId}': ${t.fileCount} files (limit for "${t.taskType}": ${t.limit}) - "${t.description}"`
            )
            .join("");
        throw new Error(
            `Oversized task(s) detected: Tasks touching more than the allowed file count will likely timeout. ` +
                `Split them into smaller tasks.${taskDetails}\n\n` +
                `Limits by task_type: creation=2, editing=2, other=2. building/administrative/research/reviewing are exempt.`
        );
    }
}

// ---------------------------------------------------------------------------
// Pre-mutation plan validators
// ---------------------------------------------------------------------------
/**
 * Pre-mutation check for orchestrate_add_task.
 *
 * Validates that every dependency references an existing task (or self).
 * Cycle, conflict, and oversized checks are handled by the caller via
 * validatePlan on a simulated plan object.
 */
export async function validateAddTask(existingTaskIds: Set<string>, newTaskId: string, dependencies: string[]) {
    // Dependency existence - must reference an existing task or self.
    const missingDeps = dependencies.filter((depId) => !existingTaskIds.has(depId) && depId !== newTaskId);
    if (missingDeps.length > 0) {
        throw new Error(
            `Cannot add task '${newTaskId}': dependency references non-existent task(s): ${missingDeps.map((d) => `'${d}'`).join(", ")}.\n\n` +
                `Add the missing task(s) first, or remove these dependencies.`
        );
    }
}

/**
 * Pre-mutation check for orchestrate_edit_task.
 *
 * Validates that every new dependency references an existing task.
 * Cycle, conflict, and oversized checks are handled by the caller via
 * validatePlan on a simulated plan object.
 */
export async function validateEditTask(existingTaskIds: Set<string>, newDependencies?: string[]) {
    if (newDependencies === undefined) return;

    const missingDeps = newDependencies.filter((depId) => !existingTaskIds.has(depId));
    if (missingDeps.length > 0) {
        throw new Error(
            `Cannot edit task: dependency references non-existent task(s): ${missingDeps.map((d) => `'${d}'`).join(", ")}.\n\n` +
                `Add the missing task(s) first, or remove these dependencies.`
        );
    }
}

/**
 * Validates that deleting a task won't silently orphan other tasks.
 *
 * If any remaining tasks depend on the one being deleted, throws an error.
 * The caller must either add remediation tasks first or edit dependent tasks
 * to remove the dependency before deletion is allowed.
 */
export function validateDeleteTask(plan: any, taskId: string): void {
    // Replaced by automated dependency auto-healing cascading bypass
}

// ---------------------------------------------------------------------------
// Mode guards (shared across tool modules)
// ---------------------------------------------------------------------------

/** Reject task manipulation during planning mode. */
export function requireExecutionMode() {
    if (OrchestratorState.planningMode) {
        throw new Error(
            "Blocked during planning mode. Present your plan to the user and ask them to run /om-accept for approval before manipulating tasks."
        );
    }
}

export function requirePlanNotExecuting() {
    const plan = StateManager.loadPlan();
    if (!plan) throw new Error("No plan exists.");
    // Block task modification during active execution - orchestrator must call
    // orchestrate_replan first to shift into recovery mode (status: "planning").
    // Allowed in: "planning" (recovery), "paused", "reviewing" (final verification), "reviewing_code".
    const allowedStatuses = new Set(["planning", "paused", "reviewing", "reviewing_code"]);
    if (!allowedStatuses.has(plan.status)) {
        throw new Error(
            `Blocked during active execution (${plan.status}). Call orchestrate_replan first to enter recovery mode.`
        );
    }
}

/** Clamp a per-task timeout: floor = configured default, ceiling = 2× default. */
export function clampTaskTimeout(raw?: number): number {
    const configuredDefault = OrchestratorState.taskTimeoutMs;
    const ceiling = configuredDefault * 2;
    return Math.max(configuredDefault, Math.min(raw ?? configuredDefault, ceiling));
}

/** Check whether a task description reads like a build/compile/test task. */
export function isBuildTask(description: string): boolean {
    const keywords = ["build", "compile", "test", "run make", "link", "smoke"];
    return keywords.some((kw) => description.toLowerCase().includes(kw));
}

// ---------------------------------------------------------------------------
// Shared guard and guidance helpers (used by task-crud.ts / execution-control.ts)
// ---------------------------------------------------------------------------

/** Combined prerequisite check for task CRUD tools: isActive + exec mode + plan not executing. */
export function requireTaskCrudPrereqs() {
    if (!OrchestratorState.isActive) throw new Error(NOT_ACTIVE_MSG);
    requireExecutionMode();
    requirePlanNotExecuting();
}

/** Send a silent guidance message to the orchestrator (model sees it, user doesn't). */
export function sendSilentGuidance(message: string) {
    try {
        getPi().sendMessage(
            { customType: "orchestrator_event", content: message, display: false },
            { deliverAs: "nextTurn" }
        );
    } catch {
        /* ignore - guidance is optional */
    }
}
