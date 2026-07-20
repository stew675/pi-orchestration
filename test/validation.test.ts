import { describe, it, expect } from "vitest";
import type { OrchestrationPlan } from "../core/types";
import {
    detectCycle,
    detectFileConflicts,
    detectOversizedTasks,
    formatFileConflictError,
    healDependenciesOnDelete,
    autoHealFileConflicts
} from "../validation/validation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(tasks: Partial<OrchestrationPlan["tasks"][0]>[] = []): OrchestrationPlan {
    return {
        goal: "test",
        status: "planning",
        tasks: tasks.map((t, i) => ({
            id: t.id ?? `task_${i}`,
            description: t.description ?? `Task ${i}`,
            files: t.files ?? [],
            dependencies: t.dependencies ?? [],
            status: t.status ?? ("pending" as const),
            attempts: t.attempts ?? 0,
            complexity: t.complexity ?? "simple",
            timeoutMs: t.timeoutMs ?? 720_000,
            taskType: t.taskType
        }))
    };
}

// ---------------------------------------------------------------------------
// detectCycle
// ---------------------------------------------------------------------------

describe("detectCycle", () => {
    it("returns null for a plan with no dependencies", () => {
        const plan = makePlan([{}, {}, {}]);
        expect(detectCycle(plan)).toBeNull();
    });

    it("returns null for a DAG (no cycles)", () => {
        const plan = makePlan([{ id: "A" }, { id: "B", dependencies: ["A"] }, { id: "C", dependencies: ["A", "B"] }]);
        expect(detectCycle(plan)).toBeNull();
    });

    it("detects a simple two-node cycle (A → B → A)", () => {
        const plan = makePlan([
            { id: "A", dependencies: ["B"] },
            { id: "B", dependencies: ["A"] }
        ]);
        const cycle = detectCycle(plan);
        expect(cycle).not.toBeNull();
        expect(cycle!.length).toBeGreaterThanOrEqual(2);
    });

    it("detects a three-node cycle (A → B → C → A)", () => {
        const plan = makePlan([
            { id: "A", dependencies: ["C"] },
            { id: "B", dependencies: ["A"] },
            { id: "C", dependencies: ["B"] }
        ]);
        const cycle = detectCycle(plan);
        expect(cycle).not.toBeNull();
    });

    it("detects a self-dependency", () => {
        const plan = makePlan([{ id: "A", dependencies: ["A"] }]);
        const cycle = detectCycle(plan);
        expect(cycle).not.toBeNull();
    });

    it("returns null for independent tasks with no edges forming a cycle", () => {
        const plan = makePlan([
            { id: "X" },
            { id: "Y", dependencies: ["Z"] } // Z doesn't exist in task list - adjacency lookup returns undefined → no edge
        ]);
        expect(detectCycle(plan)).toBeNull();
    });

    it("detects cycle even when other unrelated tasks exist", () => {
        const plan = makePlan([
            { id: "A" }, // independent
            { id: "B", dependencies: ["C"] },
            { id: "C", dependencies: ["B"] },
            { id: "D", dependencies: ["A"] } // DAG branch
        ]);
        const cycle = detectCycle(plan);
        expect(cycle).not.toBeNull();
    });

    it("handles empty task list", () => {
        const plan = makePlan([]);
        expect(detectCycle(plan)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// detectFileConflicts
// ---------------------------------------------------------------------------

describe("detectFileConflicts", () => {
    it("returns no conflicts when tasks modify different files", () => {
        const plan = makePlan([
            { id: "A", files: ["a.ts"] },
            { id: "B", files: ["b.ts"] }
        ]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("returns a conflict when two independent tasks modify the same file", () => {
        const plan = makePlan([
            { id: "A", files: ["shared.ts"] },
            { id: "B", files: ["shared.ts"] }
        ]);
        const conflicts = detectFileConflicts(plan);
        expect(conflicts.length).toBe(1);
        expect(conflicts[0].file).toBe("shared.ts");
        expect(conflicts[0].tasks).toContain("A");
        expect(conflicts[0].tasks).toContain("B");
    });

    it("returns no conflict when tasks share a file but have a dependency", () => {
        const plan = makePlan([
            { id: "A", files: ["shared.ts"] },
            { id: "B", dependencies: ["A"], files: ["shared.ts"] }
        ]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("returns no conflict when tasks share a file and dependency is reversed (B depends on A)", () => {
        const plan = makePlan([
            { id: "A", dependencies: ["B"], files: ["shared.ts"] },
            { id: "B", files: ["shared.ts"] }
        ]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("allows two read-only tasks to share a file without conflict", () => {
        const plan = makePlan([
            { id: "A", taskType: "reviewing", files: ["shared.ts"] },
            { id: "B", taskType: "research", files: ["shared.ts"] }
        ]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("conflicts a read-only and a write task sharing a file (no dependency)", () => {
        const plan = makePlan([
            { id: "A", taskType: "reviewing", files: ["shared.ts"] },
            { id: "B", taskType: "editing", files: ["shared.ts"] }
        ]);
        const conflicts = detectFileConflicts(plan);
        expect(conflicts.length).toBe(1);
    });

    it("resolves read-only/write conflict when dependency exists", () => {
        const plan = makePlan([
            { id: "A", taskType: "reviewing", files: ["shared.ts"] },
            { id: "B", dependencies: ["A"], taskType: "editing", files: ["shared.ts"] }
        ]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("excludes archived tasks from conflict detection", () => {
        const plan = makePlan([
            { id: "A", status: "completed", files: ["shared.ts"] },
            { id: "B", files: ["shared.ts"] }
        ]);
        const conflicts = detectFileConflicts(plan, new Set(["A"]));
        expect(conflicts).toEqual([]);
    });

    it("detects conflict among three independent tasks on same file", () => {
        const plan = makePlan([
            { id: "A", files: ["shared.ts"] },
            { id: "B", files: ["shared.ts"] },
            { id: "C", files: ["shared.ts"] }
        ]);
        const conflicts = detectFileConflicts(plan);
        expect(conflicts.length).toBe(1);
        expect(conflicts[0].tasks.length).toBe(3);
    });

    it("handles tasks with no files field", () => {
        const plan = makePlan([{ id: "A" }, { id: "B" }]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("detects transitive dependency resolution (A → B → C, all share file)", () => {
        const plan = makePlan([
            { id: "C", files: ["shared.ts"] },
            { id: "B", dependencies: ["C"], files: ["shared.ts"] },
            { id: "A", dependencies: ["B"], files: ["shared.ts"] }
        ]);
        expect(detectFileConflicts(plan)).toEqual([]);
    });

    it("catches conflict when middle link breaks (A → B, but C independent)", () => {
        const plan = makePlan([
            { id: "C", files: ["shared.ts"] }, // no dependency on A or B
            { id: "B", dependencies: [], files: ["shared.ts"] },
            { id: "A", dependencies: ["B"], files: ["shared.ts"] }
        ]);
        const conflicts = detectFileConflicts(plan);
        expect(conflicts.length).toBe(1); // C has no dependency link to A or B
    });
});

// ---------------------------------------------------------------------------
// detectOversizedTasks
// ---------------------------------------------------------------------------

describe("detectOversizedTasks", () => {
    it("flags a creation task with 3 files (limit is 2)", () => {
        const plan = makePlan([{ id: "A", taskType: "creation", files: ["a.ts", "b.ts", "c.ts"] }]);
        const oversized = detectOversizedTasks(plan);
        expect(oversized.length).toBe(1);
        expect(oversized[0].taskId).toBe("A");
        expect(oversized[0].fileCount).toBe(3);
        expect(oversized[0].limit).toBe(2);
    });

    it("allows a creation task with exactly 2 files", () => {
        const plan = makePlan([{ id: "A", taskType: "creation", files: ["a.ts", "b.ts"] }]);
        expect(detectOversizedTasks(plan)).toEqual([]);
    });

    it("allows a building task with any number of files (exempt)", () => {
        const plan = makePlan([{ id: "A", taskType: "building", files: ["a.ts", "b.ts", "c.ts", "d.ts"] }]);
        expect(detectOversizedTasks(plan)).toEqual([]);
    });

    it("allows reviewing and research tasks with any number of files (exempt)", () => {
        const plan = makePlan([
            { id: "A", taskType: "reviewing", files: ["a.ts", "b.ts", "c.ts"] },
            { id: "B", taskType: "research", files: ["x.md", "y.md", "z.md", "w.md"] }
        ]);
        expect(detectOversizedTasks(plan)).toEqual([]);
    });

    it("flags an 'other' task with 3 files (limit is 2)", () => {
        const plan = makePlan([{ id: "A", taskType: "other", files: ["a.ts", "b.ts", "c.ts"] }]);
        expect(detectOversizedTasks(plan).length).toBe(1);
    });

    it("defaults to 'other' when taskType is missing", () => {
        const plan = makePlan([
            { id: "A", files: ["a.ts", "b.ts", "c.ts"] } // no taskType → defaults to "other" (limit 2)
        ]);
        expect(detectOversizedTasks(plan).length).toBe(1);
    });

    it("handles empty plan", () => {
        const plan = makePlan([]);
        expect(detectOversizedTasks(plan)).toEqual([]);
    });

    it("flags multiple oversized tasks in one pass", () => {
        const plan = makePlan([
            { id: "A", taskType: "creation", files: ["a.ts", "b.ts", "c.ts"] },
            { id: "B", taskType: "editing", files: ["x.ts", "y.ts", "z.ts"] }
        ]);
        const oversized = detectOversizedTasks(plan);
        expect(oversized.length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// formatFileConflictError
// ---------------------------------------------------------------------------

describe("formatFileConflictError", () => {
    it("formats a single conflict", () => {
        const conflicts = [{ file: "foo.ts", tasks: ["A", "B"] }];
        const msg = formatFileConflictError(conflicts);
        expect(msg).toContain("Race condition detected");
        expect(msg).toContain("foo.ts");
        expect(msg).toContain("[A, B]");
    });

    it("formats multiple conflicts", () => {
        const conflicts = [
            { file: "a.ts", tasks: ["X", "Y"] },
            { file: "b.ts", tasks: ["P", "Q", "R"] }
        ];
        const msg = formatFileConflictError(conflicts);
        expect(msg).toContain("a.ts");
        expect(msg).toContain("b.ts");
    });

    it("uses custom prefix when provided", () => {
        const conflicts = [{ file: "x.ts", tasks: ["A"] }];
        const msg = formatFileConflictError(conflicts, "Custom error");
        expect(msg).toContain("Custom error");
    });
});

// ---------------------------------------------------------------------------
// healDependenciesOnDelete
// ---------------------------------------------------------------------------

describe("healDependenciesOnDelete", () => {
    it("performs transitive dependency bypass on simple deletion", () => {
        // X -> A -> B. Delete A without replacements. B should inherit X.
        const plan = makePlan([
            { id: "X" },
            { id: "A", dependencies: ["X"] },
            { id: "B", dependencies: ["A"] }
        ]);

        healDependenciesOnDelete(plan.tasks, "A", []);

        const taskB = plan.tasks.find(t => t.id === "B");
        expect(taskB).toBeDefined();
        expect(taskB!.dependencies).toEqual(["X"]);
    });

    it("performs replacement-aware dependency transfer", () => {
        // A -> B. Add A_new as replacement for A. B should depend on A_new.
        const plan = makePlan([
            { id: "A" },
            { id: "B", dependencies: ["A"] }
        ]);

        healDependenciesOnDelete(plan.tasks, "A", ["A_new"]);

        const taskB = plan.tasks.find(t => t.id === "B");
        expect(taskB).toBeDefined();
        expect(taskB!.dependencies).toEqual(["A_new"]);
    });

    it("performs split task transfer (1-to-many replacement)", () => {
        // A -> B. A split into A_1 and A_2. B should depend on both.
        const plan = makePlan([
            { id: "A" },
            { id: "B", dependencies: ["A"] }
        ]);

        healDependenciesOnDelete(plan.tasks, "A", ["A_1", "A_2"]);

        const taskB = plan.tasks.find(t => t.id === "B");
        expect(taskB).toBeDefined();
        expect(taskB!.dependencies).toContain("A_1");
        expect(taskB!.dependencies).toContain("A_2");
        expect(taskB!.dependencies.length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// autoHealFileConflicts
// ---------------------------------------------------------------------------

describe("autoHealFileConflicts", () => {
    it("automatically heals file conflict between two write-based tasks by adding a dependency edge based on array index order", () => {
        const plan = makePlan([
            { id: "A", files: ["src/foo.ts"] },
            { id: "B", files: ["src/foo.ts"] }
        ]);

        autoHealFileConflicts(plan.tasks);

        const taskB = plan.tasks.find(t => t.id === "B");
        expect(taskB).toBeDefined();
        expect(taskB!.dependencies).toEqual(["A"]);
    });

    it("does not inject dependency between two read-only tasks sharing a file", () => {
        const plan = makePlan([
            { id: "A", taskType: "reviewing", files: ["src/foo.ts"] },
            { id: "B", taskType: "research", files: ["src/foo.ts"] }
        ]);

        autoHealFileConflicts(plan.tasks);

        const taskB = plan.tasks.find(t => t.id === "B");
        expect(taskB).toBeDefined();
        expect(taskB!.dependencies).toEqual([]);
    });
});
