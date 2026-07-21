import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StateManager } from "../context/state-manager";
import { Runner, notifyOrchestrator, notifyTuiOnly } from "../runner";
import { killAllProcesses } from "../process/process-manager";
import { OrchestratorState, getPi, NOT_ACTIVE_MSG } from "../core";
import { isActive as stateIsActive, isExecutingMode } from "../core/state-machine";
import { detectFileConflicts, formatFileConflictError } from "../validation/validation";
import type { Task } from "../core/types";
import { ACTIVE_TASK_STATUSES } from "../core/types";
import { signalTaskStarted } from "../process/loop-detector";
import { requireExecutionMode, isBuildTask, sendSilentGuidance } from "./shared";
import { transitionTo, getCurrentOrchestrationState } from "../core/state-machine";

/** Register execution-control tools (ready_tasks, start_task, check_status, replan, resume_task, stop). */
export function registerExecutionControlTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: "orchestrate_ready_tasks",
        label: "Get Ready Tasks",
        description:
            "Returns task IDs categorized by what action is needed: ready to start, already running, or failed and needing recovery.",
        promptSnippet: "Get list of tasks with their readiness status",
        promptGuidelines: [
            "Use orchestrate_ready_tasks to find which task to act on next.",
            "Tasks in 'ready' can be started immediately with orchestrate_start_task.",
            "Tasks in 'running' are already executing - do not start them, wait for completion.",
            "Tasks in 'failed' need recovery: use orchestrate_replan then orchestrate_edit_task."
        ],
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute(_id, _params, _signal, _onUpdate, _ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            requireExecutionMode();
            const plan = OrchestratorState.plan;
            if (!plan) return { content: [{ type: "text", text: "No plan exists." }], details: {} };

            const completedTaskIds = new Set(
                (plan.tasks || []).filter((t: Task) => t.status === "completed").map((t: Task) => t.id)
            );

            const ready: string[] = [];
            const running: string[] = [];
            const failed: string[] = [];

            for (const task of plan.tasks || []) {
                if (task.status === "completed") continue;

                if (ACTIVE_TASK_STATUSES.includes(task.status as string)) {
                    running.push(task.id);
                } else if (task.status === "failed") {
                    failed.push(task.id);
                } else if (task.status === "pending") {
                    const depsSatisfied = (task.dependencies || []).every((depId: string) =>
                        completedTaskIds.has(depId)
                    );
                    if (depsSatisfied) {
                        ready.push(task.id);
                    }
                }
            }

            return {
                content: [
                    {
                        type: "text",
                        text:
                            JSON.stringify({ ready, running, failed }) +
                            (running.length > 0
                                ? `
Note: task(s) ${running.join(", ")} still executing. The system will wake you automatically when complete - do not call any other tools.`
                                : "") +
                            (failed.length > 0
                                ? `
Note: task(s) ${failed.join(", ")} failed. Use orchestrate_replan to enter recovery mode, then fix with orchestrate_edit_task.`
                                : "")
                    }
                ],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_start_task",
        label: "Start Task",
        description:
            "Starts background execution of a specific task. You MUST stop generating and yield control after calling this.",
        promptSnippet: "Starts execution of a task (yields control)",
        promptGuidelines: ["Use orchestrate_start_task to start a task, then STOP generating immediately."],
        parameters: Type.Object({
            taskId: Type.String()
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            if (!isExecutingMode(OrchestratorState.currentState)) {
                throw new Error(
                    "Execution has not been approved yet. Ask the user to run /om-accept before calling orchestrate_start_task."
                );
            }

            const plan = OrchestratorState.plan;
            if (!plan) throw new Error("No plan exists.");

            // Signal that sub-agent execution has begun - loop detection can now activate.
            signalTaskStarted();

            const task = plan.tasks.find((t) => t.id === params.taskId);
            if (!task) throw new Error(`Task '${params.taskId}' not found.`);

            if (task.status === "completed") {
                throw new Error(
                    `Task '${params.taskId}' is already completed. Use orchestrate_edit_task to modify it first.`
                );
            }

            // Pre-flight: validate for file conflicts before starting execution.
            const archived = new Set(StateManager.getArchivedTasks());
            const conflicts = detectFileConflicts(plan, archived);
            if (conflicts.length > 0) {
                throw new Error(
                    `Cannot start task: ${formatFileConflictError(conflicts, "race condition detected in the plan")}\n\n` +
                        `To fix this, ensure that any task modifying a file depends on the task that previously modified it ` +
                        `(use orchestrate_edit_task to add the dependency).`
                );
            }

            // Silent guidance: build/test tasks with no dependencies likely need them
            if (isBuildTask(task.description) && (!task.dependencies || task.dependencies.length === 0)) {
                sendSilentGuidance(
                    `Guidance: '${params.taskId}' appears to be a build/test task but has no dependencies. ` +
                        `Ensure all code-creation tasks are listed as dependencies so files exist before this runs.`
                );
            }

            // Set current task and start implementing
            if (getCurrentOrchestrationState() !== "implementing") {
                if (!transitionTo("implementing")) {
                    throw new Error("Failed to transition to implementing state");
                }
            }
            plan.currentTaskId = task.id;

            Runner.runTasks(getPi()).catch((err) => {
                notifyTuiOnly(pi, "Runner error: " + String(err));
                notifyOrchestrator(
                    getPi(),
                    `System: Task execution failed to start: ${err instanceof Error ? err.message : String(err)}.`
                );
            });

            return {
                content: [
                    { type: "text", text: `Task ${params.taskId} started. Yielding control to background process.` }
                ],
                terminate: true,
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_check_status",
        label: "Check Status",
        description: "Returns a concise status summary of all tasks.",
        promptSnippet: "Check status of tasks",
        promptGuidelines: [
            "Use orchestrate_ready_tasks instead for deciding what to do next. Only use this tool if you need more detail about a specific task's state."
        ],
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, _ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            const plan = OrchestratorState.plan;
            if (!plan) return { content: [{ type: "text", text: "No plan exists." }], details: {} };

            // Return a concise summary - not the full markdown plan
            const lines: string[] = [];
            lines.push(`Goal: ${plan.goal}`);
            lines.push(`Status: ${OrchestratorState.currentState}`);
            for (const task of plan.tasks || []) {
                lines.push(`  ${task.id} [${task.status}]: ${task.description}`);
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_replan",
        label: "Replan",
        description: "Update the plan to recover from a failed task. Modifies tasks to fix issues.",
        promptSnippet: "Update plan to recover from failures",
        promptGuidelines: [
            "Use orchestrate_replan if a task fails. Then use orchestrate_edit_task for surgical fixes, orchestrate_delete_task to remove unwanted items, orchestrate_complete_task to forcibly mark a task as done (e.g., sub-agent timed out but work is verified), orchestrate_add_task for new remediation tasks, then start the revised execution."
        ],
        parameters: Type.Object({
            reason: Type.String()
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            requireExecutionMode();
            const plan = OrchestratorState.plan;
            if (!plan) throw new Error("No plan exists.");

            if (!transitionTo("replanning")) {
                throw new Error("Failed to transition to replanning state");
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Plan shifted to recovery mode. Reason: ${params.reason}. Use orchestrate_edit_task or orchestrate_add_task to build remediation tasks, then orchestrate_start_task.`
                    }
                ],
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_resume_task",
        label: "Resume Task",
        description: "Resumes a task that was paused awaiting clarification.",
        promptSnippet: "Resume a task that is awaiting clarification",
        promptGuidelines: ["Use orchestrate_resume_task to send the answer to a task awaiting clarification."],
        parameters: Type.Object({
            taskId: Type.String(),
            answer: Type.String()
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            if (!isExecutingMode(OrchestratorState.currentState)) {
                throw new Error(
                    "Execution has not been approved yet. " + "Ask the user to run /om-accept before resuming."
                );
            }

            const plan = OrchestratorState.plan;
            if (!plan) throw new Error("No plan exists.");

            const task = plan.tasks.find((t) => t.id === params.taskId);
            if (!task) throw new Error("Task not found.");

            if (task.status !== "awaiting_clarification") {
                throw new Error("Task is not awaiting clarification.");
            }

            // Mark task to resume
            task.status = "pending";
            // Record clarification in history before clearing the pending query
            if (task.clarificationQuery) {
                task.clarificationHistory ??= [];
                task.clarificationHistory.push({ query: task.clarificationQuery, answer: params.answer });
            }
            task.clarificationQuery = undefined;

            // Ensure we're still in implementing state after resume
            const currentState = getCurrentOrchestrationState();
            if (currentState !== "implementing" && currentState !== "paused") {
                transitionTo("implementing");
            }

            // Re-run tasks, passing the clarification data
            Runner.runTasks(getPi(), undefined, {
                taskId: params.taskId,
                answer: params.answer
            }).catch((err) => {
                notifyTuiOnly(pi, "Runner error on resume: " + String(err));
                notifyOrchestrator(
                    getPi(),
                    `System: Failed to resume task '${params.taskId}': ${err instanceof Error ? err.message : String(err)}.`
                );
            });

            return {
                content: [{ type: "text", text: `Task ${params.taskId} resumed with clarification.` }],
                terminate: true,
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_stop",
        label: "Stop",
        description:
            "Immediately halts all running tasks and sub-agents and marks the plan as paused (can be resumed later).",
        promptSnippet: "Halt all sub-agents and pause plan",
        promptGuidelines: [
            "Only use orchestrate_stop as an absolute last resort to halt execution when unrecoverable errors are found and orchestration cannot be remediated and resummed through the use of the other available tool commands. The plan is preserved and can be resumed with /om-resume."
        ],
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute(_id, _params, _signal, _onUpdate, _ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);

            // Block during CODE_REVIEW — remediation must use tasks, not stop.
            if (OrchestratorState.currentState === "code_review") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Cannot stop during CODE_REVIEW. Use orchestrate_add_task + orchestrate_start_task to issue remedial tasks, or orchestrate_complete_review if no action is needed."
                        }
                    ],
                    terminate: false,
                    details: {}
                };
            }

            // When stop is disabled by the user, return a nudge instead of halting.
            if (!OrchestratorState.allowStopTool) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "orchestrate_stop has been disabled by the user. Do not call it again. Please continue to try to find a solution to achieve the project goal."
                        }
                    ],
                    terminate: false,
                    details: {}
                };
            }

            killAllProcesses("SIGKILL");

            const plan = OrchestratorState.plan;
            if (plan) {
                if (!transitionTo("stopped")) {
                    notifyTuiOnly(pi, "Failed to transition to stopped state on stop");
                }
            }

            return {
                content: [{ type: "text", text: "All processes stopped. Plan paused - use /om-resume to continue." }],
                terminate: true,
                details: {}
            };
        }
    });
}
