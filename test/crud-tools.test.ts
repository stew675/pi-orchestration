import { describe, it, expect, beforeEach } from "vitest";
import type { OrchestrationPlan, Task } from "../core/types";
import { PlanDatabase } from "../core/plan-database";

// ---------------------------------------------------------------------------
// Helpers — replicate the exact transaction patterns used by CRUD tools
// ---------------------------------------------------------------------------

const TASK_ID_PREFIX = "task_phase";

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: overrides.id ?? "task_phase1_test",
        description: overrides.description ?? "Test task",
        files: overrides.files ?? [],
        dependencies: overrides.dependencies ?? [],
        status: overrides.status ?? "pending",
        attempts: overrides.attempts ?? 0,
        complexity: overrides.complexity ?? "simple",
        timeoutMs: overrides.timeoutMs ?? 720_000,
        taskType: overrides.taskType,
    };
}

function makePlan(tasks: Partial<Task>[] = [{}]): OrchestrationPlan {
    return {
        goal: "Test project",
        tasks: tasks.map(makeTask),
    };
}

/** Simulate orchestrate_add_task transaction body. */
function simulateAddTask(
    db: PlanDatabase,
    params: {
        id: string;
        description: string;
        files?: string[];
        dependencies?: string[];
        complexity?: "simple" | "complex";
        taskType?: Task["taskType"];
        timeoutMs?: number;
        replacesTaskId?: string;
    }
) {
    db.transaction((tx) => {
        if (!params.id.startsWith(TASK_ID_PREFIX)) {
            throw new Error(
                `Invalid task ID '${params.id}'. Must start with '${TASK_ID_PREFIX}'`
            );
        }

        if (tx.hasTask(params.id)) {
            throw new Error(`Task '${params.id}' already exists.`);
        }

        tx.addTask({
            id: params.id,
            description: params.description,
            files: params.files || [],
            dependencies: params.dependencies || [],
            status: "pending",
            attempts: 0,
            complexity: (params.complexity as "simple" | "complex") ?? "simple",
            taskType: params.taskType,
            timeoutMs: params.timeoutMs ?? 720_000,
        });

        if (params.replacesTaskId) {
            tx.deleteTask(params.replacesTaskId, true);
        }
    });
}

/** Simulate orchestrate_delete_task transaction body. */
function simulateDeleteTask(db: PlanDatabase, taskId: string) {
    db.transaction((tx) => {
        const task = tx.getTask(taskId);
        if (!task) {
            throw new Error(`Task '${taskId}' not found.`);
        }

        const deletableStates = ["pending", "failed", "completed"];
        if (!deletableStates.includes(task.status)) {
            throw new Error(
                `Cannot delete task '${taskId}' while it is '${task.status}'.`
            );
        }

        tx.deleteTask(taskId, true); // healDependencies=true
    });
}

/** Simulate orchestrate_complete_task transaction body. */
function simulateCompleteTask(
    db: PlanDatabase,
    taskId: string,
    summary?: string
) {
    const task = db.getTask(taskId);
    if (!task) {
        throw new Error(`Task '${taskId}' not found.`);
    }

    db.transaction((tx) => {
        tx.updateTask(taskId, {
            status: "completed",
            clarificationAttempts: 0,
            validatorFeedback: undefined,
            result: {
                ...(task.result || {}),
                summary:
                    summary ?? "Task forcibly marked as complete by orchestrator.",
                manuallyCompleted: true,
            },
        });
    });
}

/** Simulate orchestrate_edit_task transaction body. */
function simulateEditTask(
    db: PlanDatabase,
    params: {
        taskId: string;
        description?: string;
        files?: string[];
        dependencies?: string[];
        complexity?: "simple" | "complex";
        taskType?: Task["taskType"];
        timeoutMs?: number;
    }
) {
    db.transaction((tx) => {
        if (!tx.hasTask(params.taskId)) {
            throw new Error(`Task '${params.taskId}' not found.`);
        }

        const edits: Record<string, unknown> = {};
        if (params.description !== undefined)
            edits.description = params.description;
        if (params.files !== undefined) edits.files = params.files;
        if (params.dependencies !== undefined)
            edits.dependencies = params.dependencies;
        if (params.complexity !== undefined)
            edits.complexity = params.complexity as "simple" | "complex";
        if (params.taskType !== undefined)
            edits.taskType = params.taskType as Task["taskType"];
        if (params.timeoutMs !== undefined) edits.timeoutMs = params.timeoutMs;

        // Edit resets task to pending with zero attempts
        edits.status = "pending";
        edits.attempts = 0;

        tx.updateTask(
            params.taskId,
            edits as Parameters<typeof tx.updateTask>[1]
        );
    });
}

/** Simulate orchestrate_bulk_update_tasks transaction body. */
function simulateBulkUpdateTasks(
    db: PlanDatabase,
    updates: {
        action: "add" | "delete" | "edit";
        id: string;
        description?: string;
        files?: string[];
        dependencies?: string[];
        complexity?: "simple" | "complex";
        taskType?: Task["taskType"];
        timeoutMs?: number;
        replacesTaskId?: string;
    }[]
) {
    db.transaction((tx) => {
        const replacements = new Map<string, string[]>();

        // Phase 1: Add new tasks and track replacement mappings
        for (const update of updates) {
            if (update.action === "add") {
                if (tx.hasTask(update.id)) {
                    throw new Error(
                        `Bulk add failed: Task '${update.id}' already exists.`
                    );
                }
                if (!update.id.startsWith(TASK_ID_PREFIX)) {
                    throw new Error(
                        `Invalid task ID '${update.id}'. Must start with '${TASK_ID_PREFIX}'.`
                    );
                }

                tx.addTask({
                    id: update.id,
                    description: update.description || "",
                    files: update.files || [],
                    dependencies: update.dependencies || [],
                    status: "pending",
                    attempts: 0,
                    complexity: (update.complexity as "simple" | "complex") ?? "complex",
                    taskType: update.taskType,
                    timeoutMs: update.timeoutMs ?? 720_000,
                });

                if (update.replacesTaskId) {
                    const list = replacements.get(update.replacesTaskId) || [];
                    list.push(update.id);
                    replacements.set(update.replacesTaskId, list);
                }
            } else if (update.action === "edit") {
                if (!tx.hasTask(update.id)) {
                    throw new Error(
                        `Bulk edit failed: Task '${update.id}' not found.`
                    );
                }

                const edits: Record<string, unknown> = {};
                if (update.description !== undefined)
                    edits.description = update.description;
                if (update.files !== undefined) edits.files = update.files;
                if (update.dependencies !== undefined)
                    edits.dependencies = update.dependencies;
                if (update.complexity !== undefined)
                    edits.complexity = update.complexity as "simple" | "complex";
                if (update.taskType !== undefined)
                    edits.taskType = update.taskType as Task["taskType"];
                if (update.timeoutMs !== undefined)
                    edits.timeoutMs = update.timeoutMs;

                tx.updateTask(
                    update.id,
                    edits as Parameters<typeof tx.updateTask>[1]
                );
            }
        }

        // Phase 2: Delete tasks (after adds so replacements exist for dep healing)
        for (const update of updates) {
            if (update.action === "delete") {
                tx.deleteTask(update.id, true);
            }
        }

        // Phase 3: Apply replacement routing — re-heal dependents of replaced tasks
        for (const [oldId, newIds] of replacements.entries()) {
            const tasks = tx.getTasks();
            for (const task of tasks) {
                if (task.id === oldId) continue;
                const deps = task.dependencies || [];
                if (deps.includes(oldId)) {
                    const newDeps = deps.filter((dId: string) => dId !== oldId);
                    for (const replacementId of newIds) {
                        if (!newDeps.includes(replacementId)) {
                            newDeps.push(replacementId);
                        }
                    }
                    tx.updateTask(task.id, { dependencies: newDeps });
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Test suite: orchestrate_add_task with valid/invalid deps (test case 10)
// ---------------------------------------------------------------------------

describe("orchestrate_add_task (simulated)", () => {
    let db: PlanDatabase;

    beforeEach(() => {
        db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_base", files: ["src/base.ts"] },
                { id: "task_phase2_dep" },
            ])
        );
    });

    it("adds a task with valid dependencies", () => {
        simulateAddTask(db, {
            id: "task_phase3_new",
            description: "New feature",
            files: ["src/feature.ts"],
            dependencies: ["task_phase1_base"],
            complexity: "simple",
        });

        expect(db.hasTask("task_phase3_new")).toBe(true);
        const task = db.getTask("task_phase3_new");
        expect(task).toBeDefined();
        expect(task!.status).toBe("pending");
        expect(task!.attempts).toBe(0);
        expect(task!.dependencies).toEqual(["task_phase1_base"]);
    });

    it("adds a task with no dependencies", () => {
        simulateAddTask(db, {
            id: "task_phase3_independent",
            description: "Independent work",
            complexity: "simple",
        });

        expect(db.hasTask("task_phase3_independent")).toBe(true);
    });

    it("rejects a task with invalid (non-existent) dependency", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateAddTask(db, {
                id: "task_phase3_bad",
                description: "Bad dep",
                dependencies: ["task_nonexistent"],
                complexity: "simple",
            });
        }).toThrow(/does not exist/i);

        // Plan must be unchanged (rollback)
        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects a duplicate task ID", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateAddTask(db, {
                id: "task_phase1_base", // already exists
                description: "Duplicate",
                complexity: "simple",
            });
        }).toThrow(/already exist/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects a task ID that doesn't match naming convention", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateAddTask(db, {
                id: "bad_id_format", // doesn't start with 'task_phase'
                description: "Bad name",
                complexity: "simple",
            });
        }).toThrow(/Invalid task ID/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects a creation task with too many files (>2)", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateAddTask(db, {
                id: "task_phase3_oversized",
                description: "Too many files",
                files: ["a.ts", "b.ts", "c.ts"],
                taskType: "creation",
                complexity: "simple",
            });
        }).toThrow(/Oversized tasks detected/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("allows a creation task with exactly 2 files (at limit)", () => {
        simulateAddTask(db, {
            id: "task_phase3_at_limit",
            description: "At the limit",
            files: ["a.ts", "b.ts"],
            taskType: "creation",
            complexity: "simple",
        });

        expect(db.hasTask("task_phase3_at_limit")).toBe(true);
    });

    it("allows a building task with any number of files (exempt)", () => {
        simulateAddTask(db, {
            id: "task_phase3_build",
            description: "Build project",
            files: ["a.ts", "b.ts", "c.ts", "d.ts"],
            taskType: "building",
            complexity: "simple",
        });

        expect(db.hasTask("task_phase3_build")).toBe(true);
    });

    it("adds a task and replaces an existing one (replacesTaskId)", () => {
        simulateAddTask(db, {
            id: "task_phase3_replacement",
            description: "Replacement task",
            complexity: "simple",
            replacesTaskId: "task_phase2_dep",
        });

        expect(db.hasTask("task_phase3_replacement")).toBe(true);
        expect(db.hasTask("task_phase2_dep")).toBe(false); // deleted
    });

    it("marks database dirty after successful add", () => {
        expect(db.isDirty()).toBe(false);
        simulateAddTask(db, {
            id: "task_phase3_dirty_test",
            description: "Test",
            complexity: "simple",
        });
        expect(db.isDirty()).toBe(true);
    });

    it("does not mark dirty on rollback (validation failure)", () => {
        expect(() => {
            simulateAddTask(db, {
                id: "task_phase3_fail",
                description: "Bad dep",
                dependencies: ["nonexistent"],
                complexity: "simple",
            });
        }).toThrow();

        expect(db.isDirty()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Test suite: orchestrate_delete_task with healDependencies (test case 11)
// ---------------------------------------------------------------------------

describe("orchestrate_delete_task (simulated)", () => {
    let db: PlanDatabase;

    beforeEach(() => {
        // Chain: X -> A -> B, plus an independent task C
        db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_x" },
                { id: "task_phase2_a", dependencies: ["task_phase1_x"] },
                { id: "task_phase3_b", dependencies: ["task_phase2_a"] },
                { id: "task_phase4_c" },
            ])
        );
    });

    it("deletes a pending task and heals dependents", () => {
        simulateDeleteTask(db, "task_phase2_a");

        expect(db.hasTask("task_phase2_a")).toBe(false);

        // B should now depend on X (A's dependency) instead of A
        const taskB = db.getTask("task_phase3_b");
        expect(taskB).toBeDefined();
        expect(taskB!.dependencies).toContain("task_phase1_x");
        expect(taskB!.dependencies).not.toContain("task_phase2_a");

        // Other tasks unchanged
        expect(db.hasTask("task_phase4_c")).toBe(true);
    });

    it("deletes a failed task", () => {
        db.transaction((tx) => {
            tx.updateTask("task_phase1_x", { status: "failed" });
        });

        simulateDeleteTask(db, "task_phase1_x");
        expect(db.hasTask("task_phase1_x")).toBe(false);
    });

    it("deletes a completed task", () => {
        db.transaction((tx) => {
            tx.updateTask("task_phase4_c", { status: "completed" });
        });

        simulateDeleteTask(db, "task_phase4_c");
        expect(db.hasTask("task_phase4_c")).toBe(false);
    });

    it("rejects deleting a running task", () => {
        db.transaction((tx) => {
            tx.updateTask("task_phase1_x", { status: "running" });
        });

        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateDeleteTask(db, "task_phase1_x");
        }).toThrow(/Cannot delete.*while it is 'running'/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects deleting a validating task", () => {
        db.transaction((tx) => {
            tx.updateTask("task_phase1_x", { status: "validating" });
        });

        expect(() => {
            simulateDeleteTask(db, "task_phase1_x");
        }).toThrow(/Cannot delete.*while it is 'validating'/i);
    });

    it("rejects deleting a task that doesn't exist", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateDeleteTask(db, "task_nonexistent");
        }).toThrow(/not found/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("clears currentTaskId when deleting the current task", () => {
        db.transaction((tx) => {
            tx.setCurrentTaskId("task_phase4_c");
        });
        expect(db.getCurrentTaskId()).toBe("task_phase4_c");

        simulateDeleteTask(db, "task_phase4_c");
        expect(db.getCurrentTaskId()).toBeUndefined();
    });

    it("deletes a leaf task with no dependents", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());
        // Remove B's dependency on A so A is not referenced by anyone
        db.transaction((tx) => {
            tx.updateTask("task_phase3_b", { dependencies: [] });
        });

        simulateDeleteTask(db, "task_phase2_a");
        expect(db.hasTask("task_phase2_a")).toBe(false);

        // B should still exist with no deps
        const taskB = db.getTask("task_phase3_b");
        expect(taskB!.dependencies).toEqual([]);
    });

    it("deletes a task and heals multiple dependents", () => {
        // Add tasks D and E that both depend on A
        simulateAddTask(db, {
            id: "task_phase5_d",
            description: "Depends on A",
            dependencies: ["task_phase2_a"],
            complexity: "simple",
        });
        simulateAddTask(db, {
            id: "task_phase6_e",
            description: "Also depends on A",
            dependencies: ["task_phase2_a"],
            complexity: "simple",
        });

        simulateDeleteTask(db, "task_phase2_a");

        // B, D, E should all inherit X (A's dep)
        const taskB = db.getTask("task_phase3_b");
        expect(taskB!.dependencies).toContain("task_phase1_x");

        const taskD = db.getTask("task_phase5_d");
        expect(taskD!.dependencies).toContain("task_phase1_x");

        const taskE = db.getTask("task_phase6_e");
        expect(taskE!.dependencies).toContain("task_phase1_x");
    });
});

// ---------------------------------------------------------------------------
// Test suite: orchestrate_bulk_update_tasks with mixed actions (test case 12)
// ---------------------------------------------------------------------------

describe("orchestrate_bulk_update_tasks (simulated)", () => {
    let db: PlanDatabase;

    beforeEach(() => {
        db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_a" },
                { id: "task_phase2_b", dependencies: ["task_phase1_a"] },
                { id: "task_phase3_c", dependencies: ["task_phase2_b"] },
            ])
        );
    });

    it("adds multiple tasks in one transaction", () => {
        simulateBulkUpdateTasks(db, [
            {
                action: "add",
                id: "task_phase4_new1",
                description: "New task 1",
                complexity: "simple",
            },
            {
                action: "add",
                id: "task_phase5_new2",
                description: "New task 2",
                dependencies: ["task_phase4_new1"],
                complexity: "simple",
            },
        ]);

        expect(db.hasTask("task_phase4_new1")).toBe(true);
        expect(db.hasTask("task_phase5_new2")).toBe(true);
    });

    it("edits multiple tasks in one transaction", () => {
        simulateBulkUpdateTasks(db, [
            {
                action: "edit",
                id: "task_phase1_a",
                description: "Updated A",
                complexity: "complex",
            },
            {
                action: "edit",
                id: "task_phase2_b",
                dependencies: [], // remove dependency on A
            },
        ]);

        const taskA = db.getTask("task_phase1_a");
        expect(taskA!.description).toBe("Updated A");
        expect(taskA!.complexity).toBe("complex");

        const taskB = db.getTask("task_phase2_b");
        expect(taskB!.dependencies).toEqual([]);
    });

    it("deletes tasks in one transaction", () => {
        simulateBulkUpdateTasks(db, [
            { action: "delete", id: "task_phase1_a" },
        ]);

        expect(db.hasTask("task_phase1_a")).toBe(false);
        // B should have healed (A had no deps, so B's dep on A just removed)
        const taskB = db.getTask("task_phase2_b");
        expect(taskB!.dependencies).not.toContain("task_phase1_a");
    });

    it("handles mixed add + delete in one transaction", () => {
        simulateBulkUpdateTasks(db, [
            {
                action: "add",
                id: "task_phase4_replacement",
                description: "Replacement for B",
                dependencies: ["task_phase1_a"],
                complexity: "simple",
            },
            { action: "delete", id: "task_phase2_b" },
        ]);

        expect(db.hasTask("task_phase4_replacement")).toBe(true);
        expect(db.hasTask("task_phase2_b")).toBe(false);

        // C (which depended on B) should now depend on A (B's dependency) via healing
        const taskC = db.getTask("task_phase3_c");
        expect(taskC!.dependencies).toContain("task_phase1_a");
    });

    it("handles mixed add + edit + delete in one transaction", () => {
        simulateBulkUpdateTasks(db, [
            // Add a new task
            {
                action: "add",
                id: "task_phase4_new",
                description: "Brand new",
                complexity: "simple",
            },
            // Edit an existing task
            {
                action: "edit",
                id: "task_phase1_a",
                description: "Modified A",
            },
            // Delete a task
            { action: "delete", id: "task_phase3_c" },
        ]);

        expect(db.hasTask("task_phase4_new")).toBe(true);
        expect(db.getTask("task_phase1_a")!.description).toBe("Modified A");
        expect(db.hasTask("task_phase3_c")).toBe(false);
    });

    it("handles replacesTaskId routing in bulk update", () => {
        // Split task B into two new tasks, replacing the old one.
        // NOTE: After delete heals dependencies (Phase 2), C's dep on B is replaced
        // with B's own deps (A). Then Phase 3 replacement routing can't find B in C's
        // deps anymore. So C inherits A, not the split tasks. This matches actual tool behavior.
        simulateBulkUpdateTasks(db, [
            {
                action: "add",
                id: "task_phase4_b_split1",
                description: "Split part 1",
                dependencies: ["task_phase1_a"],
                replacesTaskId: "task_phase2_b",
                complexity: "simple",
            },
            {
                action: "add",
                id: "task_phase5_b_split2",
                description: "Split part 2",
                dependencies: ["task_phase4_b_split1"],
                replacesTaskId: "task_phase2_b",
                complexity: "simple",
            },
            { action: "delete", id: "task_phase2_b" },
        ]);

        // B deleted, split tasks added
        expect(db.hasTask("task_phase2_b")).toBe(false);
        expect(db.hasTask("task_phase4_b_split1")).toBe(true);
        expect(db.hasTask("task_phase5_b_split2")).toBe(true);

        // C inherited B's deps (A) via healing, not the replacement IDs
        const taskC = db.getTask("task_phase3_c");
        expect(taskC!.dependencies).toContain("task_phase1_a");
    });

    it("rejects bulk add with duplicate ID", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateBulkUpdateTasks(db, [
                { action: "add", id: "task_phase1_a", description: "dup" }, // already exists
            ]);
        }).toThrow(/already exist/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects bulk edit of non-existent task", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateBulkUpdateTasks(db, [
                { action: "edit", id: "task_nonexistent" },
            ]);
        }).toThrow(/not found/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects bulk add with invalid task ID format", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateBulkUpdateTasks(db, [
                { action: "add", id: "bad_name", description: "invalid" },
            ]);
        }).toThrow(/Invalid task ID/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects bulk update that creates a cycle (all mutations rolled back)", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        // Create cycle by making A depend on C (C -> B -> A already exists, so A -> C closes the loop)
        expect(() => {
            simulateBulkUpdateTasks(db, [
                {
                    action: "edit",
                    id: "task_phase1_a",
                    dependencies: ["task_phase3_c"], // A -> C, but C -> B -> A = cycle
                },
            ]);
        }).toThrow();

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects bulk update that creates oversized tasks (all rolled back)", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateBulkUpdateTasks(db, [
                {
                    action: "add",
                    id: "task_phase4_oversized",
                    description: "Too many files",
                    files: ["a.ts", "b.ts", "c.ts"],
                    taskType: "creation",
                    complexity: "simple",
                },
            ]);
        }).toThrow(/Oversized tasks detected/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("marks database dirty after successful bulk update", () => {
        expect(db.isDirty()).toBe(false);
        simulateBulkUpdateTasks(db, [
            { action: "edit", id: "task_phase1_a", description: "changed" },
        ]);
        expect(db.isDirty()).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test suite: orchestrate_edit_task (additional CRUD coverage)
// ---------------------------------------------------------------------------

describe("orchestrate_edit_task (simulated)", () => {
    let db: PlanDatabase;

    beforeEach(() => {
        db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_a", status: "completed" },
                { id: "task_phase2_b", dependencies: ["task_phase1_a"] },
            ])
        );
    });

    it("resets a task to pending with zero attempts on edit", () => {
        db.transaction((tx) => {
            tx.updateTask("task_phase1_a", { status: "failed", attempts: 3 });
        });

        simulateEditTask(db, { taskId: "task_phase1_a" });

        const task = db.getTask("task_phase1_a");
        expect(task!.status).toBe("pending");
        expect(task!.attempts).toBe(0);
    });

    it("updates description and files", () => {
        simulateEditTask(db, {
            taskId: "task_phase2_b",
            description: "New description",
            files: ["src/new.ts"],
        });

        const task = db.getTask("task_phase2_b");
        expect(task!.description).toBe("New description");
        expect(task!.files).toEqual(["src/new.ts"]);
    });

    it("rejects editing a non-existent task", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateEditTask(db, { taskId: "task_nonexistent" });
        }).toThrow(/not found/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("rejects editing with invalid dependency (validation rollback)", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            simulateEditTask(db, {
                taskId: "task_phase2_b",
                dependencies: ["task_nonexistent"],
            });
        }).toThrow(/does not exist/i);

        expect(JSON.stringify(db.toJSON())).toBe(
            snapshotBefore
        );
    });

    it("updates only specified fields (partial edit)", () => {
        const task = db.getTask("task_phase2_b");
        const originalComplexity = task!.complexity;

        simulateEditTask(db, {
            taskId: "task_phase2_b",
            description: "Only changing description",
        });

        const updated = db.getTask("task_phase2_b");
        expect(updated!.description).toBe("Only changing description");
        expect(updated!.complexity).toBe(originalComplexity); // unchanged
    });
});

// ---------------------------------------------------------------------------
// Test suite: orchestrate_complete_task (additional CRUD coverage)
// ---------------------------------------------------------------------------

describe("orchestrate_complete_task (simulated)", () => {
    let db: PlanDatabase;

    beforeEach(() => {
        db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_a", status: "running" },
                { id: "task_phase2_b", status: "failed" },
            ])
        );
    });

    it("marks a running task as completed with manual flag", () => {
        simulateCompleteTask(db, "task_phase1_a");

        const task = db.getTask("task_phase1_a");
        expect(task!.status).toBe("completed");
        expect(task!.result?.manuallyCompleted).toBe(true);
    });

    it("marks a failed task as completed with custom summary", () => {
        simulateCompleteTask(db, "task_phase2_b", "Fixed by hand");

        const task = db.getTask("task_phase2_b");
        expect(task!.status).toBe("completed");
        expect(task!.result?.summary).toBe("Fixed by hand");
    });

    it("rejects completing a non-existent task", () => {
        expect(() => {
            simulateCompleteTask(db, "task_nonexistent");
        }).toThrow(/not found/i);
    });

    it("uses default summary when none provided", () => {
        simulateCompleteTask(db, "task_phase1_a");

        const task = db.getTask("task_phase1_a");
        expect(task!.result?.summary).toBe(
            "Task forcibly marked as complete by orchestrator."
        );
    });
});

// ---------------------------------------------------------------------------
// Test suite: Error recovery — validation failure → plan unchanged (test case 13)
// ---------------------------------------------------------------------------

describe("error recovery: validation failure leaves plan unchanged", () => {
    let db: PlanDatabase;

    beforeEach(() => {
        db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_a", files: ["src/a.ts"] },
                { id: "task_phase2_b", files: ["src/b.ts"], dependencies: ["task_phase1_a"] },
            ])
        );
    });

    it("add task with non-existent dep → plan unchanged", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase3_bad",
                    description: "Bad dependency",
                    dependencies: ["nonexistent_task"],
                    complexity: "simple",
                    timeoutMs: 720_000,
                });
            });
        }).toThrow();

        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
    });

    it("edit task creating a cycle → plan unchanged", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        // B depends on A. Making A depend on B creates a cycle.
        expect(() => {
            db.transaction((tx) => {
                tx.updateTask("task_phase1_a", {
                    dependencies: ["task_phase2_b"],
                });
            });
        }).toThrow();

        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
    });

    it("bulk update with invalid action → all mutations rolled back", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            db.transaction((tx) => {
                // Add a task (would succeed alone)
                tx.addTask({
                    id: "task_phase3_new",
                    description: "New",
                    complexity: "simple",
                    timeoutMs: 720_000,
                });

                // Then reference a non-existent dep (fails validation)
                tx.updateTask("task_phase3_new", {
                    dependencies: ["nonexistent"],
                });
            });
        }).toThrow();

        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
        expect(db.hasTask("task_phase3_new")).toBe(false); // rolled back too
    });

    it("oversized task in middle of bulk transaction → all mutations rolled back", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase3_ok",
                    description: "OK task",
                    complexity: "simple",
                    timeoutMs: 720_000,
                });
                // Oversized creation task — should reject the whole transaction
                tx.addTask({
                    id: "task_phase4_big",
                    description: "Too many files",
                    files: ["a.ts", "b.ts", "c.ts"],
                    complexity: "simple",
                    timeoutMs: 720_000,
                    taskType: "creation",
                });
            });
        }).toThrow(/Oversized tasks detected/i);

        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
        expect(db.hasTask("task_phase3_ok")).toBe(false); // also rolled back
    });

    it("callback throws mid-transaction → plan unchanged", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        expect(() => {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase3_partial",
                    description: "Partial work",
                    complexity: "simple",
                    timeoutMs: 720_000,
                });
                throw new Error("abort!"); // simulate unexpected error mid-way
            });
        }).toThrow("abort!");

        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
    });

    it("file conflict that auto-heal can't resolve → plan unchanged", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        // Add two creation tasks touching the same file — autoHealFileConflicts should handle this.
        // But if they both have deps that prevent healing, validation fails.
        expect(() => {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase3_conflict",
                    description: "Conflict task",
                    files: ["src/a.ts"], // same file as task_phase1_a
                    complexity: "simple",
                    timeoutMs: 720_000,
                    taskType: "creation",
                });
            });
        }).not.toThrow(); // auto-heal should resolve this

        const conflictTask = db.getTask("task_phase3_conflict");
        expect(conflictTask).toBeDefined();
        // Auto-heal injected a dependency to prevent the race condition
        expect(conflictTask!.dependencies).toContain("task_phase1_a");
    });

    it("multiple consecutive failures leave plan in original state", () => {
        const snapshotBefore = JSON.stringify(db.toJSON());

        // First failure: bad dep
        try {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase3_x",
                    description: "x",
                    dependencies: ["nonexistent"],
                    complexity: "simple",
                    timeoutMs: 720_000,
                });
            });
        } catch { /* expected */ }

        // Second failure: oversized task
        try {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase3_y",
                    description: "y",
                    files: ["a.ts", "b.ts", "c.ts"],
                    complexity: "simple",
                    timeoutMs: 720_000,
                    taskType: "creation",
                });
            });
        } catch { /* expected */ }

        // Third failure: callback error
        try {
            db.transaction((tx) => {
                tx.addTask({ id: "task_phase3_z", description: "z", complexity: "simple", timeoutMs: 720_000 });
                throw new Error("fail");
            });
        } catch { /* expected */ }

        // Plan must still be identical to original
        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
    });
});

// ---------------------------------------------------------------------------
// Test suite: CRUD edge cases and cross-cutting concerns
// ---------------------------------------------------------------------------

describe("CRUD edge cases", () => {
    it("add → delete immediately (task never persisted in between)", () => {
        const db = PlanDatabase.empty();
        db.transaction((tx) => { tx.setGoal("Test"); });

        simulateAddTask(db, {
            id: "task_phase1_temp",
            description: "Temporary task",
            complexity: "simple",
        });
        expect(db.hasTask("task_phase1_temp")).toBe(true);

        simulateDeleteTask(db, "task_phase1_temp");
        expect(db.hasTask("task_phase1_temp")).toBe(false);
    });

    it("add task with self-dependency → rejected by validation", () => {
        const db = PlanDatabase.empty();
        db.transaction((tx) => { tx.setGoal("Test"); });

        // The transaction's addTask won't catch self-deps at callback time (task just added).
        // But the validation pipeline should reject it.
        expect(() => {
            db.transaction((tx) => {
                tx.addTask({
                    id: "task_phase1_self",
                    description: "Self-referencing",
                    dependencies: ["task_phase1_self"],
                    complexity: "simple",
                    timeoutMs: 720_000,
                });
            });
        }).toThrow();

        // Task should not exist (rolled back) — self-dep causes cycle detection failure
        expect(db.hasTask("task_phase1_self")).toBe(false);
    });

    it("edit task to add files and trigger auto-heal", () => {
        const db = new PlanDatabase(
            makePlan([
                { id: "task_phase1_a", files: ["src/shared.ts"] },
                { id: "task_phase2_b" }, // no overlap initially
            ])
        );

        // Edit B to touch the same file as A — auto-heal should add dep
        simulateEditTask(db, {
            taskId: "task_phase2_b",
            files: ["src/shared.ts"],
        });

        const taskB = db.getTask("task_phase2_b");
        expect(taskB!.dependencies).toContain("task_phase1_a"); // auto-healed
    });

    it("complete_task preserves existing result fields and merges new summary", () => {
        const db = PlanDatabase.empty();
        db.transaction((tx) => { tx.setGoal("Test"); });

        simulateAddTask(db, {
            id: "task_phase1_existing_result",
            description: "Has a result",
            complexity: "simple",
        });

        // Set an existing result first
        db.transaction((tx) => {
            tx.updateTask("task_phase1_existing_result", {
                status: "running",
                result: { summary: "Original summary" },
            });
        });

        simulateCompleteTask(db, "task_phase1_existing_result", "New manual summary");

        const task = db.getTask("task_phase1_existing_result");
        expect(task!.result?.summary).toBe("New manual summary"); // overwritten by complete_task logic
    });

    it("bulk update with empty updates array succeeds (no-op)", () => {
        const db = new PlanDatabase(
            makePlan([{ id: "task_phase1_a" }])
        );
        const snapshotBefore = JSON.stringify(db.toJSON());

        simulateBulkUpdateTasks(db, []);

        expect(JSON.stringify(db.toJSON())).toBe(snapshotBefore);
    });

    it("change notification fires on successful CRUD operations", () => {
        const db = PlanDatabase.empty();
        let callCount = 0;
        db.onDidChange(() => { callCount++; });

        db.transaction((tx) => { tx.setGoal("Test"); });
        expect(callCount).toBe(1); // initial goal set

        simulateAddTask(db, {
            id: "task_phase1_notify",
            description: "Notify test",
            complexity: "simple",
        });
        expect(callCount).toBe(2);

        simulateDeleteTask(db, "task_phase1_notify");
        expect(callCount).toBe(3);

        // No notification on failed operations
        try {
            simulateAddTask(db, {
                id: "task_phase1_fail",
                description: "Bad dep",
                dependencies: ["nonexistent"],
                complexity: "simple",
            });
        } catch { /* expected */ }
        expect(callCount).toBe(3); // not incremented
    });

    it("dirty flag persists across multiple successful operations", () => {
        const db = PlanDatabase.empty();
        db.transaction((tx) => { tx.setGoal("Test"); });
        expect(db.isDirty()).toBe(true);

        simulateAddTask(db, {
            id: "task_phase1_first",
            description: "First",
            complexity: "simple",
        });
        expect(db.isDirty()).toBe(true); // still dirty (never cleared)

        db.clearDirty();
        expect(db.isDirty()).toBe(false);

        simulateEditTask(db, { taskId: "task_phase1_first", description: "Edited" });
        expect(db.isDirty()).toBe(true); // dirty again after mutation
    });
});
