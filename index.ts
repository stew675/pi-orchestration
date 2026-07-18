import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StateManager, drainPlanChangeListeners } from "./context/state-manager";
import { Runner } from "./runner";
import { killAllProcesses, activeProcesses } from "./process/process-manager";
import {
    OrchestratorState,
    updateActiveTools,
    resetState,
    beginShutdown,
    recoverInterruptedTasks,
    requireActive,
    switchToReviewerModel,
    restoreFromReviewPhase
} from "./core";
import {
    registerEnableCommand,
    registerOrchestrationCommands,
    startExecutionFromPlan,
    showAcceptOrEditDialog
} from "./commands/commands";
import { registerTools } from "./tools";
import { registerValidatorTools } from "./tools/validator-tools";
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

import { ORCHESTRATOR_PLANNING_SYSTEM_PROMPT, ORCHESTRATOR_EXECUTION_SYSTEM_PROMPT,
    PLANNING_HINT_PRE_WRITE, ORCHESTRATOR_REVIEW_SYSTEM_PROMPT } from "./context/prompts";

/** Watchdog timer interval (ms) — checks for stalled orchestrator every 2 seconds during execution. */
const WATCHDOG_INTERVAL_MS = 2000;
/** Number of consecutive idle turns before watchdog kicks the orchestrator. */
const WATCHDOG_IDLE_THRESHOLD = 5;
/** Delay (ms) before showing the Accept/Edit dialog after plan update, allowing tool output to render. */
const DIALOG_RENDER_DELAY_MS = 100;

export default function (pi: ExtensionAPI) {
    if (process.env.PI_ORCHESTRATION_SUB_AGENT === "true") {
        // Validator sub-agents need the signal tools but nothing else.
        registerValidatorTools(pi);
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
                const plan = StateManager.loadPlan();
                if (
                    !OrchestratorState.isActive ||
                    !OrchestratorState.isExecuting ||
                    OrchestratorState.planningMode ||
                    OrchestratorState._manualPause ||
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

        // Just notify about an existing plan - don't auto-activate orchestration.
        // The user must explicitly run /om-enable to proceed.
        const plan = StateManager.loadPlan();
        if (plan && plan.status !== "completed") {
            ctx.ui.notify(
                `Incomplete orchestration plan found: "${plan.goal}" (${plan.status}). Run /om-enable to resume or discard.`,
                "warning"
            );
        } else if (plan) {
            ctx.ui.notify(
                `Previous orchestration completed. Goal: "${plan.goal}". Run /om-enable to start a new plan.`,
                "info"
            );
        }

        updateActiveTools(pi);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
        // Signal the runner to stop writing stale state
        beginShutdown();
        // Cancel any in-flight task summaries
        Runner.cancelAllSummaries();
        // Clear plan change listeners to prevent leaks across sessions
        drainPlanChangeListeners();

        // Recover in-flight tasks and save them back to 'pending' on disk
        const plan = StateManager.loadPlan();
        if (plan) {
            const recovered = recoverInterruptedTasks(plan);
            if (recovered > 0) {
                try {
                    StateManager.savePlan(plan);
                } catch (e) {
                    console.error("Failed to persist recovered tasks during shutdown:", e);
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

        if (OrchestratorState.isActive) {
            // Capture the original system prompt on the first orchestration turn
            if (OrchestratorState.originalSystemPrompt === undefined) {
                OrchestratorState.originalSystemPrompt = event.systemPrompt;
            }

            // Select the appropriate prompt based on current phase.
            if (OrchestratorState._inReviewPhase) {
                return { systemPrompt: ORCHESTRATOR_REVIEW_SYSTEM_PROMPT };
            }

            if (OrchestratorState.isExecuting) {
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

    /** Intercept planning tool results and replace them with the full plan from disk.
     *  Also injects contextual hints at key moments for guidance-in-the-moment pattern. */
    pi.on("tool_result", async (event, ctx) => {
        if (!OrchestratorState.isActive || !OrchestratorState.planningMode || event.isError) return;

        if (event.toolName === "orchestrate_write_plan" || event.toolName === "orchestrate_edit_plan") {
            const planContent = StateManager.loadImplementationPlan();

            // If a reviewer model is configured, kick off the review cycle instead of
            // showing the Accept/Edit dialog immediately.
            if (OrchestratorState.reviewerModel) {
                OrchestratorState._inReviewPhase = true;
                switchToReviewerModel(pi, ctx).catch((e: Error) => {
                    console.error("Failed to switch to reviewer model:", e);
                    OrchestratorState._inReviewPhase = false;
                    OrchestratorState._planJustUpdated = true;
                });
            } else {
                // Flag that the plan was just updated - show Accept/Edit dialog on agent_settled.
                OrchestratorState._planJustUpdated = true;
            }

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
            }

            // orchestrate_edit_plan: show the full plan after each surgical edit.
            if (planContent) {
                return {
                    content: [{ type: "text", text: `--- Implementation Plan ---\n\n${planContent}` }]
                };
            }
        } else if (event.toolName === "orchestrate_review_plan" && OrchestratorState._inReviewPhase) {
            // Reviewer finished — switch back to planning model and instruct planner to process review.
            OrchestratorState._inReviewPhase = false;
            restoreFromReviewPhase(pi, ctx).then(() => {
                pi.sendMessage(
                    {
                        customType: "orchestrator_event",
                        content:
                            "System: The reviewer has completed its assessment. Read .pi/orchestration/plans/plan-review.md for the review findings. If you agree with any issues or recommendations, use orchestrate_edit_plan to make improvements. Then call orchestrate_present_plan to show the final plan to the user and STOP IMMEDIATELY.",
                        display: false
                    },
                    { deliverAs: "nextTurn", triggerTurn: true }
                );
            }).catch((e: Error) => {
                console.error("Failed to restore from review phase:", e);
            });
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
        if (OrchestratorState._planJustUpdated && !OrchestratorState._inReviewPhase && OrchestratorState.isActive && OrchestratorState.planningMode) {
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
        if (!OrchestratorState.isActive || !OrchestratorState.isExecuting || OrchestratorState.planningMode) return;

        recordToolExecution(event.toolCallId, event.toolName, event.args || {});
    });

    /** Track orchestrator tool calls per turn for loop detection.
     *  Run at turn_end to detect repetitive identical turns during execution mode. */
    pi.on("turn_end", async (_event, _ctx) => {
        // --- Orchestrator loop detection (execution mode only, after task assignment phase) ---
        if (
            OrchestratorState.isActive &&
            OrchestratorState.isExecuting &&
            !OrchestratorState.planningMode &&
            isPastTaskAssignmentPhase()
        ) {
            const signature = buildTurnSignature();

            if (getLastTurnSignature() === signature) {
                incrementConsecutiveCount();
                if (getConsecutiveCount() >= ORCHESTRATOR_LOOP_THRESHOLD && !isLoopBreakerFired()) {
                    console.warn(
                        `[orchestrator] Loop detected - ${getConsecutiveCount()} consecutive identical turns. Sending nudge message.`
                    );
                    setLoopBreakerFired();

                    try {
                        pi.sendMessage(
                            {
                                customType: "orchestrator_event",
                                content:
                                    "System loop-breaker: You appear to be stuck in a repetitive pattern. Re-evaluate the current situation and take a different approach.",
                                display: true
                            },
                            { triggerTurn: true }
                        );
                    } catch (e) {
                        console.error("Failed to send loop-breaker message:", e);
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
                console.warn(
                    `[watchdog] Sub-agent ${agentId} idle timeout — no JSON stream activity for ${formatTimeout(idleMs)} (last seen ${(elapsedSinceLastActivity / 1000).toFixed(0)}s ago). Killing.`
                );
                child.kill("SIGTERM");
                state.killedByWatchdog = "idle_timeout";
                continue; // don't also check max-turns for the same agent
            }
        }

        // Check max turns.
        if (maxTurns > 0 && state.turnCount >= maxTurns) {
            console.warn(
                `[watchdog] Sub-agent ${agentId} exceeded max turns limit of ${maxTurns} (at turn ${state.turnCount}). Killing.`
            );
            child.kill("SIGTERM");
            state.killedByWatchdog = "max_turns";
        }
    }
}