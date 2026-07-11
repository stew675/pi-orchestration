import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OrchestrationPlan, Task } from "../core/types";
import { OrchestratorState } from "../core";
import { StateManager } from "../context/state-manager";

/** Regex patterns for extracting a short title from notification messages. */
const TASK_NAME_RE = /Task '([^']+)'/;
const ACTION_VERB_RE = /\b(failed|completed|paused|resumed)\b/i;
const SYSTEM_PREFIX_RE = /^System[:\s]*/;

/**
 * Reliable notification to the orchestrator.
 * Uses pi.sendMessage with triggerTurn for guaranteed delivery.
 *
 * @param message - System message sent to the orchestrator LLM
 * @param options.tuiVisible - Whether to also append a TUI status entry. Default true.
 *   Set false for multi-paragraph orchestrator guidance (recovery instructions, review
 *   messages) that are meant for the model only and would clutter the user's transcript.
 */
export function notifyOrchestrator(pi: ExtensionAPI, message: string, options?: { tuiVisible?: boolean }): void {
    try {
        const showTui = options?.tuiVisible !== false;

        if (showTui) {
            // Append a TUI-only status entry (visible in transcript, not sent to LLM context).
            appendOrchestratorStatusEntry(pi, message);
        }

        pi.sendMessage(
            {
                customType: "orchestrator_event",
                content: message,
                display: false
            },
            { triggerTurn: true }
        );
    } catch (e) {
        console.error("Failed to send orchestrator notification:", e);
    }
}

/** Append a TUI-only orchestration status entry (does NOT participate in LLM context). */
function appendOrchestratorStatusEntry(pi: ExtensionAPI, message: string): void {
    try {
        const titleMatch = message.match(TASK_NAME_RE);

        let title: string;
        if (titleMatch) {
            // e.g., "Task 'task_phase1' failed"
            const taskName = titleMatch[1];
            const actionIndex = message.indexOf(taskName);
            const beforeAction = message.substring(0, Math.min(actionIndex + 50, message.length));
            const verbMatch = beforeAction.match(ACTION_VERB_RE);
            title = `${taskName} ${verbMatch ? verbMatch[1] : "event"}`;
        } else {
            // Fall back to first 60 chars after stripping "System:" prefix.
            title = message.substring(0, 60).replace(SYSTEM_PREFIX_RE, "").trim() || "Orchestration event";
        }

        pi.appendEntry("orchestration-status", {
            title,
            message: message.replace(SYSTEM_PREFIX_RE, ""),
            timestamp: Date.now()
        });
    } catch (e) {
        // Non-fatal - status entry is purely cosmetic. The sendMessage below still works.
        console.warn("Failed to append orchestration status entry:", e);
    }
}

/** Guard against writing stale state after session_shutdown has begun. */
export function savePlanSafely(plan: OrchestrationPlan): void {
    if (!OrchestratorState.shuttingDown) {
        StateManager.savePlan(plan);
    }
}

/**
 * Build a contextual "FINAL REVIEW" wakeup message with task summaries,
 * artifact file lists, and anti-redundancy instructions.
 *
 * Shared by scheduler.finishPlan() and commands.resumePlanExecution()
 * so both paths produce identical orchestrator guidance.
 */
export function buildFinalReviewMessage(plan: OrchestrationPlan, introLine?: string): string {
    const parts: string[] = [];
    const tasks = plan.tasks || [];

    parts.push(introLine ?? "System: All tasks completed. Entering FINAL REVIEW.");
    parts.push("");

    // Summarize build/test task results so the orchestrator can see what was already verified.
    const buildTasks = tasks.filter((t: Task) => t.taskType === "building");
    if (buildTasks.length > 0) {
        parts.push("Build/test tasks completed:");
        for (const bt of buildTasks) {
            const summaryFirstLine = bt.result?.summary ? bt.result.summary.split("\n")[0].slice(0, 200) : "";
            const artifactList =
                bt.result?.artifacts && bt.result.artifacts.length > 0 ? ` [${bt.result.artifacts.join(", ")}]` : "";
            parts.push(`  - ${bt.id}: ${summaryFirstLine}${artifactList}`);
        }
    }

    // List all deliverable files for quick reference.
    const artifactTasks = tasks.filter((t: Task) => t.result?.artifacts && t.result.artifacts.length > 0);
    if (artifactTasks.length > 0) {
        parts.push("");
        parts.push("Deliverable files created:");
        const allFiles = new Set<string>();
        for (const t of artifactTasks) {
            for (const f of t.result?.artifacts || []) allFiles.add(f);
        }
        parts.push(`  ${[...allFiles].join(", ")}`);
    }

    // Anti-redundancy guidance.
    parts.push("");
    parts.push("Review instructions:");
    parts.push(
        "1. Inspect the project files and verify they satisfy the original goal.",
        "2. If a build/compile/test task already ran successfully (see above), do NOT add another verification task - the work was already validated.",
        "3. Only add a remediation task if you find a genuine gap (e.g., missing file, unverified behavior). Check completed tasks first!",
        "4. If everything meets the goal, call orchestrate_approve_goal to finish."
    );

    return parts.join("\n");
}
