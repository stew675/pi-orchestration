import { OrchestrationPlan, Task, type TaskType, isTaskReadOnly } from "../core/types";

// ---------------------------------------------------------------------------
// Shared graph helpers (used by detectFileConflicts and autoHealFileConflicts)
// ---------------------------------------------------------------------------

/** Build a memoised ancestor map for all tasks. Returns { ancestors, tasksMap, isReadOnlyByTask }. */
function buildGraphData(
    tasks: Task[]
): {
    ancestors: Map<string, Set<string>>;
    tasksMap: Map<string, Task>;
    isReadOnlyByTask: Map<string, boolean>;
} {
    const ancestors = new Map<string, Set<string>>();
    const tasksMap = new Map<string, Task>();
    const isReadOnlyByTask = new Map<string, boolean>();

    for (const t of tasks) {
        tasksMap.set(t.id, t);
        isReadOnlyByTask.set(t.id, isTaskReadOnly(t.taskType ?? ("other" as TaskType)));
    }

    const visiting = new Set<string>();

    function getAncestors(taskId: string): Set<string> {
        if (ancestors.has(taskId)) return ancestors.get(taskId)!;
        if (visiting.has(taskId)) return new Set<string>(); // cycle detected, break recursion

        visiting.add(taskId);
        const set = new Set<string>();
        const task = tasksMap.get(taskId);
        if (task && task.dependencies) {
            for (const depId of task.dependencies) {
                set.add(depId);
                for (const grandDep of getAncestors(depId)) {
                    set.add(grandDep);
                }
            }
        }
        visiting.delete(taskId);
        ancestors.set(taskId, set);
        return set;
    }

    // Pre-compute all ancestor maps.
    for (const t of tasks) {
        getAncestors(t.id);
    }

    return { ancestors, tasksMap, isReadOnlyByTask };
}

/** Build a file-to-task-IDs map from the given tasks. */
function buildFileToTasks(tasks: Task[]): Map<string, string[]> {
    const fileToTasks = new Map<string, string[]>();
    for (const t of tasks) {
        if (!t.files) continue;
        for (const file of t.files) {
            if (!fileToTasks.has(file)) {
                fileToTasks.set(file, []);
            }
            fileToTasks.get(file)!.push(t.id);
        }
    }
    return fileToTasks;
}

/**
 * Detects circular dependencies in the task graph using DFS.
 * Returns the cycle path if found, otherwise null.
 */
export function detectCycle(plan: OrchestrationPlan): string[] | null {
    const tasks = plan.tasks || [];
    const adj = new Map<string, string[]>();
    for (const t of tasks) {
        adj.set(t.id, t.dependencies || []);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    /**
     * DFS cycle detection helper.
     *
     * `path` is always a locally-created array (not shared with callers) -
     * in-place splice/push/pop mutations are safe.
     */
    function isCyclic(v: string, path: string[]): boolean {
        visited.add(v);
        recStack.add(v);
        path.push(v);

        for (const neighbor of adj.get(v) || []) {
            if (!visited.has(neighbor)) {
                if (isCyclic(neighbor, path)) return true;
            } else if (recStack.has(neighbor)) {
                // Extract the actual cycle path
                const cycleStartIdx = path.indexOf(neighbor);
                if (cycleStartIdx !== -1) {
                    // Replace the accumulated path with just the cycle
                    path.splice(0, path.length, ...path.slice(cycleStartIdx));
                    path.push(neighbor); // close the loop for display
                }
                return true;
            }
        }

        path.pop();
        recStack.delete(v);
        return false;
    }

    for (const t of tasks) {
        if (!visited.has(t.id)) {
            const cyclePath: string[] = [];
            if (isCyclic(t.id, cyclePath)) {
                return cyclePath.length > 0 ? cyclePath : ["Cycle detected in task dependencies"];
            }
        }
    }
    return null;
}

/**
 * Detects if multiple tasks modify the same files without a dependency relationship.
 * If Task A and Task B both modify 'file.ts', one must depend on the other
 * to prevent race conditions during execution.
 *
 * Read-only task types (reviewing, research) do NOT conflict with each other -
 * they only read files so parallel access is safe. However a read-only task
 * WILL still conflict against a write-based task touching the same file unless
 * there is a dependency ordering between them.
 *
 * @param archivedTaskIds - Optional set of already-archived (completed) task IDs.
 *   These tasks are excluded from conflict detection since they have finished
 *   executing and cannot race against newly added remedial tasks during review/replanning.
 */
export function detectFileConflicts(
    plan: OrchestrationPlan,
    archivedTaskIds?: Set<string>
): Array<{ file: string; tasks: string[] }> {
    const isArchived = (id: string) => archivedTaskIds?.has(id) ?? false;

    // Pre-filter to active (non-archived) tasks
    const activeTasks = plan.tasks?.filter((t) => !isArchived(t.id)) || [];

    const { ancestors, isReadOnlyByTask } = buildGraphData(activeTasks);
    const fileToTasksMap = buildFileToTasks(activeTasks);

    // For files touched by multiple tasks, check if there's a dependency path
    const conflicts: Array<{ file: string; tasks: string[] }> = [];
    for (const [file, taskList] of fileToTasksMap.entries()) {
        if (hasPairwiseConflict(taskList, ancestors, isReadOnlyByTask)) {
            conflicts.push({ file, tasks: taskList });
        }
    }

    return conflicts;
}

/** @internal Check whether any pair of tasks in the list has a conflict (no dependency path). */
function hasPairwiseConflict(
    taskIds: string[],
    ancestors: Map<string, Set<string>>,
    isReadOnlyByTask: Map<string, boolean>
): boolean {
    if (taskIds.length < 2) return false;

    for (let i = 0; i < taskIds.length; i++) {
        for (let j = i + 1; j < taskIds.length; j++) {
            const a = taskIds[i];
            const b = taskIds[j];

            // Two read-only tasks can safely share files without ordering
            if (isReadOnlyByTask.get(a) && isReadOnlyByTask.get(b)) continue;

            // Check dependency path in either direction
            const ancestorsA = ancestors.get(a);
            const ancestorsB = ancestors.get(b);
            if (!(ancestorsA?.has(b) || ancestorsB?.has(a))) {
                return true;
            }
        }
    }
    return false;
}

/** Maximum files allowed per task type. `undefined` means unlimited (exempt). */
const FILE_LIMITS: Record<TaskType, number | undefined> = {
    creation: 2, // e.g. 1 implementation file + its associated header file
    editing: 2, // strictly 2 files to keep edits extremely focused and small
    building: undefined,
    administrative: undefined,
    research: undefined,
    reviewing: undefined,
    other: 2 // strictly 2 files
};

/**
 * Detects tasks that touch too many files for their declared task type.
 *
 * Limits:
 *   creation     → max 2 files (prefer 1 implementation + its associated header)
 *   editing      → max 2 files
 *   building     → exempt
 *   administrative → exempt
 *   research     → exempt
 *   reviewing    → exempt
 *   other        → max 2 files
 */
export function detectOversizedTasks(plan: OrchestrationPlan): Array<{
    taskId: string;
    taskType: string;
    fileCount: number;
    limit: number | null;
    description: string;
}> {
    const oversized: Array<{
        taskId: string;
        taskType: string;
        fileCount: number;
        limit: number | null;
        description: string;
    }> = [];

    for (const task of plan.tasks || []) {
        const taskType = task.taskType ?? "other";
        const limit = FILE_LIMITS[taskType];
        if (limit === undefined) continue; // exempt

        const fileCount = (task.files || []).length;
        if (fileCount > limit) {
            oversized.push({
                taskId: task.id,
                taskType,
                fileCount,
                limit,
                description: task.description
            });
        }
    }

    return oversized;
}

/** Format file conflict details for an error message string suitable for user display. */
export function formatFileConflictError(
    conflicts: Array<{ file: string; tasks: string[] }>,
    prefix = "Race condition detected"
): string {
    const conflictDetails = conflicts
        .map(
            (c) =>
                `\n- File '${c.file}' is modified by tasks [${c.tasks.join(", ")}] without a dependency link between them.`
        )
        .join("");
    return `${prefix}: Multiple independent tasks modify the same files.${conflictDetails}\n\nTo fix this, ensure that any task modifying a file depends on the task that previously modified it.`;
}

/**
 * Heal dependencies of tasks when a task is deleted or replaced.
 * - If replacementTaskIds is specified: dependent tasks of deletedTaskId will depend on ALL replacementTaskIds.
 * - If replacementTaskIds is empty: dependent tasks of deletedTaskId will inherit deletedTaskId's dependencies.
 */
export function healDependenciesOnDelete(
    tasks: Task[],
    deletedTaskId: string,
    replacementTaskIds: string[] = []
): void {
    const deletedTask = tasks.find((t) => t.id === deletedTaskId);
    if (!deletedTask) return;

    const deletedTaskDeps = deletedTask.dependencies || [];

    for (const task of tasks) {
        if (task.id === deletedTaskId) continue;
        const deps = task.dependencies || [];

        if (deps.includes(deletedTaskId)) {
            // Remove the deleted task from the dependents list
            task.dependencies = deps.filter((id) => id !== deletedTaskId);

            if (replacementTaskIds.length > 0) {
                // Transfer dependency to replacement task(s)
                for (const repId of replacementTaskIds) {
                    if (!task.dependencies.includes(repId)) {
                        task.dependencies.push(repId);
                    }
                }
            } else {
                // Transitive Dependency Bypass (inherit parent's dependencies)
                for (const depId of deletedTaskDeps) {
                    if (!task.dependencies.includes(depId)) {
                        task.dependencies.push(depId);
                    }
                }
            }
        }
    }
}

/**
 * Scans active tasks for file conflict gaps (i.e. modifying the same file without a dependency path)
 * and automatically injects dependency edges to heal the race condition (preserves order based on task array indices).
 */
export function autoHealFileConflicts(tasks: Task[]): void {
    const { ancestors, tasksMap, isReadOnlyByTask } = buildGraphData(tasks);
    const fileToTasksMap = buildFileToTasks(tasks);

    for (const [, fileTaskIds] of fileToTasksMap.entries()) {
        if (fileTaskIds.length < 2) continue;

        for (let i = 0; i < fileTaskIds.length; i++) {
            for (let j = i + 1; j < fileTaskIds.length; j++) {
                const a = fileTaskIds[i];
                const b = fileTaskIds[j];

                if (isReadOnlyByTask.get(a) && isReadOnlyByTask.get(b)) continue;

                const ancestorsA = ancestors.get(a);
                const ancestorsB = ancestors.get(b);
                if (!(ancestorsA?.has(b) || ancestorsB?.has(a))) {
                    const taskA = tasksMap.get(a);
                    const taskB = tasksMap.get(b);
                    if (taskA && taskB) {
                        const idxA = tasks.indexOf(taskA);
                        const idxB = tasks.indexOf(taskB);
                        if (idxA < idxB) {
                            if (!taskB.dependencies.includes(a)) {
                                taskB.dependencies.push(a);
                                ancestors.delete(b);
                                // Recompute ancestors for b after adding dependency
                                const set = new Set<string>();
                                for (const depId of taskB.dependencies) {
                                    set.add(depId);
                                    for (const grandDep of ancestors.get(depId) || []) set.add(grandDep);
                                }
                                ancestors.set(b, set);
                            }
                        } else {
                            if (!taskA.dependencies.includes(b)) {
                                taskA.dependencies.push(b);
                                ancestors.delete(a);
                                // Recompute ancestors for a after adding dependency
                                const set = new Set<string>();
                                for (const depId of taskA.dependencies) {
                                    set.add(depId);
                                    for (const grandDep of ancestors.get(depId) || []) set.add(grandDep);
                                }
                                ancestors.set(a, set);
                            }
                        }
                    }
                }
            }
        }
    }
}
