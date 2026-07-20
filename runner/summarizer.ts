import type { ModelRef, Task } from "../core/types";
import { READ_ONLY_TOOLS, tryParseSubAgentEvent } from "../core/types";
import { OrchestratorState, getPi } from "../core";
import * as monitor from "../process/monitor";
import { StateManager } from "../context/state-manager";
import { spawnAgent } from "../process/process-manager";
import { savePlanSafely, notifyTuiOnly } from "./utils";
import { formatTimeout } from "../settings/time-utils";


// ---------------------------------------------------------------------------
// Pending summaries tracking - allows plan completion to await all in-flight
// summaries before entering final review.
// ---------------------------------------------------------------------------

/** @internal Tracks in-flight task-summary promises keyed by task ID so plan-completion logic can await them before entering final review. Part of the summarizer's internal concurrency machinery - not for external callers. */
const pendingSummaries = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Semaphore for summarization concurrency (summarizationConcurrency >= 1)
// ---------------------------------------------------------------------------

/** @internal Count of summary sub-agents currently executing. Used by the semaphore ({@link acquireSummarySlot} / {@link releaseSummarySlot}) to enforce the {@link OrchestratorState.summarizationConcurrency} limit. */
let activeSummaryCount = 0;

/** @internal Queue of resolver functions waiting for a free slot in the summarization semaphore. Drained by {@link releaseSummarySlot} when a running summary finishes, or bulk-resolved and cleared by {@link resetSummarySemaphore} on shutdown. */
const summaryWaitQueue: Array<() => void> = [];

function acquireSummarySlot(): Promise<void> {
    const limit = OrchestratorState.summarizationConcurrency;
    if (limit <= 0) return Promise.resolve(); // sync path, no gating needed
    if (activeSummaryCount < limit) {
        activeSummaryCount++;
        return Promise.resolve();
    }
    // Slot full - queue behind the semaphore
    return new Promise<void>((resolve) => {
        summaryWaitQueue.push(resolve);
    });
}

function releaseSummarySlot(): void {
    activeSummaryCount--;
    if (summaryWaitQueue.length > 0) {
        const next = summaryWaitQueue.shift()!;
        activeSummaryCount++;
        next();
    }
}

function resetSummarySemaphore(): void {
    activeSummaryCount = 0;
    for (const resolve of summaryWaitQueue) {
        resolve();
    }
    summaryWaitQueue.length = 0;
}

// ---------------------------------------------------------------------------
// Public API - lifecycle methods called from executor / scheduler
// ---------------------------------------------------------------------------

/**
 * Complete a task by generating its summary.
 *
 * - `summarizationConcurrency === 0` → synchronous path (await inline).
 * - `summarizationConcurrency >= 1` → fire async summaries gated by the
 *   semaphore so at most N run concurrently; caller returns immediately.
 */
export async function completeTaskWithSummary(task: Task, model?: ModelRef, sessionTranscript?: string): Promise<void> {
    if (OrchestratorState.shuttingDown) return;

    const p = StateManager.loadPlan();
    if (!p) return;

    const planTask = p.tasks.find((x) => x.id === task.id);
    if (planTask) {
        planTask.status = "summarizing";
        planTask.clarificationAttempts = 0;
    }
    savePlanSafely(p);

    // Capture the data we need for summarization before the plan is reloaded
    const taskId = task.id;
    const taskDescription = task.description;
    const artifactFiles = [...(task.result?.artifacts ?? task.files ?? [])];

    if (OrchestratorState.summarizationConcurrency >= 1) {
        // Async path - gate through the semaphore, then fire and forget
        acquireSummarySlot().then(() => {
            if (OrchestratorState.shuttingDown) {
                releaseSummarySlot();
                return;
            }
            const summaryPromise = runTaskSummaryAsync(
                taskId,
                taskDescription,
                artifactFiles,
                model,
                sessionTranscript
            ).finally(() => releaseSummarySlot());
            pendingSummaries.set(taskId, summaryPromise);
        }).catch((err: Error) => {
            notifyTuiOnly(OrchestratorState.pi, `[task-summary ${taskId}] Async summary chain error (before spawn): ${String(err)}`);
        });
    } else {
        // Synchronous path - await summary inline (original behavior)
        const taskSummary = await generateTaskSummary(
            {
                id: taskId,
                description: taskDescription,
                result: { summary: "", artifacts: artifactFiles }
            },
            model,
            sessionTranscript
        );
        finalizeTaskSummary(taskId, taskSummary);
    }
}

/** Await all in-flight task summaries. */
export async function awaitAllSummaries(): Promise<void> {
    if (pendingSummaries.size === 0) return;
    const promises = Array.from(pendingSummaries.values());
    pendingSummaries.clear();
    await Promise.all(promises);
}

/** Cancel any pending summaries (called on shutdown). */
export function cancelAllSummaries(): void {
    pendingSummaries.clear();
    resetSummarySemaphore();
}

/** Reset all summarizer internal state. Called at start of each execution plan to prevent stale entries from lingering across plan restarts within the same session. */
export function resetSummarizer(): void {
    pendingSummaries.clear();
    activeSummaryCount = 0;
    for (const resolve of summaryWaitQueue) {
        resolve(); // release any stalled waiters so they can re-acquire in the new plan context
    }
    summaryWaitQueue.length = 0;
}

/** @internal Kept for future per-task summary cancellation. Currently unused - use {@link cancelAllSummaries} for shutdown. */
export function cancelTaskSummary(taskId: string): void {
    pendingSummaries.delete(taskId);
}

// ---------------------------------------------------------------------------
// Internal summarizer logic
// ---------------------------------------------------------------------------

/** Run the summary sub-agent and resolve when done (async path). */
async function runTaskSummaryAsync(
    taskId: string,
    taskDescription: string,
    artifactFiles: string[],
    model?: ModelRef,
    sessionTranscript?: string
): Promise<void> {
    const taskSummary = await generateTaskSummary(
        {
            id: taskId,
            description: taskDescription,
            result: { summary: "", artifacts: artifactFiles }
        },
        model,
        sessionTranscript
    );
    finalizeTaskSummary(taskId, taskSummary);
}

/** Wake the runner so it can schedule the next ready task after an async summary completes. */
function resumeRunnerAfterSummary(): void {
    const p = StateManager.loadPlan();
    if (p?.status === "implementing" && OrchestratorState.summarizationConcurrency > 0) {
        try {
            const pi = getPi();
            import("../runner").then(({ Runner }) => {
                Runner.runTasks(pi).catch((err: Error) => {
                    notifyTuiOnly(OrchestratorState.pi, "Runner failed to auto-resume after background task summary: " + String(err));
                });
            });
        } catch (err) {
            notifyTuiOnly(OrchestratorState.pi, "Could not auto-resume runner: " + String(err));
        }
    }
}

/** Apply the summary result to the task in plan.json. */
function finalizeTaskSummary(taskId: string, result: { summary?: string; error?: string } | null): void {
    const p = StateManager.loadPlan();
    if (!p) {
        notifyTuiOnly(OrchestratorState.pi, `[task-summary ${taskId}] Plan not found - cannot finalize summary. Task will remain in its current state until the next recovery cycle.`);
        return;
    }

    const t = p.tasks.find((x) => x.id === taskId);
    if (!t) {
        notifyTuiOnly(OrchestratorState.pi, `[task-summary ${taskId}] Task not found in plan - cannot finalize summary. The task may have been removed.`);
        return;
    }

    if (result?.error) {
        notifyTuiOnly(OrchestratorState.pi, `[task-summary ${taskId}] Failed to generate summary: ${result.error}`);
        t.status = "failed";
        t.validatorFeedback = `Summary generation failed: ${result.error}`;
        savePlanSafely(p);

        resumeRunnerAfterSummary();
        return;
    }

    t.status = "completed";
    const summaryText =
        result === null ? "Task executed successfully." : result.summary || "Task executed successfully.";
    t.result = { ...(t.result || {}), summary: summaryText };

    savePlanSafely(p);

    // Now that it's actually completed (with summary), archive the final result.
    StateManager.archiveTaskResult(taskId, {
        status: t.status,
        summary: t.result?.summary,
        feedback: t.validatorFeedback
    });
    StateManager.archiveTaskPrompt(taskId);

    // Wake up the runner if execution is active so the next ready task can start!
    resumeRunnerAfterSummary();
}

/** Build the prompt for a task-summary sub-agent. */
function buildSummaryPrompt(
    taskId: string,
    taskDescription?: string,
    artifactFiles?: string[],
    sessionTranscript?: string
): string {
    const summaryContext: string[] = [];
    summaryContext.push("You are generating a structured summary of a completed task for the Orchestrator.");
    summaryContext.push(`\n## Task Description\n${taskDescription} (ID: ${taskId})`);
    summaryContext.push(`\n## Artifact Files (Use read to inspect these)`);
    for (const f of artifactFiles || []) {
        summaryContext.push(`- ${f}`);
    }

    // Inject session transcript so the summarizer can report verification evidence
    // (build output, test results, etc.) - critical for the orchestrator's final review.
    if (sessionTranscript && sessionTranscript.trim()) {
        summaryContext.push(`\n## Session Transcript (captured sub-agent output)`);
        summaryContext.push(`The following is a condensed log of what the sub-agent did during execution.`);
        // Already cleaned and truncated by streaming extractor (~8KB cap).
        summaryContext.push(sessionTranscript);
    }

    summaryContext.push(`\n## CRITICAL INSTRUCTIONS - Read Carefully`);
    summaryContext.push(
        `This summary will be inserted verbatim into the system prompts of downstream tasks that depend on these files. If it is incomplete or vague, those tasks will either call wrong APIs or waste time re-reading entire source files.`
    );
    summaryContext.push(`Be exhaustive and precise - do not summarize away details a consumer would need.`);

    // Only document the task's own artifacts - never shared headers/dependencies.
    const ownArtifactList = (artifactFiles || []).join(", ");
    summaryContext.push(
        `\n**SCOPE CONSTRAINT**: Document APIs **ONLY from these files: ${ownArtifactList}**. Do NOT include documentation for shared headers, imported modules, or dependency files that you merely read for context. Downstream tasks already receive summaries of their dependencies separately.`
    );

    summaryContext.push(`\nProduce your response in exactly THREE sections:`);

    summaryContext.push(
        `1. **What was built** - 1-3 sentences per file describing the purpose and role of each artifact file. Be specific about what problem it solves, not generic descriptions like "utility functions" or "helper module."`
    );

    summaryContext.push(
        `2. **Public API Surface** - For every code-related file, provide a complete structured listing organized by file name. Under each file header, list ALL of the following (omit categories that don't apply):`
    );
    summaryContext.push(
        `   - **Data types / interfaces / structs**: full type signature with all fields and their types (e.g., "interface NoiseConfig { seed: number; octaves: number; persistence: number }")`
    );
    summaryContext.push(
        `   - **Classes**: constructor signature, public methods with full signatures including parameter names, types, return types, and line numbers (e.g., "SimplexNoise(seed: number)" at line 12, ".noise2D(x: number, y: number): number" at line 89)`
    );
    summaryContext.push(
        `   - **Functions**: full signature with parameter names, types, return type, and a one-line description of what it does (e.g., "generateNoiseMap(width: number, height: number, config?: NoiseConfig): number[][]" - returns a 2D array of noise values in [-1,+1])`
    );
    summaryContext.push(`   - **Constants / enums**: value and meaning (e.g., "BLOCK_AIR = 0", "DEFAULT_OCTAVES = 4")`);
    summaryContext.push(
        `   - **Default exports vs named exports** - clearly indicate which is the default export if applicable.`
    );
    summaryContext.push(
        `   Include line numbers for every entry. This lets dependent tasks find exactly what they need without scanning files.`
    );

    summaryContext.push(
        `3. **Key design decisions and constraints** - any behavioral details consumers MUST know to use these APIs correctly: return value ranges, mutability guarantees, side effects (e.g., "modifies the input array in-place"), expected preconditions, error conditions, threading/concurrency notes, or conventions (e.g., "block id 0 is always air", "coordinates are integer grid positions").`
    );

    // Conditional 4th section for build/test/verification tasks
    if (sessionTranscript && sessionTranscript.trim()) {
        summaryContext.push(
            `4. **Verification Report** - If the task ran any builds, compilations, tests, or verification commands, report exactly what was run and whether it succeeded. Include specific details: which targets were built, how many tests passed/failed, any warnings noted. This helps the Orchestrator decide if additional verification is needed.`
        );
    }

    const sectionCount = sessionTranscript && sessionTranscript.trim() ? "four" : "three";
    summaryContext.push(
        `\nRespond with ONLY these ${sectionCount} sections. No preamble, no conclusion, no labels beyond the section headers.`
    );

    return summaryContext.join("\n");
}

/** Spawn a read-only sub-agent to produce a structured task summary.
 *  Retries once (max 2 attempts) on no-output or crash failures, matching validator pattern. */
async function generateTaskSummary(
    task: { id: string; description?: string; files?: string[]; result?: Task["result"] },
    model?: ModelRef,
    sessionTranscript?: string
): Promise<{ summary?: string; error?: string } | null> {
    const artifactFiles = task.result?.artifacts ?? task.files ?? [];
    if (artifactFiles.length === 0) return null;

    const promptContent = buildSummaryPrompt(task.id, task.description, artifactFiles, sessionTranscript);
    // Persist the summary prompt for debugging - survives process exit.
    StateManager.persistSummaryPrompt(task.id, promptContent);

    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await runSummaryOnce(task.id, promptContent, model, attempt + 1);
        // Success - persist response and return.
        if (result.summary) {
            StateManager.persistSummaryResponse(task.id, result.summary);
            return { summary: result.summary };
        }
        // Retryable failure (no output or crash)
        notifyTuiOnly(OrchestratorState.pi, `[task-summary ${task.id}] Attempt ${attempt + 1}/${maxAttempts}: ${result.error}, retrying...`);
    }

    // All attempts exhausted - persist final error.
    const lastError = `Summary generation failed after ${maxAttempts} attempts.`;
    StateManager.persistSummaryError(task.id, lastError);
    return { error: lastError };
}

/** Run a single attempt of the summary sub-agent. Returns { summary } on success or { error } on failure. */
async function runSummaryOnce(
    taskId: string,
    promptContent: string,
    model?: ModelRef,
    _attempt = 1
): Promise<{ summary?: string; error?: string }> {
    const monitorId = `${taskId}-summary`;
    return await new Promise((resolve) => {
        const args = [
            "--mode",
            "json",
            "--no-session",
            "--tools",
            READ_ONLY_TOOLS,
            "--append-system-prompt",
            promptContent
        ];
        if (model) {
            args.push("--model", `${model.provider}/${model.id}`);
        }
        args.push(
            "-p",
            "Inspect every artifact file with read and produce a complete, detailed summary of all public APIs, data types, and design constraints. Be exhaustive - downstream tasks depend on this."
        );

        let summaryText: string | undefined;

        const { child, clearTimeout } = spawnAgent(
            args,
            {
                timeoutMs: OrchestratorState.taskSummaryTimeoutMs,
                label: `task-summary ${taskId}`,
                taskId: monitorId
            },
            (line) => {
                // Feed every raw line to the monitor for JSON parsing.
                // skipActive: true so the summarizer doesn't hijack the /om-status view.
                monitor.ingestLine(monitorId, line, { skipActive: true });

                const event = tryParseSubAgentEvent(line);
                if (event && event.type === "message_end" && event.message?.role === "assistant") {
                    for (const part of event.message.content || []) {
                        if ((part as Record<string, unknown>).type === "text") {
                            summaryText = String((part as Record<string, unknown>).text).trim();
                        }
                    }
                }
            }
        );

        // Register with the unified monitor so watchdog can enforce idle/turns limits.
        const taggedId = `summarization-${taskId}`;
        monitor.registerAgent(taggedId, child);

        child.on("close", (code) => {
            clearTimeout();
            // Don't clear active task - another sub-agent may be running concurrently

            // Check if watchdog killed this agent for idle/turns reasons.
            const taggedId = `summarization-${taskId}`;
            const monState = monitor.getMonitoredAgent(taggedId);
            const killReason = monState?.killedByWatchdog ?? null;

            if (killReason === "idle_timeout") {
                resolve({ error: `Summary idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)}.` });
                return;
            }
            if (killReason === "max_turns") {
                resolve({ error: `Summary exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns}.` });
                return;
            }

            if (code !== 0 || !summaryText) {
                const reason =
                    code !== 0
                        ? `Summary process exited with code ${code}`
                        : "Summary process exited cleanly but produced no assistant output (LLM may have crashed).";
                resolve({ error: reason });
            } else {
                resolve({ summary: summaryText });
            }
        });

        child.on("error", (err) => {
            clearTimeout();
            // Don't clear active task - another sub-agent may be running concurrently
            notifyTuiOnly(OrchestratorState.pi, `[task-summary ${taskId}] Error: ${err.message}`);
            resolve({ error: err.message });
        });
    });
}
