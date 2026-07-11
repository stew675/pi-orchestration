import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "./core/types";
import { activeProcesses } from "./process/process-manager";

export { activeProcesses };

// Re-export shared utilities used by external callers (tools.ts)
export { notifyOrchestrator } from "./runner/utils";

// ---------------------------------------------------------------------------
// Thin facade — preserves the exact same public API for external callers.
// All logic is delegated to phase-specific modules under runner/.
// ---------------------------------------------------------------------------

/**
 * Runner orchestrates task execution via sub-agent subprocesses.
 *
 * Static methods delegate to dedicated modules:
 * - scheduler.ts   → runTasks() (main loop, concurrency gate)
 * - executor.ts    → executeTask() (single task lifecycle)
 * - validator.ts   → validateTask() (validation phase)
 * - summarizer.ts  → summary generation + concurrency management
 */
export class Runner {
    /** Start the main execution loop. Delegates to scheduler.runTasks(). */
    static async runTasks(
        pi: ExtensionAPI,
        model?: ModelRef,
        clarificationData?: { taskId: string; answer: string }
    ): Promise<void> {
        const { runTasks } = await import("./runner/scheduler");
        return runTasks(pi, model, clarificationData);
    }

    /** Await all in-flight task summaries before entering final review. */
    static async awaitAllSummaries(): Promise<void> {
        const { awaitAllSummaries: wait } = await import("./runner/summarizer");
        return wait();
    }

    /** Cancel any pending summaries (called on shutdown). */
    static cancelAllSummaries(): void {
        const { cancelAllSummaries: cancel } = require("./runner/summarizer");
        cancel();
    }

    /** Cancel a specific pending task summary. */
    static cancelTaskSummary(taskId: string): void {
        const { cancelTaskSummary: cancel } = require("./runner/summarizer");
        cancel(taskId);
    }

    /** Reset summarizer state at start of each execution plan. */
    static resetSummarizer(): void {
        const { resetSummarizer: reset } = require("./runner/summarizer");
        reset();
    }

    // -----------------------------------------------------------------------
    // Validation (public for tools.ts / external callers)
    // -----------------------------------------------------------------------

    /** Validate a task by spawning validator sub-agent(s). */
    static async validateTask(
        taskId: string,
        taskDescription: string,
        artifactFiles: string[],
        model?: ModelRef,
        sessionTranscript?: string
    ): Promise<{ pass: boolean; feedback?: string }> {
        const { validateTask: validate } = await import("./runner/validator");
        return validate(taskId, taskDescription, artifactFiles, model, sessionTranscript);
    }
}
