import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    PersistenceManager,
    drainPlanChangeListeners,
    startPlanSaveTimer,
    stopPlanSaveTimer,
    wirePlanPersistence
} from "./context/persistence";
import { Runner } from "./runner";
import { killAllProcesses, activeProcesses } from "./process/process-manager";
import {
    OrchestratorState,
    updateActiveTools,
    resetState,
    beginShutdown,
    requireActive,
    switchToReviewerModel,
    restoreFromReviewPhase,
    setPlanDb,
    getPlanDb
} from "./core";
import { PlanDatabase } from "./core/plan-database";
import {
    registerEnableCommand,
    registerOrchestrationCommands,
    startExecutionFromPlan,
    showAcceptOrEditDialog
} from "./commands/commands";
import { registerTools } from "./tools";
import { registerValidatorTools } from "./tools/validator-tools";
import { registerCodeReviewTools } from "./tools/code-review-tools";
import { setupUIWidget, setOrchestrationEditor } from "./ui/ui";
import { applySettingsToState } from "./settings/settings";
import { formatTimeout } from "./settings/time-utils";
import * as monitor from "./process/monitor";
import { setupOrchestratorStatusRenderer } from "./ui/orchestrator-status-entry";
import {
    buildTurnSignature,
    recordToolExecution,
    clearTurnTools,
    resetLoopState,
    isPastTaskAssignmentPhase,
    setLoopBreakerFired,
    isLoopBreakerFired,
    incrementConsecutiveCount,
    getConsecutiveCount,
    resetConsecutiveCount,
    getLastTurnSignature,
    setLastTurnSignature,
    resetLoopBreakerFlag,
    ORCHESTRATOR_LOOP_THRESHOLD
} from "./process/loop-detector";
import { isActive, isPlanningMode, isExecutingMode } from "./core/state-machine";

import {
    ORCHESTRATOR_PLANNING_SYSTEM_PROMPT,
    ORCHESTRATOR_EXECUTION_SYSTEM_PROMPT,
    PLANNING_HINT_PRE_WRITE,
    ORCHESTRATOR_REVIEW_SYSTEM_PROMPT,
    ORCHESTRATOR_CODE_REVIEW_DECISION_SYSTEM_PROMPT
} from "./context/prompts";
import { notifyTuiOnly } from "./runner/utils";

/** Watchdog timer interval (ms) — checks for stalled orchestrator every 2 seconds during execution. */
const WATCHDOG_INTERVAL_MS = 2000;
/** Number of consecutive idle turns before watchdog kicks the orchestrator. */
const WATCHDOG_IDLE_THRESHOLD = 5;
/** Delay (ms) before showing the Accept/Edit dialog after plan update, allowing tool output to render. */
const DIALOG_RENDER_DELAY_MS = 100;

export default function (pi: ExtensionAPI) {
    if (process.env.PI_ORCHESTRATION_SUB_AGENT === "true") {
        // Sub-agents need their respective signal tools but nothing else.
        registerValidatorTools(pi);
        registerCodeReviewTools(pi);
        return;
    }

    OrchestratorState.pi = pi;

    let isAgentIdle = true;
    let watchdogIdleCount = 0;
    let watchdogTimer: NodeJS.Timeout | null = null;

    pi.on("session_start", async (_event, ctx) => {
        if (!watchdogTimer) {
            watchdogTimer = setInterval(() => {
                // --- Sub-agent idle/turns enforcement ---
                enforceSubAgentLimits();

                // --- Orchestrator stall detection ---
                // Watchdog: Kick the orchestrator if it stalls during execution mode.
                const plan = getPlanDb()?.toJSON() ?? null;
                if (
                    !isExecutingMode(OrchestratorState.currentState) ||
                    ["paused", "stopped", "pausing"].includes(OrchestratorState.currentState) ||
                    !isAgentIdle ||
                    activeProcesses.size > 0 ||
                    !plan ||
                    plan.tasks?.some((t) => t.status === "awaiting_clarification")
                ) {
                    watchdogIdleCount = 0;
                    return;
                }

                watchdogIdleCount++;
                if (watchdogIdleCount >= WATCHDOG_IDLE_THRESHOLD) {
                    watchdogIdleCount = 0;
                    pi.sendMessage(
                        {
                            customType: "orchestrator_event",
                            content:
                                "System watchdog: Orchestration appears stalled. Please continue processing the plan. If you encountered an error, use orchestrate_replan.",
                            display: true
                        },
                        { triggerTurn: true }
                    );
                }
            }, WATCHDOG_INTERVAL_MS);
        }

        // Reset all in-memory state to ensure a clean slate after reload or session replacement.
        resetState();
        OrchestratorState.theme = ctx.ui.theme;

        // Restore persisted model preferences
        applySettingsToState(OrchestratorState);

        // Start the auto-save plan timer
        startPlanSaveTimer();

        // Just notify about an existing plan - don't auto-activate orchestration.
        // The user must explicitly run /om-enable to proceed.
        const parsedPlan = PersistenceManager.loadPlan();
        setPlanDb(parsedPlan ? new PlanDatabase(parsedPlan) : null);
        wirePlanPersistence();

        const planDb = getPlanDb();
        if (planDb) {
            if (planDb.getStatus() !== "completed") {
                ctx.ui.notify(
                    `Incomplete orchestration plan found: "${planDb.getGoal()}". Run /om-enable to resume or discard.`,
                    "warning"
                );
            } else {
                ctx.ui.notify(
                    `Previous orchestration completed. Goal: "${planDb.getGoal()}". Run /om-enable to start a new plan.`,
                    "info"
                );
            }
        }

        updateActiveTools(pi);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
        // Stop the auto-save timer
        stopPlanSaveTimer();

        // Signal the runner to stop writing stale state
        beginShutdown();
        // Cancel any in-flight task summaries
        Runner.cancelAllSummaries();
        // Clear plan change listeners to prevent leaks across sessions
        drainPlanChangeListeners();

        // Recover in-flight tasks and save them back to 'pending' on disk
        const planDb = getPlanDb();
        if (planDb) {
            const recovered = planDb.recoverInterruptedTasks();
            if (recovered > 0 || planDb.isDirty()) {
                try {
                    PersistenceManager.flushPlan();
                } catch (e) {
                    notifyTuiOnly(pi, "Failed to persist plan during shutdown: " + String(e));
                }
            }
        }

        // Force-kill all child processes immediately on shutdown
        killAllProcesses("SIGKILL");
        // Reset monitor state to clear stale data from the previous session
        monitor.resetMonitorState();
        // Reset orchestrator loop detector
        resetLoopState();
        // Restore default editor when session ends - use the ctx passed to this handler
        setOrchestrationEditor(false, ctx);
    });

    pi.on("before_agent_start", async (event) => {
        // --- Post-exit system prompt restoration (one-shot) ---
        if (OrchestratorState.pendingSystemPromptRestore && OrchestratorState.originalSystemPrompt !== undefined) {
            OrchestratorState.pendingSystemPromptRestore = false;
            return {
                systemPrompt: OrchestratorState.originalSystemPrompt,
                message: {
                    customType: "orchestrator_event",
                    content:
                        "System: Orchestration mode has ended. You are back to normal Pi agent mode with full access to your standard tools (read, bash, edit, write, grep, find, ls). The orchestration tools and orchestrator instructions are no longer active.",
                    display: false
                }
            };
        }

        if (isActive(OrchestratorState.currentState)) {
            // Capture the original system prompt on the first orchestration turn
            if (OrchestratorState.originalSystemPrompt === undefined) {
                OrchestratorState.originalSystemPrompt = event.systemPrompt;
            }

            // Select the appropriate prompt based on current phase.
            if (OrchestratorState._inReviewPhase) {
                return { systemPrompt: ORCHESTRATOR_REVIEW_SYSTEM_PROMPT };
            }

            if (isExecutingMode(OrchestratorState.currentState)) {
                if (OrchestratorState.currentState === "code_review") {
                    return { systemPrompt: ORCHESTRATOR_CODE_REVIEW_DECISION_SYSTEM_PROMPT };
                }
                return { systemPrompt: ORCHESTRATOR_EXECUTION_SYSTEM_PROMPT };
            }

            // Planning or idle - focused planning prompt, no standard Pi instructions.
            return { systemPrompt: ORCHESTRATOR_PLANNING_SYSTEM_PROMPT };
        }
    });

    /** Prune conversation history when a mode reset is signaled (e.g. entering planning or execution). */
    pi.on("context", async (event) => {
        if (OrchestratorState.shouldResetContext) {
            OrchestratorState.shouldResetContext = false;

            // Prune all messages except the very last one (the user prompt that triggered the turn).
            const messages = event.messages;
            if (messages.length > 1) {
                return { messages: [messages[messages.length - 1]] };
            }
        }
    });

    /** Intercept planning tool results for guidance-in-the-moment pattern.
     *  Only orchestrate_write_plan injects a quality hint (one-shot).
     *  Dialog / review triggering is handled by orchestrate_present_plan, not write/edit. */
    pi.on("tool_result", async (event, _ctx) => {
        if (!isPlanningMode(OrchestratorState.currentState) || event.isError) return;

        if (event.toolName === "orchestrate_write_plan") {
            // Inject pre-write quality hint on first call (one-shot).
            if (!OrchestratorState._preWriteHintSent) {
                OrchestratorState._preWriteHintSent = true;
                pi.sendMessage(
                    { customType: "orchestrator_event", content: PLANNING_HINT_PRE_WRITE, display: false },
                    { deliverAs: "nextTurn" }
                );
            }
            // Plan is already visible on screen from renderCall streaming + final render.
            // Don't replace content - just let the existing display stay as-is.
            return;
        } else if (event.toolName === "orchestrate_review_plan" && OrchestratorState._inReviewPhase) {
            // Reviewer finished — queue back to planning model and instruct planner to process review.
            OrchestratorState._pendingReviewCompletion = true;
        }
    });

    pi.on("agent_start", () => {
        isAgentIdle = false;
        watchdogIdleCount = 0;
    });

    pi.on("agent_end", () => {
        isAgentIdle = true;
        watchdogIdleCount = 0;
    });

    /** Show Accept/Edit dialog only when the agent has fully settled (no retries/compaction/follow-ups left).
     *  This avoids false triggers from auto-retry or auto-compaction cycles that also fire turn_end. */
    pi.on("agent_settled", async (_event, ctx) => {
        if (!isPlanningMode(OrchestratorState.currentState)) return;

        if (OrchestratorState._pendingReviewStart) {
            OrchestratorState._pendingReviewStart = false;
            OrchestratorState._inReviewPhase = true;
            try {
                const success = await switchToReviewerModel(pi, ctx);
                if (success) {
                    await pi.sendMessage(
                        {
                            customType: "orchestrator_event",
                            content:
                                "System: You are now acting as the Plan Reviewer. Please review the implementation plan at .pi/orchestration/plans/implementation-plan.md and provide your assessment using orchestrate_review_plan. Be thorough in identifying missing steps, incorrect assumptions, or suboptimal approaches.",
                            display: false
                        },
                        { triggerTurn: true }
                    );
                } else {
                    OrchestratorState._inReviewPhase = false;
                    OrchestratorState._planJustUpdated = true;
                    await showAcceptOrEditDialog(pi, ctx);
                }
            } catch (e) {
                notifyTuiOnly(pi, "Failed to switch to reviewer model: " + String(e));
                OrchestratorState._inReviewPhase = false;
                OrchestratorState._planJustUpdated = true;
                await showAcceptOrEditDialog(pi, ctx);
            }
            return;
        }

        if (OrchestratorState._pendingReviewCompletion) {
            OrchestratorState._pendingReviewCompletion = false;
            OrchestratorState._inReviewPhase = false;
            OrchestratorState._incorporatingFeedback = true;
            try {
                await restoreFromReviewPhase(pi, ctx);
                await pi.sendMessage(
                    {
                        customType: "orchestrator_event",
                        content:
                            "System: The reviewer has completed its assessment. Read .pi/orchestration/plans/plan-review.md for the review findings. If you agree with any issues or recommendations, use orchestrate_edit_plan to make improvements. Then call orchestrate_present_plan to show the final plan to the user and STOP IMMEDIATELY.",
                        display: false
                    },
                    { triggerTurn: true }
                );
            } catch (e) {
                notifyTuiOnly(pi, "Failed to restore from review phase: " + String(e));
            }
            return;
        }

        if (OrchestratorState._planJustUpdated && !OrchestratorState._inReviewPhase) {
            OrchestratorState._planJustUpdated = false;
            // Small delay so the tool result has fully rendered before overlay appears.
            setTimeout(async () => {
                await showAcceptOrEditDialog(pi, ctx);
            }, DIALOG_RENDER_DELAY_MS);
        }
    });

    pi.on("turn_start", () => {
        isAgentIdle = false;
        watchdogIdleCount = 0;

        // Clear pending tool executions for the new turn (loop detection)
        clearTurnTools();
    });

    /** Track orchestrator tool calls per turn for loop detection. */
    pi.on("tool_execution_start", (event) => {
        if (!isExecutingMode(OrchestratorState.currentState)) return;

        recordToolExecution(event.toolCallId, event.toolName, event.args || {});
    });

    /** Track orchestrator tool calls per turn for loop detection.
     *  Run at turn_end to detect repetitive identical turns during execution mode. */
    pi.on("turn_end", async (_event, _ctx) => {
        // --- Verifying phase turn limit enforcement ---
        if (OrchestratorState.currentState === "verifying") {
            // Reset counter on first turn after entering verifying (catches re-entry via remedial tasks)
            if (!OrchestratorState._verifyingTurnCounterActive) {
                OrchestratorState._verifyingTurnCounterActive = true;
                OrchestratorState._verifyingOrchestratorTurnCount = 0;
            }
            OrchestratorState._verifyingOrchestratorTurnCount++;
            const maxTurns = OrchestratorState.verifyingOrchestratorMaxTurns;
            if (maxTurns > 0 && OrchestratorState._verifyingOrchestratorTurnCount >= maxTurns) {
                notifyTuiOnly(
                    pi,
                    `[watchdog] Orchestrator exceeded verifying turn limit of ${maxTurns} (at turn ${OrchestratorState._verifyingOrchestratorTurnCount}). Force-approving.`
                );

                // Force transition to completed and notify user.
                const planDb = getPlanDb();
                if (planDb) {
                    try {
                        import("./core/state-machine").then(({ transitionTo }) => {
                            transitionTo("completed");
                        });
                    } catch (e) {
                        notifyTuiOnly(pi, "Failed during force-approve: " + String(e));
                    }
                }

                // Wake the orchestrator with a final message so it sees the state change.
                try {
                    pi.sendMessage(
                        {
                            customType: "orchestrator_event",
                            content: `System: Verification turn limit reached (${maxTurns} turns). The plan has been auto-approved. You may call orchestrate_approve_goal to finalize or proceed normally.`,
                            display: true
                        },
                        { triggerTurn: true }
                    );
                } catch (e) {
                    notifyTuiOnly(pi, "Failed to send force-approve message: " + String(e));
                }
            }
        } else {
            // Reset counter and flag when we leave verifying
            if (OrchestratorState._verifyingTurnCounterActive) {
                OrchestratorState._verifyingTurnCounterActive = false;
                OrchestratorState._verifyingOrchestratorTurnCount = 0;
            }
        }

        // --- Orchestrator loop detection (execution mode only, after task assignment phase) ---
        if (isExecutingMode(OrchestratorState.currentState) && isPastTaskAssignmentPhase()) {
            const signature = buildTurnSignature();

            if (getLastTurnSignature() === signature) {
                incrementConsecutiveCount();
                if (getConsecutiveCount() >= ORCHESTRATOR_LOOP_THRESHOLD && !isLoopBreakerFired()) {
                    notifyTuiOnly(
                        pi,
                        `[orchestrator] Loop detected - ${getConsecutiveCount()} consecutive identical turns. Sending nudge message.`
                    );
                    setLoopBreakerFired();

                    // Pick a nudge tailored to the current phase so the model gets actionable direction.
                    const currentState = OrchestratorState.currentState;
                    let loopBreakerMessage: string;
                    if (currentState === "verifying") {
                        loopBreakerMessage =
                            "System loop-breaker: You are in VERIFICATION mode. All implementation tasks are complete. " +
                            "Inspect the completed work against the original goal, then call orchestrate_approve_goal when satisfied. " +
                            "Do NOT try to start already-completed tasks — if a task needs rework, create a new remediation task with orchestrate_add_task instead.";
                    } else {
                        loopBreakerMessage =
                            "System loop-breaker: You appear to be stuck in a repetitive pattern. Re-evaluate the current situation and take a different approach.";
                    }

                    try {
                        pi.sendMessage(
                            {
                                customType: "orchestrator_event",
                                content: loopBreakerMessage,
                                display: true
                            },
                            { triggerTurn: true }
                        );
                        // Reset both flag and counter so detection can fire again if the model ignores this nudge.
                        // Gives the model ORCHESTRATOR_LOOP_THRESHOLD turns to change course before next nudge.
                        resetLoopBreakerFlag();
                        resetConsecutiveCount();
                    } catch (e) {
                        notifyTuiOnly(pi, "Failed to send loop-breaker message: " + String(e));
                    }
                }
            } else {
                setLastTurnSignature(signature);
                resetConsecutiveCount();
                // Different turn pattern - reset the one-shot flag so we can detect again
                resetLoopBreakerFlag();
            }
        }
    });

    registerEnableCommand(pi);

    // Register /om-accept immediately so it appears second (after /om-enable)
    pi.registerCommand("om-accept", {
        description: "Manually approve and start execution (fallback - dialog normally appears after plan write)",
        handler: async (_args, ctx) => {
            if (!requireActive(ctx)) return;
            startExecutionFromPlan(pi, ctx);
        }
    });

    registerOrchestrationCommands(pi);
    registerTools(pi);
    setupUIWidget(pi);
    // Register TUI-only entry renderer for orchestration status notifications.
    // These appear in the transcript without polluting LLM context window.
    setupOrchestratorStatusRenderer(pi);
}

// ---------------------------------------------------------------------------
// Sub-agent idle / max-turns enforcement — runs every 2 s from watchdog timer
// ---------------------------------------------------------------------------

/**
 * Enforce global sub-agent limits (idle timeout, max turns) across all
 * registered agents. Kills the child process via SIGTERM and records the
 * kill reason so downstream code can report the correct failure message.
 */
function enforceSubAgentLimits(): void {
    const idleMs = OrchestratorState.subAgentIdleTimeoutMs;
    const maxTurns = OrchestratorState.subAgentMaxTurns;

    if (idleMs === 0 && maxTurns === 0) return; // both disabled — skip entirely

    for (const [agentId, state] of monitor.getAgentStates()) {
        const child = state.childProcess;
        if (!child || child.killed) continue;

        // Check idle timeout first.
        if (idleMs > 0 && state.lastActivityAt !== null) {
            const elapsedSinceLastActivity = Date.now() - state.lastActivityAt;
            if (elapsedSinceLastActivity > idleMs) {
                const _p = OrchestratorState.pi;
                if (_p) {
                    try {
                        _p.appendEntry("orchestration-status", {
                            title: "Sub-agent idle timeout",
                            message: `[watchdog] Sub-agent ${agentId} idle timeout — no JSON stream activity for ${formatTimeout(idleMs)} (last seen ${(elapsedSinceLastActivity / 1000).toFixed(0)}s ago). Killing.`,
                            timestamp: Date.now()
                        });
                    } catch {}
                }
                child.kill("SIGTERM");
                state.killedByWatchdog = "idle_timeout";
                continue; // don't also check max-turns for the same agent
            }
        }

        // Check max turns.
        if (maxTurns > 0 && state.turnCount >= maxTurns) {
            const _p = OrchestratorState.pi;
            if (_p) {
                try {
                    _p.appendEntry("orchestration-status", {
                        title: "Sub-agent max turns exceeded",
                        message: `[watchdog] Sub-agent ${agentId} exceeded max turns limit of ${maxTurns} (at turn ${state.turnCount}). Killing.`,
                        timestamp: Date.now()
                    });
                } catch {}
            }
            child.kill("SIGTERM");
            state.killedByWatchdog = "max_turns";
        }
    }
}
