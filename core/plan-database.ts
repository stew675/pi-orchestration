import type { OrchestrationPlan, Task } from "./types";
import { ACTIVE_TASK_STATUSES } from "./types";
import {
    detectCycle,
    detectFileConflicts,
    detectOversizedTasks,
    autoHealFileConflicts,
    healDependenciesOnDelete,
} from "../validation/validation";

// ---------------------------------------------------------------------------
// Deep-clone helper using structuredClone (Node.js 17+)
// ---------------------------------------------------------------------------

/** Create a deep clone of `value`. Uses `structuredClone` for Maps/Sets support. */
function deepClone<T>(value: T): T {
    return structuredClone(value);
}

// ---------------------------------------------------------------------------
// PlanTransaction — mutable working copy inside a transaction callback
// ---------------------------------------------------------------------------

export class PlanTransaction {
    private _goal: string;
    private _currentTaskId: string | undefined;
    private _tasks: Map<string, Task>;
    private _taskOrder: string[];
    private _attributes: Set<string>;

    // Visible to PlanDatabase.commit() only (same module)

    constructor(
        goal: string,
        currentTaskId: string | undefined,
        tasks: Map<string, Task>,
        taskOrder: string[],
        attributes: Set<string>
    ) {
        this._goal = goal;
        this._currentTaskId = currentTaskId;
        // Deep-clone each Task value so mutations in updateTask / validation
        // don't leak into the source database's internal objects.
        const clonedTasks = new Map<string, Task>();
        for (const [id, task] of tasks) {
            clonedTasks.set(id, deepClone(task));
        }
        this._tasks = clonedTasks;
        this._taskOrder = [...taskOrder];
        this._attributes = new Set(attributes);
    }

    // ------------------------------------------------------------------
    // Mutators (operate on working copy)
    // ------------------------------------------------------------------

    setGoal(goal: string): void {
        this._goal = goal;
    }

    setCurrentTaskId(id: string | undefined): void {
        this._currentTaskId = id;
    }

    /** Add a new task. Appends to end of order. */
    addTask(
        task: Omit<Task, "status" | "attempts"> & { status?: Task["status"]; attempts?: number }
    ): void {
        const newTask: Task = {
            id: task.id,
            description: task.description,
            files: task.files || [],
            dependencies: task.dependencies || [],
            status: task.status ?? "pending",
            attempts: task.attempts ?? 0,
            complexity: task.complexity,
            timeoutMs: task.timeoutMs,
            // Optional fields
            taskType: task.taskType,
            result: task.result,
            validatorFeedback: task.validatorFeedback,
            startedAt: task.startedAt,
            clarificationQuery: task.clarificationQuery,
            clarificationAttempts: task.clarificationAttempts,
            clarificationHistory: task.clarificationHistory,
        };

        this._tasks.set(newTask.id, newTask);
        this._taskOrder.push(newTask.id);
    }

    /** Update a single task by merging partial fields into the existing task. */
    updateTask(
        id: string,
        partial: Partial<Pick<
            Task,
            | "description"
            | "files"
            | "dependencies"
            | "status"
            | "result"
            | "validatorFeedback"
            | "complexity"
            | "taskType"
            | "timeoutMs"
            | "startedAt"
            | "clarificationQuery"
            | "clarificationAttempts"
            | "clarificationHistory"
            | "attempts"
        >>
    ): void {
        const existing = this._tasks.get(id);
        if (!existing) {
            throw new Error(`Task ${id} not found`);
        }

        // Shallow merge: only overwrite fields explicitly provided in `partial`.
        for (const [key, value] of Object.entries(partial)) {
            if (value === undefined && key !== "clarificationQuery") {
                // Skip truly omitted optional properties.
                // Exception: clarificationQuery may be intentionally set to undefined.
                continue;
            }
            (existing as unknown as Record<string, unknown>)[key] = value;
        }

        this._tasks.set(id, existing);
    }

    /** Delete a task by ID. Optionally heal dependencies of remaining tasks via {@link healDependenciesOnDelete}. */
    deleteTask(id: string, healDependencies?: boolean): void {
        const existing = this._tasks.get(id);
        if (!existing) return; // silent no-op for missing tasks

        if (healDependencies) {
            // Delegate to shared healing logic (same algorithm as in validation.ts)
            const tasksArr = Array.from(this._tasks.values());
            healDependenciesOnDelete(tasksArr, id);
            // Rebuild map from healed array and remove the deleted task
            for (const t of tasksArr) {
                if (t.id !== id) this._tasks.set(t.id, t);
            }
            this._tasks.delete(id);
        } else {
            this._tasks.delete(id);
        }

        const idx = this._taskOrder.indexOf(id);
        if (idx !== -1) this._taskOrder.splice(idx, 1);

        // Also clear currentTaskId if pointing to deleted task
        if (this._currentTaskId === id) {
            this._currentTaskId = undefined;
        }
    }

    setAttribute(attr: string): void {
        this._attributes.add(attr);
    }

    removeAttribute(attr: string): void {
        this._attributes.delete(attr);
    }

    // ------------------------------------------------------------------
    // Read-only accessors (against working copy)
    // ------------------------------------------------------------------

    getTask(id: string): Task | undefined {
        return this._tasks.get(id);
    }

    getTasks(): Task[] {
        return this._taskOrder.map((id) => this._tasks.get(id)).filter(Boolean) as Task[];
    }

    hasTask(id: string): boolean {
        return this._tasks.has(id);
    }

    // ------------------------------------------------------------------
    // Internal snapshot for commit (module-private)
    // ------------------------------------------------------------------

    /** @internal Build the serializable plan shape from working copy. Accessible to PlanDatabase.commit() via same-module friendship but not intended for external callers. */
    public buildSnapshot(): OrchestrationPlan {
        const tasks = this.getTasks();
        return {
            goal: this._goal,
            currentTaskId: this._currentTaskId,
            tasks,
            attributes: Array.from(this._attributes).length > 0 ? Array.from(this._attributes) : undefined,
        };
    }

    /** @internal Return raw internal state for commit. */
    getSnapshot(): {
        goal: string;
        currentTaskId: string | undefined;
        tasks: Map<string, Task>;
        taskOrder: string[];
        attributes: Set<string>;
    } {
        return {
            goal: this._goal,
            currentTaskId: this._currentTaskId,
            tasks: new Map(this._tasks),
            taskOrder: [...this._taskOrder],
            attributes: new Set(this._attributes),
        };
    }
}

// ---------------------------------------------------------------------------
// PlanDatabase — canonical in-memory plan store with transactional API
// ---------------------------------------------------------------------------

export class PlanDatabase {
    private _goal: string;
    private _currentTaskId: string | undefined;
    private _tasks: Map<string, Task>;
    private _taskOrder: string[];
    private _attributes: Set<string>;
    private _isDirty: boolean = false;
    private _listeners: Array<() => void> = [];

    /** Optional error reporter for listener failures. Set by the persistence layer
     *  so that onDidChange errors are surfaced via the TUI (notifyTui) rather than
     *  swallowed silently or logged to console. */
    static reportError?: (msg: string) => void;

    // ------------------------------------------------------------------
    // Constructors / factories
    // ------------------------------------------------------------------

    /** Deep-clone constructor from an `OrchestrationPlan` (or null for empty). */
    constructor(plan: OrchestrationPlan | null) {
        if (!plan) {
            this._goal = "";
            this._currentTaskId = undefined;
            this._tasks = new Map();
            this._taskOrder = [];
            this._attributes = new Set();
        } else {
            // Deep clone to own data — no shared references with disk JSON.
            const cloned = deepClone(plan);
            this._goal = cloned.goal;
            this._currentTaskId = cloned.currentTaskId;

            this._tasks = new Map<string, Task>();
            this._taskOrder = [];
            for (const task of cloned.tasks || []) {
                this._tasks.set(task.id, deepClone(task));
                this._taskOrder.push(task.id);
            }

            this._attributes = new Set(cloned.attributes || []);
        }
    }

    /** Create from a JSON string. */
    static fromJSON(json: string): PlanDatabase {
        const parsed = JSON.parse(json) as OrchestrationPlan;
        return new PlanDatabase(parsed);
    }

    /** Create an empty database (empty goal, no tasks). */
    static empty(): PlanDatabase {
        return new PlanDatabase(null);
    }

    // ------------------------------------------------------------------
    // Read-only accessors — defensive copies only
    // ------------------------------------------------------------------

    getGoal(): string {
        return this._goal;
    }

    getCurrentTaskId(): string | undefined {
        return this._currentTaskId;
    }

    /** Return a fresh array copy of all tasks in order. Never returns internal references. */
    getTasks(): Task[] {
        const result: Task[] = [];
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (task) result.push(deepClone(task));
        }
        return result;
    }

    /** Return a deep copy of a single task by ID. */
    getTask(id: string): Task | undefined {
        const task = this._tasks.get(id);
        return task ? deepClone(task) : undefined;
    }

    hasTask(id: string): boolean {
        return this._tasks.has(id);
    }

    /** Return a fresh copy of the attributes array. */
    getAttributes(): string[] {
        return [...this._attributes];
    }

    /** Return a copy of the task ID order array. */
    getAllTaskIds(): string[] {
        return [...this._taskOrder];
    }

    // ------------------------------------------------------------------
    // Serialization
    // ------------------------------------------------------------------

    /** Produce an `OrchestrationPlan` shape suitable for JSON serialization (disk format). */
    toJSON(): OrchestrationPlan {
        const tasks = this.getTasks();
        return {
            goal: this._goal,
            currentTaskId: this._currentTaskId,
            tasks,
            attributes: this._attributes.size > 0 ? [...this._attributes] : undefined,
        };
    }

    /** Build a Markdown string for the plan. Accepts optional phase label from state machine. */
    toMarkdown(currentState?: string): string {
        const esc = (text: string) =>
            text.replace(/\\/g, "\\\\").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        const escapeContent = (text: string) =>
            text
                .replace(/\\/g, "\\\\")
                .replace(/(```[\s\S]*?```)/g, (match) => match)
                .replace(/^((?!```).*)$/gm, (line) => line.replace(/</g, "&lt;").replace(/>/g, "&gt;"));

        const lines: string[] = [];

        lines.push(`# Goal: ${esc(this._goal)}\n`);
        lines.push("## Status");
        lines.push(`- **Current Task**: ${this._currentTaskId || "None"}`);
        lines.push(`- **Overall Status**: ${currentState ?? "unknown"}\n`);

        lines.push("## Tasks\n");

        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task) continue;

            const checkbox = task.status === "completed" ? "[x]" : "[ ]";
            lines.push(`- ${checkbox} Task (ID: ${task.id}): ${esc(task.description)}`);
            if (task.files && task.files.length > 0) {
                lines.push(`    - Files: ${task.files.map((f) => `\`${f}\``).join(", ")}`);
            }
            if (task.dependencies && task.dependencies.length > 0) {
                lines.push(`    - Dependencies: ${task.dependencies.join(", ")}`);
            }
            lines.push(`    - Status: ${task.status}`);
            if (task.complexity) {
                lines.push(`    - Complexity: ${task.complexity}`);
            }
            if (task.result?.summary) {
                const safeSummary = escapeContent(task.result.summary);
                lines.push(`    - Result:\n\n${safeSummary}`);
            }
            if (task.status === "failed" && task.validatorFeedback) {
                lines.push(`    - Feedback: ${esc(task.validatorFeedback)}`);
            }
            if (task.status === "awaiting_clarification" && task.clarificationQuery) {
                lines.push(`    - Clarification Needed: ${esc(task.clarificationQuery)}`);
            }
            lines.push("");
        }

        return lines.join("\n");
    }

    /** True if mutations have occurred since last commit or clearDirty call. */
    isDirty(): boolean {
        return this._isDirty;
    }

    /** Clear the dirty flag (called after successful persistence flush). */
    clearDirty(): void {
        this._isDirty = false;
    }

    // ------------------------------------------------------------------
    // Transaction API
    // ------------------------------------------------------------------

    /** Synchronous transaction: deep-clone → callback → validate → commit (or rollback). */
    transaction<T>(fn: (tx: PlanTransaction) => T): T {
        const snapshot = this.getSnapshot();
        const tx = new PlanTransaction(
            snapshot.goal,
            snapshot.currentTaskId,
            new Map(snapshot.tasks),
            [...snapshot.taskOrder],
            new Set(snapshot.attributes)
        );

        // Execute callback — may throw to abort.
        const result = fn(tx);

        // Validate the transaction's accumulated state.
        this.validateTransactionSnapshot(tx.buildSnapshot());

        // Commit: replace internal state with validated snapshot.
        const committed = tx.getSnapshot();
        this._goal = committed.goal;
        this._currentTaskId = committed.currentTaskId;
        this._tasks = new Map(committed.tasks);
        this._taskOrder = [...committed.taskOrder];
        this._attributes = new Set(committed.attributes);
        this._isDirty = true;

        // Notify listeners of change.
        this.notifyListeners();

        return result;
    }


    /** @internal Run the full validation pipeline against a snapshot plan shape. Throws on failure. */
    private validateTransactionSnapshot(plan: OrchestrationPlan): void {
        // 1. Dependency existence checks — all deps reference existing tasks.
        const taskIdSet = new Set(plan.tasks.map((t) => t.id));
        for (const task of plan.tasks) {
            for (const depId of task.dependencies || []) {
                if (!taskIdSet.has(depId)) {
                    throw new Error(
                        `Dependency '${depId}' referenced by task '${task.id}' does not exist`
                    );
                }
            }
        }

        // 2. Cycle detection (must run before any DFS-based ancestor computation).
        const cycle = detectCycle(plan);
        if (cycle) {
            throw new Error(`Circular dependency detected: ${cycle.join(" → ")}`);
        }

        // 3. Auto-heal file conflicts (mutates plan.tasks in place; safe after cycle check).
        autoHealFileConflicts(plan.tasks);

        // 4. File conflict detection (after auto-heal, should be clean).
        const conflicts = detectFileConflicts(plan);
        if (conflicts.length > 0) {
            const details = conflicts
                .map((c) => `  - '${c.file}' touched by [${c.tasks.join(", ")}]`)
                .join("\n");
            throw new Error(`Unresolved file conflicts:\n${details}`);
        }

        // 5. Oversized task detection.
        const oversized = detectOversizedTasks(plan);
        if (oversized.length > 0) {
            const details = oversized
                .map(
                    (o) => `  - '${o.taskId}' (${o.taskType}): ${o.fileCount} files (limit: ${o.limit})`
                )
                .join("\n");
            throw new Error(`Oversized tasks detected:\n${details}`);
        }
    }

    // ------------------------------------------------------------------
    // Domain-specific convenience methods
    // ------------------------------------------------------------------

    /** Reset running/validating/summarizing tasks back to pending. Returns count of recovered tasks. */
    recoverInterruptedTasks(): number {
        let recovered = 0;
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task) continue;
            if (
                task.status === "running" ||
                task.status === "validating" ||
                task.status === "summarizing"
            ) {
                task.status = "pending";
                task.validatorFeedback = undefined;
                recovered++;
            }
        }
        return recovered;
    }

    /** Count tasks by status. */
    countByStatus(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task) continue;
            counts[task.status] = (counts[task.status] || 0) + 1;
        }
        return counts;
    }

    /** Find pending tasks with all dependencies completed. Returns task IDs in order. */
    findReadyTasks(): string[] {
        const ready: string[] = [];
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task || task.status !== "pending") continue;

            const deps = task.dependencies || [];
            const allDepsCompleted = deps.every((depId) => {
                const depTask = this._tasks.get(depId);
                return depTask && depTask.status === "completed";
            });

            if (allDepsCompleted) ready.push(id);
        }
        return ready;
    }

    /** True if all tasks have completed status. */
    allCompleted(): boolean {
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task || task.status !== "completed") return false;
        }
        return this._taskOrder.length > 0;
    }

    /** True if any task has failed status. */
    anyFailed(): boolean {
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task) continue;
            if (task.status === "failed") return true;
        }
        return false;
    }

    /** Get active implementation tasks, optionally excluding summarizing tasks. */
    getActiveImplementationTasks(countingAsyncSummaries: boolean): Task[] {
        const result: Task[] = [];
        for (const id of this._taskOrder) {
            const task = this._tasks.get(id);
            if (!task) continue;
            if (!ACTIVE_TASK_STATUSES.includes(task.status as any)) continue;
            // When async summaries are enabled, summarizing tasks don't count toward the concurrency gate.
            if (countingAsyncSummaries && task.status === "summarizing") continue;
            result.push(deepClone(task));
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Change notification
    // ------------------------------------------------------------------

    /** Subscribe to change notifications. Returns an unsubscribe function. */
    onDidChange(listener: () => void): () => void {
        this._listeners.push(listener);
        return () => {
            this._listeners = this._listeners.filter((l) => l !== listener);
        };
    }

    /** @internal Notify all listeners of a state change.
     *  Listener errors are caught per-listener so one bad listener doesn't
     *  suppress notifications for the rest. Errors are reported via the static
     *  {@link reportError} callback if set (wired by persistence layer).
     */
    private notifyListeners(): void {
        for (const listener of [...this._listeners]) {
            try {
                listener();
            } catch (err) {
                const msg = `[plan-db] onDidChange listener threw: ${String(err)}`;
                PlanDatabase.reportError?.(msg);
            }
        }
    }

    /** @internal Return raw internal state snapshot. Used by transaction(). */
    private getSnapshot(): {
        goal: string;
        currentTaskId: string | undefined;
        tasks: Map<string, Task>;
        taskOrder: string[];
        attributes: Set<string>;
    } {
        return {
            goal: this._goal,
            currentTaskId: this._currentTaskId,
            tasks: new Map(this._tasks),
            taskOrder: [...this._taskOrder],
            attributes: new Set(this._attributes),
        };
    }
}
