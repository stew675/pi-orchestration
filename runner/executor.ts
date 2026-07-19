import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef, Task } from "../core/types";
import { MAX_CLARIFICATIONS, isTaskReadOnly } from "../core/types";
import { OrchestratorState, resolveTaskModelByComplexity, resolveValidatorModel, resolveSummaryModel } from "../core";
import { StateManager } from "../context/state-manager";
import { buildTaskContext } from "../context/context-builder";
import * as monitor from "../process/monitor";
import { notifyOrchestrator, savePlanSafely, notifyTuiOnly } from "./utils";
import { runSubAgent } from "./subagent-spawner";
import type { SubAgentResult } from "./subagent-spawner";
import { validateTask } from "./validator";
import { completeTaskWithSummary } from "./summarizer";
import { processTaskResult as postProcessTaskResult } from "./post-processor";
import { formatTimeout } from "../settings/time-utils";
import { transitionTo, getCurrentOrchestrationState } from "../core/state-machine";

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
            const refreshedPlan = StateManager.loadPlan();
            if (refreshedPlan) {
                const refreshedTask = refreshedPlan.tasks.find((t) => t.id === task.id);
                if (refreshedTask && refreshedTask.status === "completed") return true;
            }
        }

        // Refresh plan state in case user paused/stopped
        const currentPlan = StateManager.loadPlan();
        if (!currentPlan) return false;

        const currentState = getCurrentOrchestrationState(currentPlan);

        // Hard stop
        if (currentState === "paused" || currentState === "failed") {
            return false;
        }

        const planTask = currentPlan.tasks.find((t) => t.id === task.id);
        if (!planTask) return false;

        planTask.status = "running";
        planTask.startedAt = Date.now();
        currentPlan.currentTaskId = task.id;

        // Ensure we're in implementing state
        if (!transitionTo("implementing", currentPlan)) {
            notifyTuiOnly(OrchestratorState.pi || (await import("../core")).getPi(), "Failed to transition to implementing state when starting task");
        }
        savePlanSafely(currentPlan);

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
            const p = StateManager.loadPlan();
            if (p) {
                const t = p.tasks.find((x) => x.id === task.id);
                if (t && t.status === "running") {
                    t.status = "pending";
                    t.attempts++;
                    delete t.startedAt;
                    savePlanSafely(p);
                    notifyTuiOnly(pi || OrchestratorState.pi, `Task ${task.id} reset from 'running' to 'pending' after unexpected error.`);
                }
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
function handleClarification(task: Task, clarificationFile: string): boolean {
    if (!fs.existsSync(clarificationFile)) return false;

    try {
        const cContent = fs.readFileSync(clarificationFile, "utf-8").trim();
        if (!cContent) return false;

        const cData = JSON.parse(cContent);
        if (!(cData && typeof cData === "object" && typeof cData.query === "string")) return false;

        task.clarificationAttempts = (task.clarificationAttempts || 0) + 1;

        if (task.clarificationAttempts > MAX_CLARIFICATIONS) {
            const elapsed = task.startedAt ? `${((Date.now() - task.startedAt) / 1000).toFixed(0)}s` : "?";
            task.status = "failed";
            task.validatorFeedback = `Task requested clarification ${task.clarificationAttempts} times (max ${MAX_CLARIFICATIONS}). Aborting. (ran for ${elapsed})`;
        } else {
            task.status = "awaiting_clarification";
            task.clarificationQuery = cData.query;
        }

        const p = StateManager.loadPlan();
        if (p) savePlanSafely(p);
    } catch (e) {
        task.status = "failed";
        task.validatorFeedback = `Sub-agent attempted to write clarification but the file was invalid/malformed: ${(e as Error).message}`;
        const p = StateManager.loadPlan();
        if (p) savePlanSafely(p);
    }

    return true; // caller should stop regardless of outcome
}

/** Handle successful (code 0) sub-agent exit. Routes through validation and summarization. */
async function handleSuccessfulExit(task: Task, procResult: SubAgentResult, model?: ModelRef): Promise<void> {
    // Load fresh plan state - always work from the plan's copy of the task
    const p = StateManager.loadPlan();
    if (!p) return;
    const t = p.tasks.find((x) => x.id === task.id);
    if (!t) return;

    // Guard: process exited cleanly but produced no assistant output (LLM may have crashed)
    if (!procResult.receivedAssistantMessage) {
        const elapsed = t.startedAt != null ? ((Date.now() - t.startedAt) / 1000).toFixed(0) : "?";
        const output = monitor.getCapturedLines(t.id);
        t.status = "failed";
        t.validatorFeedback = `Sub-agent process exited with code 0 but produced no assistant output (LLM may have crashed). Ran for ${elapsed}s.${output ? "\n\n" + output : ""}`;
        savePlanSafely(p);
        return;
    }

    // Save plan with updated artifacts before continuing
    savePlanSafely(p);

    const isReadOnly = isTaskReadOnly(t.taskType);

    // Determine whether this task needs validation
    const shouldValidate =
        isReadOnly ||
        (t.complexity === "simple" && OrchestratorState.validateSimpleTasks) ||
        (t.complexity !== "simple" && OrchestratorState.validateComplexTasks);

    if (!shouldValidate) {
        await completeTaskWithSummary(t, resolveSummaryModel(model), monitor.getFullTranscript(t.id));
        return;
    }

    // --- Validation phase ---
    t.status = "validating";
    savePlanSafely(p);

    const filesToValidate = t.result?.artifacts ?? (t.files || []);
    const fullTranscript = monitor.getFullTranscript(t.id);
    const validatorResult = await validateTask(
        t.id,
        t.description,
        filesToValidate,
        resolveValidatorModel(model),
        fullTranscript,
        procResult.logFile
    );

    if (validatorResult.pass) {
        if (isReadOnly) {
            t.status = "completed";
            t.result = {
                ...(t.result || {}),
                summary: procResult.lastAssistantText || "Read-only task executed successfully."
            };
            savePlanSafely(p);
        } else {
            await completeTaskWithSummary(t, resolveSummaryModel(model), fullTranscript);
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
        notifyTuiOnly(OrchestratorState.pi, `[validator ${t.id}] Recoverable failure - auto-completing. Feedback: ${feedback}`);
        t.validatorFeedback = `Validator noted: ${feedback} (auto-completed; sub-agent exited cleanly)`;
        await completeTaskWithSummary(t, resolveSummaryModel(model), fullTranscript);
    } else {
        t.status = "failed";
        t.validatorFeedback = feedback || "Validation failed without feedback.";
        savePlanSafely(p);
    }
}

/** Spawn and wait for the task sub-agent process. Handles result routing internally. */
async function runTaskSubAgent(
    task: Task,
    model?: ModelRef,
    clarificationData?: { taskId: string; answer: string },
    _pi?: ExtensionAPI
): Promise<void> {
    const plan = StateManager.loadPlan();
    if (!plan) return;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-"));
    const promptFile = path.join(tempDir, "prompt.md");
    const clarificationFile = path.join(tempDir, "clarification.json");

    try {
        // Build rich context for the sub-agent.
        const relevantClarification =
            clarificationData && clarificationData.taskId === task.id ? clarificationData : undefined;
        const context = buildTaskContext(plan, task, clarificationFile, relevantClarification);
        fs.writeFileSync(promptFile, context, "utf-8");
        StateManager.persistTaskPrompt(task.id, context);

        // Spawn and wait for the sub-agent process.
        const procResult = await runSubAgent({
            taskId: task.id,
            promptFile,
            description: task.description,
            taskType: task.taskType,
            timeoutMs: task.timeoutMs,
            model
        });

        // Register the persistent log file with the monitor so downstream code can reference it.
        if (procResult.logFile) {
            monitor.setTaskLogFile(task.id, procResult.logFile);
        }

        if (OrchestratorState.shuttingDown) {
            return;
        }

        const p = StateManager.loadPlan();
        if (!p) return;

        const t = p.tasks.find((x) => x.id === task.id);
        if (!t) return;

        // Update files & artifacts
        const allRelevantFiles = new Set([...(t.files || []), ...procResult.discoveredArtifacts]);
        t.result = { summary: t.result?.summary || "", artifacts: Array.from(allRelevantFiles) };

        // Save plan before further processing
        savePlanSafely(p);

        // Handle spawn error first
        if (procResult.spawnError) {
            t.status = "failed";
            t.validatorFeedback = `Failed to spawn sub-agent: ${procResult.spawnError.message}`;
            savePlanSafely(p);
            return;
        }

        // --- Post-process: route by exit status (early returns) ---

        if (await handleClarification(t, clarificationFile)) {
            return;
        }

        const elapsedMs = t.startedAt != null ? Date.now() - t.startedAt : 0;
        const elapsedStr = `${(elapsedMs / 1000).toFixed(0)}s`;
        const output = monitor.getCapturedLines(task.id);

        if (procResult.killed) {
            // Check if the watchdog killed this agent for idle/turns reasons.
            const taggedId = `implementation-${task.id}`;
            const monState = monitor.getMonitoredAgent(taggedId);
            const killReason = monState?.killedByWatchdog ?? null;

            t.status = "failed";
            if (killReason === "idle_timeout") {
                t.validatorFeedback = `Sub-agent idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)} (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`;
            } else if (killReason === "max_turns") {
                t.validatorFeedback = `Sub-agent exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns} (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`;
            } else if (procResult.loopKilled) {
                t.validatorFeedback = `Sub-agent killed due to repetitive loop (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`;
            } else {
                t.validatorFeedback = `Sub-agent timed out after ${task.timeoutMs ?? OrchestratorState.taskTimeoutMs}ms (ran for ${elapsedStr})${output ? "\n\n" + output : ""}`;
            }

            // Transition to failed state
            if (!transitionTo("failed", p)) {
                notifyTuiOnly(OrchestratorState.pi, "Failed to transition to failed state after task kill");
            }
            savePlanSafely(p);
            return;
        }

        if (procResult.code !== 0) {
            t.status = "failed";
            let feedback = `Sub-agent process exited with code ${procResult.code} (ran for ${elapsedStr})`;
            if (procResult.stderrDiagnostics) {
                feedback += `\n\n[Raw Stderr Output]:\n${procResult.stderrDiagnostics}`;
            }
            if (output) {
                feedback += `\n\n[Captured Events]:\n${output}`;
            }
            t.validatorFeedback = feedback;

            // Transition to failed state
            if (!transitionTo("failed", p)) {
                notifyTuiOnly(OrchestratorState.pi, "Failed to transition to failed state after non-zero exit");
            }
            savePlanSafely(p);
            return;
        }

        await handleSuccessfulExit(t, procResult, model);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
