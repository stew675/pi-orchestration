import { OrchestrationPlan, Task, type TaskType, isTaskReadOnly } from "../core/types";

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
    const fileToTasks = new Map<string, Set<string>>();

    // 1. Map every file to the tasks that modify it
    for (const task of activeTasks) {
        if (!task.files) continue;
        for (const file of task.files) {
            if (!fileToTasks.has(file)) {
                fileToTasks.set(file, new Set());
            }
            fileToTasks.get(file)!.add(task.id);
        }
    }

    // Precompute all ancestors (transitively completed or not) for each task using BFS/DFS
    const ancestors = new Map<string, Set<string>>();
    const tasksMap = new Map<string, Task>();
    const isReadOnlyByTask = new Map<string, boolean>();
    for (const t of activeTasks) {
        tasksMap.set(t.id, t);
        isReadOnlyByTask.set(t.id, isTaskReadOnly(t.taskType ?? ("other" as TaskType)));
    }

    function getAncestors(taskId: string): Set<string> {
        if (ancestors.has(taskId)) return ancestors.get(taskId)!;
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
        ancestors.set(taskId, set);
        return set;
    }

    for (const t of activeTasks) {
        getAncestors(t.id);
    }

    // 2. For files touched by multiple tasks, check if there's a dependency path
    const conflicts: Array<{ file: string; tasks: string[] }> = [];
    for (const [file, tasks] of fileToTasks.entries()) {
        const taskList = Array.from(tasks);
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
 * Returns the IDs of tasks that directly depend on the given task ID.
 */
export function getDependents(plan: OrchestrationPlan, taskId: string): string[] {
    const dependents: string[] = [];
    for (const t of plan.tasks || []) {
        if (t.dependencies?.includes(taskId)) {
            dependents.push(t.id);
        }
    }
    return dependents;
}
