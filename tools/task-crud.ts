import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { StateManager } from "../context/state-manager";
import { Runner } from "../runner";
import { activeProcesses } from "../process/process-manager";
import { OrchestratorState, NOT_ACTIVE_MSG } from "../core";
import { isActive as stateIsActive } from "../core/state-machine";
import type { Task, TaskType } from "../core/types";
import { healDependenciesOnDelete } from "../validation/validation";
import {
    validatePlan,
    clampTaskTimeout,
    isBuildTask,
    requireTaskCrudPrereqs,
    sendSilentGuidance,
    validateAddTask,
    validateEditTask,
    validateDeleteTask
} from "./shared";

/** Task ID naming convention prefix. */
const TASK_ID_PREFIX = "task_phase";

/** Register task CRUD tools (add_task, delete_task, complete_task, edit_task, get_plan). */
export function registerTaskCrudTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: "orchestrate_add_task",
        label: "Add Task",
        description:
            "Append a single task to the plan. Call this once per task. " +
            "Task IDs must match 'task_phaseN_title'. Each task: max 2 files (creation/editing), " +
            "single focused concern, explicit item names in description (never vague phrases like 'all algorithms'). " +
            "Read-only types (reviewing/research) get only read tools and skip summarization.",
        promptSnippet: "Add a task to the plan",
        promptGuidelines: [
            "Call orchestrate_add_task to add tasks incrementally to build the plan.",
            "If you realize a task is no longer needed or was incorrect, use orchestrate_delete_task to remove it.",
            "Tasks like creating Makefiles/CMakefiles or similar, writing documentation, or building/running executables are always dependent upon any code creation tasks completing first"
        ],
        parameters: Type.Object({
            goal: Type.Optional(
                Type.String({
                    description: "Project goal string"
                })
            ),
            id: Type.String({
                description:
                    "Unique task ID. Must follow naming convention 'task_phaseN_title' (e.g., task_phase1_headers). " +
                    "First 10 characters must be 'task_phase', then a phase number, then a short title."
            }),
            description: Type.String({
                description:
                    "Highly focused single-concern description with clear definition of done. " +
                    "List specific items explicitly (e.g., exact function names, file paths). " +
                    "Never use vague phrases like 'all algorithms', 'everything remaining', or 'fix all warnings'. " +
                    "For build/compile/test tasks: instruct the sub-agent to write results to a file (e.g., test_results.txt) so the validator can verify completion."
            }),
            files: Type.Array(Type.String(), {
                description:
                    "Files this task modifies/reads. Max 2 for creation/editing types (prefer 1). " +
                    "Exempt from limit: building, administrative, research, reviewing."
            }),
            dependencies: Type.Array(Type.String(), {
                description:
                    "IDs of tasks that create or modify files this task needs. " +
                    "Build/compile/test tasks MUST list ALL code-creation tasks as dependencies. " +
                    "Never leave empty for file-operating tasks - causes data races with parallel execution."
            }),
            complexity: StringEnum(["simple", "complex"]),
            taskType: Type.Optional(
                StringEnum(["creation", "editing", "building", "administrative", "research", "reviewing", "other"], {
                    description:
                        "Task type determines file-count limits. creation→max 2, editing→max 2, building/administrative/research/reviewing→exempt, other→max 2 (default)"
                })
            ),
            timeoutMs: Type.Optional(
                Type.Number({
                    description:
                        "Per-task watchdog timeout in ms. Must be >= the configured default; values below that are silently raised to the default. Capped at 2× the configured default."
                })
            ),
            replacesTaskId: Type.Optional(
                Type.String({
                    description: "Optionally specify the ID of the task this new task is replacing/splitting. If specified, dependents of the old task will be re-routed to this new task, and the old task will be deleted."
                })
            )
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            requireTaskCrudPrereqs();

            // Enforce task naming convention: must start with TASK_ID_PREFIX
            if (!params.id.startsWith(TASK_ID_PREFIX)) {
                throw new Error(
                    `Invalid task ID '${params.id}'. Task IDs must follow the naming convention 'task_phaseN_title' (e.g., task_phase1_headers). ` +
                        `The first 10 characters must be "${TASK_ID_PREFIX}", followed by a phase number and a short title.`
                );
            }

            let plan = StateManager.loadPlan();

            const effectiveTimeout = clampTaskTimeout(params.timeoutMs);

            // --- Pre-mutation validation (before any in-memory change) ---
            if (plan) {
                try {
                    const existingTaskIds = new Set(plan.tasks.map((t: Task) => t.id));

                    const existingTask = plan.tasks.find((t) => t.id === params.id);
                    if (existingTask) {
                        throw new Error(`Task '${params.id}' already exists.`);
                    }

                    // Validate dependencies exist, then simulate full structural checks.
                    await validateAddTask(existingTaskIds, params.id, params.dependencies || []);

                    // Build a simulated plan (existing tasks + new task) for cycle/conflict/oversized checks.
                    const newTask: Task = {
                        id: params.id,
                        description: params.description,
                        files: params.files || [],
                        dependencies: params.dependencies || [],
                        status: "pending" as const,
                        attempts: 0,
                        complexity: params.complexity as "simple" | "complex",
                        taskType: (params.taskType as TaskType) || undefined,
                        timeoutMs: effectiveTimeout
                    };

                    const simulatedTasks = JSON.parse(JSON.stringify(plan.tasks)) as Task[];
                    simulatedTasks.push(newTask);

                    if (params.replacesTaskId) {
                        healDependenciesOnDelete(simulatedTasks, params.replacesTaskId, [params.id]);
                        const oldIdx = simulatedTasks.findIndex(t => t.id === params.replacesTaskId);
                        if (oldIdx !== -1) {
                            simulatedTasks.splice(oldIdx, 1);
                        }
                    }

                    const simulatedPlan = { ...plan, tasks: simulatedTasks };
                    await validatePlan(simulatedPlan, new Set(StateManager.getArchivedTasks()));

                    // All checks passed - safe to mutate.
                    if (params.replacesTaskId) {
                        healDependenciesOnDelete(plan.tasks, params.replacesTaskId, [params.id]);
                        const oldIdx = plan.tasks.findIndex(t => t.id === params.replacesTaskId);
                        if (oldIdx !== -1) {
                            plan.tasks.splice(oldIdx, 1);
                        }
                    }
                    plan.tasks.push(newTask);
                } catch (e) {
                    throw new Error(
                        `Task '${params.id}' was NOT added. The plan is unchanged.\n\nReason: ${(e as Error).message}`
                    );
                }
            } else {
                if (!params.goal || !params.goal.trim()) {
                    throw new Error("goal is required for the first task. Pass the project goal string.");
                }
                const newTask: Task = {
                    id: params.id,
                    description: params.description,
                    files: params.files || [],
                    dependencies: params.dependencies || [],
                    status: "pending" as const,
                    attempts: 0,
                    complexity: params.complexity as "simple" | "complex",
                    taskType: (params.taskType as TaskType) || undefined,
                    timeoutMs: effectiveTimeout
                };
                plan = {
                    goal: params.goal.trim(),
                    status: "planning" as const,
                    tasks: [newTask]
                };
            }

            StateManager.savePlan(plan);

            // --- Silent guidance (model sees it, user doesn't) ---
            const warnings: string[] = [];

            // Vague description check
            const vaguePatterns = [
                /\ball\b.*(?:algorithms|functions|items|cases)/i,
                /everything/i,
                /the rest/i,
                /fix all/i,
                /all remaining/i,
                /remaining work/i,
                /as needed/i
            ];
            const matchedVague = vaguePatterns.find((p) => p.test(params.description));
            if (matchedVague) {
                warnings.push(
                    `Guidance: task '${params.id}' description uses broad language matching "${matchedVague.source}". ` +
                        `The sub-agent will implement literally what you describe - list specific items explicitly (e.g., exact function names, file paths).`
                );
            }

            // Empty dependencies check for non-read-only tasks
            const taskType = (params.taskType as TaskType) || "other";
            if (!params.dependencies || params.dependencies.length === 0) {
                const isReadOnly = taskType === "reviewing" || taskType === "research";
                if (!isReadOnly && (params.files?.length ?? 0) > 0) {
                    warnings.push(
                        `Guidance: task '${params.id}' has no dependencies but modifies files. ` +
                            `If it operates on files created by other tasks, add those task IDs as dependencies to prevent data races.`
                    );
                }
            }

            // Build/test task without artifact instruction check
            const isBuildLike = isBuildTask(params.description);
            if (
                isBuildLike &&
                !params.description.toLowerCase().includes("write") &&
                !params.description.toLowerCase().includes("log")
            ) {
                warnings.push(
                    `Guidance: '${params.id}' appears to be a build/test task. ` +
                        `Instruct the sub-agent to write test results or build logs to a file (e.g., test_results.txt). ` +
                        `The validator can only verify completion by reading files - stdout claims are truncated and insufficient.`
                );
            }

            if (warnings.length > 0) {
                sendSilentGuidance(warnings.join("\n"));
            }

            return {
                content: [
                    { type: "text", text: `Task '${params.id}' added to plan. Continue adding tasks as needed.` }
                ],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_delete_task",
        label: "Delete Task",
        description: "Remove a single task from the plan. Only works on pending, failed, or completed tasks.",
        promptSnippet: "Delete a task from the plan",
        promptGuidelines: [
            "Use orchestrate_delete_task to remove an unwanted or obsolete task. Cannot delete running, validating, or awaiting_clarification tasks."
        ],
        parameters: Type.Object({
            taskId: Type.String({ description: "The ID of the task to delete" })
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            requireTaskCrudPrereqs();
            const plan = StateManager.loadPlan();
            if (!plan) throw new Error("No plan exists.");

            try {
                const taskIndex = (plan.tasks || []).findIndex((t) => t.id === params.taskId);
                if (taskIndex === -1) {
                    throw new Error(`Task '${params.taskId}' not found.`);
                }

                const task = plan.tasks[taskIndex];
                const deletableStates = ["pending", "failed", "completed"];
                if (!deletableStates.includes(task.status)) {
                    throw new Error(`Cannot delete task '${params.taskId}' while it is '${task.status}'.`);
                }

                // Auto-heal dependents by bypassing the deleted task cleanly
                healDependenciesOnDelete(plan.tasks, params.taskId, []);

                plan.tasks.splice(taskIndex, 1);
            } catch (e) {
                throw new Error(
                    `Task '${params.taskId}' was NOT deleted. The plan is unchanged.\n\nReason: ${(e as Error).message}`
                );
            }

            StateManager.savePlan(plan);

            return {
                content: [{ type: "text", text: `Task '${params.taskId}' deleted.` }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_complete_task",
        label: "Complete Task",
        description:
            "Forcibly mark a task as completed, regardless of its current state. Use when work was done but the sub-agent timed out or crashed.",
        promptSnippet: "Mark a task as complete without re-running it",
        promptGuidelines: [
            "Use orchestrate_complete_task when you have verified that a task's work is actually done (e.g., files exist, tests pass) even though the sub-agent timed out or crashed.",
            "This bypasses validation - only use when you are confident the work is correct.",
            "Provide a summary of what was accomplished so downstream tasks have context."
        ],
        parameters: Type.Object({
            taskId: Type.String({ description: "The ID of the task to mark as complete" }),
            summary: Type.Optional(
                Type.String({
                    description: "A brief summary of what was accomplished (files created, APIs exposed, etc.)"
                })
            )
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            requireTaskCrudPrereqs();
            const plan = StateManager.loadPlan();
            if (!plan) throw new Error("No plan exists.");

            const task = plan.tasks.find((t) => t.id === params.taskId);
            if (!task) {
                throw new Error(`Task '${params.taskId}' not found.`);
            }

            const oldStatus = task.status;
            // If the task is currently running, kill its specific process
            if (task.status === "running" || task.status === "validating") {
                for (const [child, info] of activeProcesses.entries()) {
                    const labelParts = info.label.split(" ");
                    if (labelParts.includes(params.taskId)) {
                        try {
                            child.kill();
                        } catch {
                            /* ignore */
                        }
                    }
                }
            }

            // Cancel any in-flight summary if we forcefully complete it
            Runner.cancelTaskSummary(params.taskId);

            task.status = "completed";
            task.clarificationAttempts = 0;
            task.validatorFeedback = undefined;
            task.result = {
                ...(task.result || {}),
                summary: params.summary || "Task forcibly marked as complete by orchestrator.",
                manuallyCompleted: true
            };

            StateManager.savePlan(plan);

            return {
                content: [{ type: "text", text: `Task '${params.taskId}' marked as completed (was: ${oldStatus}).` }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_edit_task",
        label: "Edit Task",
        description: "Update a specific task's description, files, or dependencies. Resets that task to 'pending'.",
        promptSnippet: "Modify a single task in the plan",
        promptGuidelines: ["Use orchestrate_edit_task for surgical changes to a failing task."],
        parameters: Type.Object({
            taskId: Type.String({ description: "The ID of the task to edit" }),
            description: Type.Optional(Type.String()),
            files: Type.Optional(Type.Array(Type.String())),
            dependencies: Type.Optional(Type.Array(Type.String())),
            complexity: Type.Optional(StringEnum(["simple", "complex"])),
            taskType: Type.Optional(
                StringEnum(["creation", "editing", "building", "administrative", "research", "reviewing", "other"])
            ),
            timeoutMs: Type.Optional(
                Type.Number({
                    description:
                        "Per-task watchdog timeout in ms. Must be >= the configured default; values below that are silently raised to the default. Capped at 2× the configured default."
                })
            )
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            requireTaskCrudPrereqs();
            const plan = StateManager.loadPlan();
            if (!plan) throw new Error("No plan exists.");

            const task = plan.tasks.find((t) => t.id === params.taskId);
            if (!task) throw new Error(`Task '${params.taskId}' not found.`);

            try {
                // --- Pre-mutation validation (before any in-memory change) ---
                const existingTaskIds = new Set(plan.tasks.map((t: Task) => t.id));
                await validateEditTask(existingTaskIds, params.dependencies);

                // Build a simulated plan with the proposed edits for structural checks.
                const editedTask: Task = {
                    ...task,
                    description: params.description ?? task.description,
                    files: params.files ?? task.files,
                    dependencies: params.dependencies ?? task.dependencies,
                    complexity: params.complexity ?? task.complexity,
                    taskType: (params.taskType as TaskType) ?? task.taskType
                };
                if (params.timeoutMs !== undefined) {
                    editedTask.timeoutMs = clampTaskTimeout(params.timeoutMs);
                }
                const simulatedPlan: any = {
                    ...plan,
                    tasks: plan.tasks.map((t) => (t.id === params.taskId ? editedTask : t))
                };
                await validatePlan(simulatedPlan, new Set(StateManager.getArchivedTasks()));

                // All checks passed - safe to mutate.
                if (params.description !== undefined) task.description = params.description;
                if (params.files !== undefined) task.files = params.files;
                if (params.dependencies !== undefined) task.dependencies = params.dependencies;
                if (params.complexity !== undefined) task.complexity = params.complexity as "simple" | "complex";
                if (params.taskType !== undefined) task.taskType = params.taskType as TaskType;

                // Clamp timeout: floor = configured default, ceiling = 2× default
                if (params.timeoutMs !== undefined) {
                    task.timeoutMs = clampTaskTimeout(params.timeoutMs);
                }

                task.status = "pending";
                task.attempts = 0;
            } catch (e) {
                throw new Error(
                    `Task '${params.taskId}' was NOT edited. The plan is unchanged.\n\nReason: ${(e as Error).message}`
                );
            }

            StateManager.savePlan(plan);

            return {
                content: [{ type: "text", text: `Task '${params.taskId}' updated and reset to pending.` }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_get_plan",
        label: "Get Plan",
        description: "Returns the current orchestration plan in markdown format.",
        promptSnippet: "Returns the current orchestration plan in markdown format",
        promptGuidelines: ["Use orchestrate_get_plan to view the current orchestration state before updating."],
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute(_id, _params, _signal, _onUpdate, _ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);

            const md = StateManager.getMarkdownPlan();
            if (!md) return { content: [{ type: "text", text: "No plan exists yet." }], details: {} };

            return {
                content: [{ type: "text", text: md }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_bulk_update_tasks",
        label: "Bulk Update Tasks",
        description: "Perform multiple plan modifications (add, delete, edit tasks) in a single transactional step. Essential during replanning.",
        parameters: Type.Object({
            updates: Type.Array(
                Type.Object({
                    action: StringEnum(["add", "delete", "edit"]),
                    id: Type.String({ description: "Task ID (e.g., task_phase1_fixed_headers)" }),
                    description: Type.Optional(Type.String()),
                    files: Type.Optional(Type.Array(Type.String())),
                    dependencies: Type.Optional(Type.Array(Type.String())),
                    complexity: Type.Optional(StringEnum(["simple", "complex"])),
                    taskType: Type.Optional(StringEnum(["creation", "editing", "building", "administrative", "research", "reviewing", "other"])),
                    timeoutMs: Type.Optional(Type.Number()),
                    replacesTaskId: Type.Optional(Type.String({ description: "For 'add' action, optionally specify the ID of the task this new task is replacing/splitting." }))
                })
            )
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            requireTaskCrudPrereqs();
            let plan = StateManager.loadPlan();
            if (!plan) throw new Error("No active plan found to bulk update.");

            const simulatedTasks = JSON.parse(JSON.stringify(plan.tasks)) as Task[];

            // Track replacements to apply them transactionally
            const replacements = new Map<string, string[]>(); // oldTaskId -> newTaskId[]

            for (const update of params.updates) {
                if (update.action === "add") {
                    if (simulatedTasks.some(t => t.id === update.id)) {
                        throw new Error(`Bulk add failed: Task '${update.id}' already exists.`);
                    }
                    if (!update.id.startsWith(TASK_ID_PREFIX)) {
                        throw new Error(`Invalid task ID '${update.id}' in bulk add. Must start with '${TASK_ID_PREFIX}'.`);
                    }
                    simulatedTasks.push({
                        id: update.id,
                        description: update.description || "",
                        files: update.files || [],
                        dependencies: update.dependencies || [],
                        status: "pending" as const,
                        attempts: 0,
                        complexity: (update.complexity as "simple" | "complex") || "complex",
                        taskType: (update.taskType as TaskType) || "other",
                        timeoutMs: clampTaskTimeout(update.timeoutMs)
                    });

                    if (update.replacesTaskId) {
                        if (!replacements.has(update.replacesTaskId)) {
                            replacements.set(update.replacesTaskId, []);
                        }
                        replacements.get(update.replacesTaskId)!.push(update.id);
                    }
                } else if (update.action === "delete") {
                    const idx = simulatedTasks.findIndex(t => t.id === update.id);
                    if (idx === -1) {
                        throw new Error(`Bulk delete failed: Task '${update.id}' not found.`);
                    }
                    simulatedTasks.splice(idx, 1);
                    // Standard dependency clean up
                    for (const t of simulatedTasks) {
                        t.dependencies = t.dependencies.filter(dep => dep !== update.id);
                    }
                } else if (update.action === "edit") {
                    const task = simulatedTasks.find(t => t.id === update.id);
                    if (!task) {
                        throw new Error(`Bulk edit failed: Task '${update.id}' not found.`);
                    }
                    if (update.description !== undefined) task.description = update.description;
                    if (update.files !== undefined) task.files = update.files;
                    if (update.dependencies !== undefined) task.dependencies = update.dependencies;
                    if (update.complexity !== undefined) task.complexity = update.complexity as "simple" | "complex";
                    if (update.taskType !== undefined) task.taskType = update.taskType as TaskType;
                    if (update.timeoutMs !== undefined) task.timeoutMs = clampTaskTimeout(update.timeoutMs);
                }
            }

            // Apply all replacement transfers
            for (const [oldId, newIds] of replacements.entries()) {
                healDependenciesOnDelete(simulatedTasks, oldId, newIds);
                const oldIdx = simulatedTasks.findIndex(t => t.id === oldId);
                if (oldIdx !== -1) {
                    simulatedTasks.splice(oldIdx, 1);
                }
            }

            // Run full validations on the simulated graph
            const simulatedPlan = { ...plan, tasks: simulatedTasks };
            await validatePlan(simulatedPlan, new Set(StateManager.getArchivedTasks()));

            // Success: Commit the transaction
            plan.tasks = simulatedTasks;
            StateManager.savePlan(plan);

            return {
                content: [{ type: "text", text: `Bulk update transaction completed successfully. Modified ${params.updates.length} task(s).` }],
                details: {}
            };
        }
    });
}
