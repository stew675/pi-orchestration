import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef, Task } from "../core/types";
import { MAX_CLARIFICATIONS, isTaskReadOnly } from "../core/types";
import { OrchestratorState, resolveTaskModelByComplexity, resolveValidatorModel, resolveSummaryModel, getPlanDb } from "../core";
import type { PlanTransaction } from "../core/plan-database";
import { PersistenceManager } from "../context/persistence";
import { buildTaskContext } from "../context/context-builder";
import * as monitor from "../process/monitor";
import { notifyOrchestrator, notifyTuiOnly } from "./utils";
import { runSubAgent } from "./subagent-spawner";
import type { SubAgentResult } from "./subagent-spawner";
import { validateTask } from "./validator";
import { completeTaskWithSummary } from "./summarizer";
import { processTaskResult as postProcessTaskResult } from "./post-processor";
import { formatTimeout } from "../settings/time-utils";
import { transitionTo, getCurrentOrchestrationState } from "../core/state-machine";
import { refreshUiStatus } from "../ui/ui";

/**
 * Execute a single task. Returns true to continue the loop, false to stop.
 */
export async function executeTask(
    task: Task,
    model?: ModelRef,
    clarificationData?: { taskId: string; answer: string },
    pi?: ExtensionAPI
): Promise<boolean> {
    try {
        // Skip tasks in terminal/non-executable states
        if (["completed", "awaiting_clarification", "failed"].includes(task.status)) return true;

        // When resuming after clarification, check status
        if (clarificationData && clarificationData.taskId !== task.id) {
            const planDb = getPlanDb();
            if (planDb) {
                const refreshedTask = planDb.getTask(task.id);
                if (refreshedTask && refreshedTask.status === "completed") return true;
            }
        }

        // Hard stop check (before any mutation)
        const currentState = getCurrentOrchestrationState();
        if (currentState === "paused" || currentState === "failed") {
            return false;
        }

        const planDb = getPlanDb();
        if (!planDb) return false;

        // Verify task exists in the database
        if (!planDb.hasTask(task.id)) return false;

        // Mark task as running and set current task id via transaction
        planDb.transaction((tx: PlanTransaction) => {
            tx.updateTask(task.id, { status: "running", startedAt: Date.now() });
            tx.setCurrentTaskId(task.id);
        });

        // Inform user via UI
        pi?.sendMessage(
            {
                customType: "orchestrator_event",
                content: `System: Executing task '${task.id}': ${task.description}`,
                display: false
            },
            { deliverAs: "nextTurn" }
        );

        // Resolve the model for this specific task based on its complexity annotation.
        // When in doubt (unknown/missing complexity), default to complex.
        const taskModel = resolveTaskModelByComplexity(task.complexity ?? "complex", model);

        await runTaskSubAgent(task, taskModel, clarificationData, pi);

        // Post-task processing
        return postProcessTaskResult(task, pi);
    } catch (e) {
        notifyTuiOnly(pi || OrchestratorState.pi || (await import("../core")).getPi(), `Error executing task ${task.id}: ${String(e)}`);

        // Reset orphaned task status so scheduler can retry on next cycle.
        try {
            const planDb = getPlanDb();
            if (planDb && planDb.hasTask(task.id)) {
                planDb.transaction((tx: PlanTransaction) => {
                    const t = tx.getTask(task.id);
                    if (t && t.status === "running") {
                        tx.updateTask(task.id, { status: "pending", attempts: (t.attempts ?? 0) + 1, startedAt: undefined });
                        notifyTuiOnly(pi || OrchestratorState.pi, `Task ${task.id} reset from 'running' to 'pending' after unexpected error.`);
                    }
                });
            }
        } catch (resetErr) {
            notifyTuiOnly(pi || OrchestratorState.pi, `Failed to reset task ${task.id} status: ${String(resetErr)}`);
        }

        if (pi) {
            notifyOrchestrator(
                pi,
                `System: Internal error executing task '${task.id}': ${e instanceof Error ? e.message : String(e)}`
            );
        }
        return false;
    }
}

/** Handle clarification request from sub-agent. Returns true if caller should stop processing. */
function handleClarification(taskId: string, clarificationFile: string): boolean {
    const planDb = getPlanDb();
    if (!planDb) return false;

    if (!fs.existsSync(clarificationFile)) return false;

    try {
        const cContent = fs.readFileSync(clarificationFile, "utf-8").trim();
        if (!cContent) return false;

        const cData = JSON.parse(cContent);
        if (!(cData && typeof cData === "object" && typeof cData.query === "string")) return false;

        // Perform clarification logic inside a transaction for atomicity
        planDb.transaction((tx: PlanTransaction) => {
            const t = tx.getTask(taskId);
            if (!t) return;

            const newAttempts = (t.clarificationAttempts || 0) + 1;

            if (newAttempts > MAX_CLARIFICATIONS) {
                const elapsed = t.startedAt ? `${((Date.now() - t.startedAt) / 1000).toFixed(0)}s` : "?";
                tx.updateTask(taskId, {
                    status: "failed",
                    clarificationAttempts: newAttempts,
                    validatorFeedback: `Task requested clarification ${newAttempts} times (max ${MAX_CLARIFICATIONS}). Aborting. (ran for ${elapsed})`
                });
            } else {
                tx.updateTask(taskId, {
                    status: "awaiting_clarification",
                    clarificationQuery: cData.query,
                    clarificationAttempts: newAttempts
                });
            }
        });
    } catch (e) {
        planDb.transaction((tx: PlanTransaction) => {
            tx.updateTask(taskId, {
                status: "failed",
                validatorFeedback: `Sub-agent attempted to write clarification but the file was invalid/malformed: ${(e as Error).message}`
            });
        });
    }

    return true; // caller should stop regardless of outcome
}

/** Handle successful (code 0) sub-agent exit. Routes through validation and summarization. */
async function handleSuccessfulExit(taskId: string, procResult: SubAgentResult, model?: ModelRef): Promise<void> {
    const planDb = getPlanDb();
    if (!planDb) return;

    // Guard: process exited cleanly but produced no assistant output (LLM may have crashed)
    if (!procResult.receivedAssistantMessage) {
        planDb.transaction((tx: PlanTransaction) => {
            const t = tx.getTask(taskId);
            if (!t) return;
            const elapsed = t.startedAt != null ? ((Date.now() - t.startedAt) / 1000).toFixed(0) : "?";
            const output = monitor.getCapturedLines(t.id);
            tx.updateTask(taskId, {
                status: "failed",
                validatorFeedback: `Sub-agent process exited with code 0 but produced no assistant output (LLM may have crashed). Ran for ${elapsed}s.${output ? "\n\n" + output : ""}`
            });
        });
        return;
    }

    // Read task metadata from a snapshot to determine validation path.
    const t = planDb.getTask(taskId);
    if (!t) return;

    const isReadOnly = isTaskReadOnly(t.taskType);

    // Determine whether this task needs validation
    const shouldValidate =
        isReadOnly ||
        (t.complexity === "simple" && OrchestratorState.validateSimpleTasks) ||
        (t.complexity !== "simple" && OrchestratorState.validateComplexTasks);

    // Capture fields needed for summarization (avoids re-fetching after mutations).
    const filesToValidate = t.result?.artifacts ?? (t.files || []);
    const fullTranscript = monitor.getFullTranscript(taskId);
    const summarySnapshot: { id: string; description?: string; artifacts?: string[] } = {
        id: taskId,
        description: t.description,
        artifacts: filesToValidate
    };

    if (!shouldValidate) {
        await completeTaskWithSummary(
            summarySnapshot,
            resolveSummaryModel(model),
            fullTranscript
        );
        return;
    }

    // --- Validation phase ---
    planDb.transaction((tx: PlanTransaction) => { tx.updateTask(taskId, { status: "validating" }); });

    const validatorResult = await validateTask(
        taskId,
        t.description,
        filesToValidate,
        resolveValidatorModel(model),
        fullTranscript,
        procResult.logFile
    );

    if (validatorResult.pass) {
        if (isReadOnly) {
            planDb.transaction((tx: PlanTransaction) => {
                tx.updateTask(taskId, {
                    status: "completed",
                    result: { summary: procResult.lastAssistantText || "Read-only task executed successfully." }
                });
            });
        } else {
            await completeTaskWithSummary(
                summarySnapshot,
                resolveSummaryModel(model),
                fullTranscript
            );
        }
        return;
    }

    // Validation failed - check for recoverable cases
    const feedback = validatorResult.feedback || "";
    const isRecoverable =
        procResult.code === 0 &&
        procResult.receivedAssistantMessage &&
        (feedback.includes("truncated") ||
            feedback.includes("partial summary") ||
            feedback.includes("timed out without issuing a verdict"));

    if (isRecoverable && !isReadOnly) {
        // Auto-complete with validator note appended to summary
        notifyTuiOnly(OrchestratorState.pi, `[validator ${taskId}] Recoverable failure - auto-completing. Feedback: ${feedback}`);
        planDb.transaction((tx: PlanTransaction) => {
            tx.updateTask(taskId, {
                validatorFeedback: `Validator noted: ${feedback} (auto-completed; sub-agent exited cleanly)`
            });
        });
        await completeTaskWithSummary(
            summarySnapshot,
            resolveSummaryModel(model),
            fullTranscript
        );
    } else {
        planDb.transaction((tx: PlanTransaction) => {
            tx.updateTask(taskId, {
                status: "failed",
                validatorFeedback: feedback || "Validation failed without feedback."
            });
        });
    }
}

/** Spawn and wait for the task sub-agent process. Handles result routing internally. */
async function runTaskSubAgent(
    task: Task,
    model?: ModelRef,
    clarificationData?: { taskId: string; answer: string },
    _pi?: ExtensionAPI
): Promise<void> {
    const planDb = getPlanDb();
    if (!planDb) return;

    const taskId = task.id;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-"));
    const promptFile = path.join(tempDir, "prompt.md");
    const clarificationFile = path.join(tempDir, "clarification.json");

    try {
        // Build rich context for the sub-agent.
        const relevantClarification =
            clarificationData && clarificationData.taskId === task.id ? clarificationData : undefined;
        const context = buildTaskContext(planDb.toJSON(), task, clarificationFile, relevantClarification);
        fs.writeFileSync(promptFile, context, "utf-8");
        PersistenceManager.persistTaskPrompt(taskId, context);

        // Spawn and wait for the sub-agent process.
        const procResult = await runSubAgent({
            taskId: taskId,
            promptFile,
            description: task.description,
            taskType: task.taskType,
            timeoutMs: task.timeoutMs,
            model
        });

        // Register the persistent log file with the monitor so downstream code can reference it.
        if (procResult.logFile) {
            monitor.setTaskLogFile(taskId, procResult.logFile);
        }

        if (OrchestratorState.shuttingDown) {
            return;
        }

        // Use PlanDatabase for all mutations; read from database for initial task data
        const t = planDb.getTask(taskId);
        if (!t) return;

        // Update files & artifacts via transaction
        const allRelevantFiles = new Set([...(t.files || []), ...procResult.discoveredArtifacts]);
        planDb.transaction((tx: PlanTransaction) => {
            tx.updateTask(taskId, {
                result: { summary: t.result?.summary || "", artifacts: Array.from(allRelevantFiles) }
            });
        });

        // Handle spawn error first
        if (procResult.spawnError) {
            const spawnMessage = procResult.spawnError.message;
            planDb.transaction((tx: PlanTransaction) => {
                tx.updateTask(taskId, {
                    status: "failed",
                    validatorFeedback: `Failed to spawn sub-agent: ${spawnMessage}`
                });
            });
            return;
        }

        // --- Post-process: route by exit status (early returns) ---

        if (await handleClarification(taskId, clarificationFile)) {
            return;
        }

        const elapsedMs = t.startedAt != null ? Date.now() - t.startedAt : 0;
        const elapsedStr = `${(elapsedMs / 1000).toFixed(0)}s`;
        const output = monitor.getCapturedLines(taskId);

        if (procResult.killed) {
            // Check if the watchdog killed this agent for idle/turns reasons.
            const taggedId = `implementation-${taskId}`;
            const monState = monitor.getMonitoredAgent(taggedId);
            const killReason = monState?.killedByWatchdog ?? null;

            planDb.transaction((tx: PlanTransaction) => {
                if (killReason === "idle_timeout") {
                    tx.updateTask(taskId, {
                        status: "failed",
                        validatorFeedback: `Sub-agent idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)} (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`
                    });
                } else if (killReason === "max_turns") {
                    tx.updateTask(taskId, {
                        status: "failed",
                        validatorFeedback: `Sub-agent exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns} (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`
                    });
                } else if (procResult.loopKilled) {
                    tx.updateTask(taskId, {
                        status: "failed",
                        validatorFeedback: `Sub-agent killed due to repetitive loop (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`
                    });
                } else {
                    tx.updateTask(taskId, {
                        status: "failed",
                        validatorFeedback: `Sub-agent timed out after ${task.timeoutMs ?? OrchestratorState.taskTimeoutMs}ms (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`
                    });
                }
            });

            // Transition to failed state
            if (!transitionTo("failed")) {
                notifyTuiOnly(OrchestratorState.pi, "Failed to transition to failed state after task kill");
            }
            refreshUiStatus();
            return;
        }

        if (procResult.code !== 0) {
            planDb.transaction((tx: PlanTransaction) => {
                let feedback = `Sub-agent process exited with code ${procResult.code} (ran for ${elapsedStr})`;
                if (procResult.stderrDiagnostics) {
                    feedback += `\n\n[Raw Stderr Output]:\n${procResult.stderrDiagnostics}`;
                }
                if (output) {
                    feedback += `\n\n[Captured Events]:\n${output}`;
                }
                tx.updateTask(taskId, {
                    status: "failed",
                    validatorFeedback: feedback
                });
            });

            // Transition to failed state
            if (!transitionTo("failed")) {
                notifyTuiOnly(OrchestratorState.pi, "Failed to transition to failed state after non-zero exit");
            }
            refreshUiStatus();
            return;
        }

        await handleSuccessfulExit(taskId, procResult, model);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
