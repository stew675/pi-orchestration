import { ModelRef } from "./types";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
    OrchestrationPlan,
    DEFAULT_TASK_TIMEOUT_MS,
    DEFAULT_VALIDATOR_TIMEOUT_MS,
    DEFAULT_SUMMARY_TIMEOUT_MS,
    DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS,
    DEFAULT_SUB_AGENT_MAX_TURNS
} from "./types";
import { VALIDATE_PASS_TOOL, VALIDATE_FAIL_TOOL } from "../tools/validator-tools";
import { getCurrentOrchestrationState, transitionTo, isActive as stateIsActive, isPlanningMode, isExecutingMode, type OrchestrationState } from "./state-machine";

/**
 * Central orchestrator state singleton.
 *
 * @internal This object is mutated by core lifecycle functions and settings helpers.
 * External modules should NOT directly assign properties on this object. Use the
 * setter functions exported from `core.ts` (`setOrchestrationMode`, `resetState`,
 * `beginShutdown`, etc.) or the settings-menu setters for configuration values.
 * Direct property reads are acceptable for guards using state predicates
 * (e.g., `isActive(OrchestratorState.currentState)`).
 */
export const OrchestratorState = {
    // --- Current Orchestration Extention State ---
    currentState: "inactive" as OrchestrationState,
    pi: undefined as ExtensionAPI | undefined,
    theme: null as Theme | null,

    // --- Configured Models ---
    simpleTaskModel: null as ModelRef | null,
    complexTaskModel: null as ModelRef | null,
    summaryModel: null as ModelRef | null,
    validatorModel: null as ModelRef | null,
    orchestrationModel: null as ModelRef | null,
    planningModel: null as ModelRef | null,
    reviewerModel: null as ModelRef | null,
    codeReviewModel: null as ModelRef | null,

    // --- Concurrency controls ---
    summarizationConcurrency: 0,
    parallelTasks: 1,

    // --- Configurable behaviour ---
    allowStopTool: true, // when false, orchestrate_stop returns a nudge instead of halting
    validateSimpleTasks: false, // validation for simple tasks (default off)
    validateComplexTasks: true, // validation for complex tasks (default on)
    debugLogTransitions: false, // log state transitions to TUI notifications (default off)

    // --- Configurable timeouts (milliseconds; 0 = no timeout) ---
    taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS, // default watchdog for sub-agent tasks (12 min)
    validatorTimeoutMs: DEFAULT_VALIDATOR_TIMEOUT_MS, // default watchdog for validation agents (4 min)
    taskSummaryTimeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS, // default watchdog for task summary agents (2 min)

    // --- Global sub-agent limits ---
    subAgentIdleTimeoutMs: DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS, // idle timeout for any sub-agent (5m30s; 0 = disabled)
    subAgentMaxTurns: DEFAULT_SUB_AGENT_MAX_TURNS, // max model turns for any sub-agent (30; 0 = unlimited)

    // --- Dynamic/Temporary Inter/Intra-State values ---
    /** Original main model captured when entering orchestration mode - restored on exit. */
    originalMainModel: undefined as ModelRef | undefined,
    /** Model active before entering planning mode (orchestration or main) - restored when exiting planning. */
    prePlanningModel: undefined as ModelRef | undefined,
    /** Model active before switching to the reviewer model - restored after review phase completes. */
    preReviewModel: undefined as ModelRef | undefined,
    /** Original system prompt captured on first orchestration turn - restored on exit. */
    originalSystemPrompt: undefined as string | undefined,
    /** One-time flag: inject a restoration message on the next agent turn after exit. */
    pendingSystemPromptRestore: false,
    /** One-shot flag: when true, the next context request will be pruned to zero. */
    shouldResetContext: false,
    /** One-shot flag: plan was just written/edited by the agent - show Accept/Edit dialog on next turn_end. */
    _planJustUpdated: false,
    /** Tracks whether the plan was edited since the last presentation or user feedback. */
    _planEditedThisTurn: false,
    /** One-shot flag: pre-write quality hint sent. Fires once on first orchestrate_write_plan call. */
    _preWriteHintSent: false,
    /** One-shot flag: true while the reviewer model is active during plan review cycle. */
    _inReviewPhase: false,
    /** Flag indicating that the planner is currently incorporating feedback from a recent review.
     *  While true, updates to the plan will not trigger a new automatic review cycle. */
    _incorporatingFeedback: false,
    /** One-shot flag: reviewer is scheduled to start on agent_settled. */
    _pendingReviewStart: false,
    /** One-shot flag: reviewer is scheduled to complete and switch back on agent_settled. */
    _pendingReviewCompletion: false,
    /** Flag to prevent writing stale data to disk while shutting the orchestration mode down */
    shuttingDown: false
};

/**
 * Transition the orchestrator into a specific mode.
 * Sets the current state via transitionTo, updates active tools,
 * and calls an optional callback (e.g. TUI border refresh).
 *
 * @param state     - The target OrchestrationState
 * @param pi        - ExtensionAPI (for tool updates)
 * @param onMode    - Optional callback invoked with the resolved mode string
 * @param plan      - Optional OrchestrationPlan to sync state to
 */
export function setOrchestrationMode(
    state: OrchestrationState,
    pi: ExtensionAPI,
    onMode?: (mode: "inactive" | "planning" | "executing" | "idle") => void,
    plan?: OrchestrationPlan
) {
    // Delegate state transition and plan status sync to transitionTo
    transitionTo(state, plan, true);

    updateActiveTools(pi);

    // Derive canonical mode label for callbacks (TUI border, etc.)
    const mode: "inactive" | "planning" | "executing" | "idle" =
        state === "inactive"
            ? "inactive"
            : isPlanningMode(state)
              ? "planning"
              : isExecutingMode(state)
                ? "executing"
                : "idle";

    onMode?.(mode);
}

/** Standard message shown when orchestration is not active. */
export const NOT_ACTIVE_MSG = "Orchestration not active. Run /om-enable first.";

/** Assert that the orchestrator extension has been initialized. */
export function getPi(): ExtensionAPI {
    if (!OrchestratorState.pi) {
        throw new Error("OrchestratorState.pi not initialized. Ensure session_start has fired.");
    }
    return OrchestratorState.pi;
}

/**
 * Guard for orchestration commands - returns true if the command should proceed.
 * When false, a "not active" message is shown via ctx.ui.notify.
 */
export function requireActive(ctx: {
    ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void };
}): boolean {
    if (!stateIsActive(OrchestratorState.currentState)) {
        ctx.ui.notify(NOT_ACTIVE_MSG, "warning");
        return false;
    }
    return true;
}

/** Default values for all OrchestratorState properties. */
const STATE_DEFAULTS = {
    currentState: "inactive" as OrchestrationState,
    theme: null as Theme | null,
    simpleTaskModel: null as ModelRef | null,
    complexTaskModel: null as ModelRef | null,
    summaryModel: null as ModelRef | null,
    validatorModel: null as ModelRef | null,
    orchestrationModel: null as ModelRef | null,
    planningModel: null as ModelRef | null,
    reviewerModel: null as ModelRef | null,
    codeReviewModel: null as ModelRef | null,
    originalMainModel: undefined as ModelRef | undefined,
    prePlanningModel: undefined as ModelRef | undefined,
    preReviewModel: undefined as ModelRef | undefined,
    shuttingDown: false,
    originalSystemPrompt: undefined as string | undefined,
    pendingSystemPromptRestore: false,
    shouldResetContext: false,
    _planJustUpdated: false,
    _planEditedThisTurn: false,
    _preWriteHintSent: false,
    _inReviewPhase: false,
    _incorporatingFeedback: false,
    _pendingReviewStart: false,
    _pendingReviewCompletion: false,
    allowStopTool: true,
    validateSimpleTasks: false,
    validateComplexTasks: true,
    debugLogTransitions: false,
    taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    validatorTimeoutMs: DEFAULT_VALIDATOR_TIMEOUT_MS,
    taskSummaryTimeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS,

    // --- Global sub-agent limits ---
    subAgentIdleTimeoutMs: DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS,
    subAgentMaxTurns: DEFAULT_SUB_AGENT_MAX_TURNS,

    summarizationConcurrency: 0
};

/**
 * Reset all in-memory orchestrator state. Called on session_start to ensure
 * a clean slate after reload or session replacement.
 */
export function resetState(): void {
    for (const [key, value] of Object.entries(STATE_DEFAULTS)) {
        (OrchestratorState as Record<string, unknown>)[key] = value;
    }
}

/**
 * Signal that orchestration is exiting. Sets a flag so the next `before_agent_start`
 * hook fires a one-shot restoration of the original system prompt, ensuring the model
 * stops behaving as an orchestrator on the very next turn.
 */
export function requestSystemPromptRestore(): void {
    OrchestratorState.pendingSystemPromptRestore = true;
}

/**
 * Capture the current main model before switching to orchestration mode.
 */
export function captureCurrentModel(model: ModelRef): void {
    OrchestratorState.originalMainModel = model;
}

/**
 * Switch to the configured orchestration model.
 * Called when entering orchestration mode. Returns true if a switch occurred.
 */
export async function switchToOrchestrationModel(
    pi: ExtensionAPI,
    ctx: { modelRegistry: { find: (provider: string, id: string) => any }; ui?: { notify?: (...args: any[]) => void } }
): Promise<boolean> {
    const orchModel = OrchestratorState.orchestrationModel;
    if (!orchModel) return false;

    const targetModel = ctx.modelRegistry.find(orchModel.provider, orchModel.id);
    if (!targetModel) {
        const pi = OrchestratorState.pi;
        if (pi) {
            try { pi.appendEntry("orchestration-status", { title: "Orchestration model not found", message: `Orchestration model ${orchModel.provider}/${orchModel.id} not found in registry.`, timestamp: Date.now() }); } catch {}
        }
        return false;
    }

    const success = await pi.setModel(targetModel);
    if (success) {
        return true;
    }
    const pi2 = OrchestratorState.pi;
    if (pi2) {
        try { pi2.appendEntry("orchestration-status", { title: "No API key for orchestration model", message: `No API key available for orchestration model ${orchModel.provider}/${orchModel.id}.`, timestamp: Date.now() }); } catch {}
    }
    return false;
}

/**
 * Restore the original main model that was active before entering orchestration mode.
 * Called when exiting orchestration mode. Returns true if a switch occurred.
 */
export async function restoreMainModel(
    pi: ExtensionAPI,
    ctx: { modelRegistry: { find: (provider: string, id: string) => any }; ui?: { notify?: (...args: any[]) => void } }
): Promise<boolean> {
    const original = OrchestratorState.originalMainModel;
    if (!original) return false;

    const targetModel = ctx.modelRegistry.find(original.provider, original.id);
    if (!targetModel) {
        const p = OrchestratorState.pi;
        if (p) { try { p.appendEntry("orchestration-status", { title: "Original model not found", message: `Original model ${original.provider}/${original.id} not found in registry.`, timestamp: Date.now() }); } catch {} }
        return false;
    }

    const success = await pi.setModel(targetModel);
    OrchestratorState.originalMainModel = undefined; // cleared on successful restore
    if (success) {
        return true;
    }
    const p2 = OrchestratorState.pi;
    if (p2) { try { p2.appendEntry("orchestration-status", { title: "No API key for original model", message: `No API key available for original model ${original.provider}/${original.id}.`, timestamp: Date.now() }); } catch {} }
    return false;
}

/**
 * Switch to the configured planning model.
 * Captures the currently active model so it can be restored when exiting planning.
 * Called when entering planning mode. Returns true if a switch occurred.
 */
export async function enterPlanningMode(
    pi: ExtensionAPI,
    ctx: {
        model?: ModelRef;
        modelRegistry: { find: (provider: string, id: string) => any };
        ui?: { notify?: (...args: any[]) => void };
    }
): Promise<void> {
    // Capture the current active model before switching
    if (ctx.model && OrchestratorState.prePlanningModel === undefined) {
        OrchestratorState.prePlanningModel = { provider: ctx.model.provider, id: ctx.model.id };
    }

    const planningModel = OrchestratorState.planningModel;
    if (!planningModel) return;

    const targetModel = ctx.modelRegistry.find(planningModel.provider, planningModel.id);
    if (!targetModel) {
        const p = OrchestratorState.pi;
        if (p) { try { p.appendEntry("orchestration-status", { title: "Planning model not found", message: `Planning model ${planningModel.provider}/${planningModel.id} not found in registry.`, timestamp: Date.now() }); } catch {} }
        return;
    }

    const success = await pi.setModel(targetModel);
    if (success) {
        ctx.ui?.notify?.(`Switched to planning model: ${planningModel.provider}/${planningModel.id}`, "info");
    } else {
        const _p1 = OrchestratorState.pi;
        if (_p1) { try { _p1.appendEntry("orchestration-status", { title: "Orchestration status", message: `No API key available for planning model ${planningModel.provider}/${planningModel.id}.`, timestamp: Date.now() }); } catch {} };
        ctx.ui?.notify?.(
            `Cannot switch to planning model ${planningModel.provider}/${planningModel.id} - no configured API key.`,
            "warning"
        );
    }
}

/**
 * Restore the model that was active before entering planning mode.
 * Called when exiting planning (via /om-plan off, /om-accept, or /om-resume).
 */
export async function exitPlanningMode(
    pi: ExtensionAPI,
    ctx: { modelRegistry: { find: (provider: string, id: string) => any }; ui?: { notify?: (...args: any[]) => void } }
): Promise<void> {
    const pre = OrchestratorState.prePlanningModel;
    if (!pre) {
        OrchestratorState.prePlanningModel = undefined;
        return;
    }

    const targetModel = ctx.modelRegistry.find(pre.provider, pre.id);
    if (!targetModel) {
        const _p2 = OrchestratorState.pi;
        if (_p2) { try { _p2.appendEntry("orchestration-status", { title: "Orchestration status", message: `Pre-planning model ${pre.provider}/${pre.id} not found in registry.`, timestamp: Date.now() }); } catch {} };
        OrchestratorState.prePlanningModel = undefined;
        return;
    }

    const success = await pi.setModel(targetModel);
    if (success) {
        ctx.ui?.notify?.("Restored pre-planning model.", "info");
    } else {
        const _p3 = OrchestratorState.pi;
        if (_p3) { try { _p3.appendEntry("orchestration-status", { title: "Orchestration status", message: `No API key available for pre-planning model ${pre.provider}/${pre.id}.`, timestamp: Date.now() }); } catch {} };
        ctx.ui?.notify?.(
            `Cannot restore pre-planning model ${pre.provider}/${pre.id} - no configured API key.`,
            "warning"
        );
    }
    OrchestratorState.prePlanningModel = undefined;
}

/**
 * Switch to the configured reviewer model for plan review.
 * Keeps conversation history intact (no context reset).
 * Captures the currently active model so it can be restored via `restoreFromReviewPhase`.
 */
export async function switchToReviewerModel(
    pi: ExtensionAPI,
    ctx: { model?: ModelRef; modelRegistry: { find: (provider: string, id: string) => any }; ui?: { notify?: (...args: any[]) => void } }
): Promise<boolean> {
    // Capture the current active model before switching
    if (ctx.model && OrchestratorState.preReviewModel === undefined) {
        OrchestratorState.preReviewModel = { provider: ctx.model.provider, id: ctx.model.id };
    }

    const reviewerModel = OrchestratorState.reviewerModel;
    if (!reviewerModel) return false;

    const targetModel = ctx.modelRegistry.find(reviewerModel.provider, reviewerModel.id);
    if (!targetModel) {
        const _p4 = OrchestratorState.pi;
        if (_p4) { try { _p4.appendEntry("orchestration-status", { title: "Orchestration status", message: `Reviewer model ${reviewerModel.provider}/${reviewerModel.id} not found in registry.`, timestamp: Date.now() }); } catch {} };
        return false;
    }

    const success = await pi.setModel(targetModel);
    if (success) {
        ctx.ui?.notify?.(`Switched to reviewer model: ${reviewerModel.provider}/${reviewerModel.id}`, "info");
    } else {
        const _p5 = OrchestratorState.pi;
        if (_p5) { try { _p5.appendEntry("orchestration-status", { title: "Orchestration status", message: `No API key available for reviewer model ${reviewerModel.provider}/${reviewerModel.id}.`, timestamp: Date.now() }); } catch {} };
        ctx.ui?.notify?.(
            `Cannot switch to reviewer model ${reviewerModel.provider}/${reviewerModel.id} - no configured API key.`,
            "warning"
        );
    }
    return success;
}

/**
 * Restore the model that was active before the review phase.
 * Called when exiting plan review (after reviewer completes its assessment).
 */
export async function restoreFromReviewPhase(
    pi: ExtensionAPI,
    ctx: { modelRegistry: { find: (provider: string, id: string) => any }; ui?: { notify?: (...args: any[]) => void } }
): Promise<void> {
    const pre = OrchestratorState.preReviewModel;
    if (!pre) {
        OrchestratorState.preReviewModel = undefined;
        return;
    }

    const targetModel = ctx.modelRegistry.find(pre.provider, pre.id);
    if (!targetModel) {
        const _p6 = OrchestratorState.pi;
        if (_p6) { try { _p6.appendEntry("orchestration-status", { title: "Orchestration status", message: `Pre-review model ${pre.provider}/${pre.id} not found in registry.`, timestamp: Date.now() }); } catch {} };
        OrchestratorState.preReviewModel = undefined;
        return;
    }

    const success = await pi.setModel(targetModel);
    if (success) {
        ctx.ui?.notify?.("Restored pre-review model.", "info");
    } else {
        const _p7 = OrchestratorState.pi;
        if (_p7) { try { _p7.appendEntry("orchestration-status", { title: "Orchestration status", message: `No API key available for pre-review model ${pre.provider}/${pre.id}.`, timestamp: Date.now() }); } catch {} };
        ctx.ui?.notify?.(
            `Cannot restore pre-review model ${pre.provider}/${pre.id} - no configured API key.`,
            "warning"
        );
    }
    OrchestratorState.preReviewModel = undefined;
}

/**
 * Mark the orchestrator as shutting down. Runner close handlers check this flag
 * to avoid writing stale state after session_shutdown has begun.
 */
export function beginShutdown(): void {
    OrchestratorState.shuttingDown = true;
}

/**
 * Update the set of active tools based on current orchestration mode.
 *
 * - **Inactive** - hides all orchestration tools, keeps base tools
 * - **Planning** - base tools + plan management (`orchestrate_write_plan`, `orchestrate_edit_plan`, `orchestrate_present_plan`)
 * - **Executing** - base tools + execution/task manipulation tools
 * - **Idle** - base tools only (exploration, no orchestration tools)
 *
 * Must be called after any mode change to ensure correct tool availability.
 */
export function updateActiveTools(pi: ExtensionAPI) {
    const allTools = pi.getAllTools();
    const BASE_TOOLS = ["read", "ls", "grep", "find"];

    if (!stateIsActive(OrchestratorState.currentState)) {
        // Inactive - hide all orchestration tools
        const orchestratorToolNames = getAllOrchestrationToolNames();
        const active = allTools.filter((t) => !orchestratorToolNames.includes(t.name)).map((t) => t.name);
        pi.setActiveTools(active);
    } else if (isPlanningMode(OrchestratorState.currentState)) {
        // Planning - exploration tools + plan management only.
        // Block/task manipulation is gated until user approves via /om-accept.
        const active = allTools.filter((t) => [...BASE_TOOLS, ...PLANNING_TOOLS].includes(t.name)).map((t) => t.name);
        pi.setActiveTools(active);
    } else if (isExecutingMode(OrchestratorState.currentState)) {
        // Executing - show execution tools only (plan writing is gated; plan is already approved)
        const active = allTools.filter((t) => [...BASE_TOOLS, ...EXECUTION_TOOLS].includes(t.name)).map((t) => t.name);
        pi.setActiveTools(active);
    } else {
        // Idle (orchestration active but not planning or executing) - exploration only
        const active = allTools.filter((t) => BASE_TOOLS.includes(t.name)).map((t) => t.name);
        pi.setActiveTools(active);
    }
}

/** Orchestration tools that are safe to use during planning (plan file management). */
const PLANNING_TOOLS = ["orchestrate_write_plan", "orchestrate_edit_plan", "orchestrate_present_plan", "orchestrate_review_plan"];

/** Task manipulation tools - only available outside of planning mode. */
const EXECUTION_TOOLS = [
    "orchestrate_add_task",
    "orchestrate_delete_task",
    "orchestrate_complete_task",
    "orchestrate_edit_task",
    "orchestrate_get_plan",
    "orchestrate_ready_tasks",
    "orchestrate_start_task",
    "orchestrate_check_status",
    "orchestrate_replan",
    "orchestrate_resume_task",
    "orchestrate_stop",
    "orchestrate_approve_goal",
    "orchestrate_bulk_update_tasks",
    "orchestrate_complete_review"
];

function getAllOrchestrationToolNames(): string[] {
    return [...PLANNING_TOOLS, ...EXECUTION_TOOLS, VALIDATE_PASS_TOOL, VALIDATE_FAIL_TOOL, "orchestrate_code_review_approve", "orchestrate_code_review_reject"];
}

/**
 * Resolve the effective model for a task sub-agent based on its complexity annotation.
 *
 * Priority chain:
 *   1. Complexity-specific model (simpleTaskModel / complexTaskModel)
 *   2. Fallback model (from ctx)
 *   3. undefined (pi default)
 *
 * When in doubt (unknown/missing complexity), defaults to the complex model.
 */
export function resolveTaskModelByComplexity(
    complexity: "simple" | "complex",
    fallback?: ModelRef
): ModelRef | undefined {
    const specific = complexity === "simple" ? OrchestratorState.simpleTaskModel : OrchestratorState.complexTaskModel;
    if (specific) return specific;
    // In doubt, prefer the complex model over nothing.
    if (OrchestratorState.complexTaskModel) return OrchestratorState.complexTaskModel;
    return fallback;
}

/**
 * Resolve the effective model for validator agents.
 * Priority: configured validatorModel → complexTaskModel → fallback model (from ctx) → undefined (pi default)
 */
export function resolveValidatorModel(fallback?: { provider: string; id: string }): ModelRef | undefined {
    if (OrchestratorState.validatorModel) return OrchestratorState.validatorModel;
    if (OrchestratorState.complexTaskModel) return OrchestratorState.complexTaskModel;
    return fallback;
}

/**
 * Resolve the effective model for task-summary agents.
 * Priority: configured summaryModel → simpleTaskModel → fallback model (from ctx) → undefined (pi default)
 */
export function resolveSummaryModel(fallback?: { provider: string; id: string }): ModelRef | undefined {
    if (OrchestratorState.summaryModel) return OrchestratorState.summaryModel;
    if (OrchestratorState.simpleTaskModel) return OrchestratorState.simpleTaskModel;
    return fallback;
}

/**
 * Format a model for display, or return "(default)".
 */
export function formatModel(m: ModelRef | null | undefined): string {
    if (!m) return "(default)";
    return `${m.provider}/${m.id}`;
}

/** Count tasks by status. */
function countTasksByStatus(plan: OrchestrationPlan): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const task of plan.tasks || []) {
        counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return counts;
}

/**
 * Recover interrupted tasks: any task in 'running' or 'validating' was mid-execution.
 * Returns the number of recovered tasks.
 */
export function recoverInterruptedTasks(plan: OrchestrationPlan): number {
    let recovered = 0;
    for (const task of plan.tasks || []) {
        if (task.status === "running" || task.status === "validating" || task.status === "summarizing") {
            task.status = "pending";
            task.validatorFeedback = undefined;
            recovered++;
        }
    }
    return recovered;
}

/** Granular execution phase labels for the TUI status display. */
export type ExecutionPhaseLabel = "PLANNING" | "SETUP" | "IMPLEMENTING" | "REPLANNING" | "PAUSED" | "STOPPED" | "VERIFYING" | "PLAN_REVIEW" | "CODE_REVIEW" | "COMPLETED" | "FAILED";

/**
 * Compute a granular execution phase label for display.
 * Uses the state machine to derive the current state from OrchestratorState.
 * Returns null when not in an execution-like state (planning mode or inactive).
 */
export function computeExecutionPhaseLabel(): ExecutionPhaseLabel | null {
    // Get canonical state from state machine
    const state = getCurrentOrchestrationState();

    // Map state to phase label
    const stateToPhase: Record<OrchestrationState, ExecutionPhaseLabel | null> = {
        inactive: null,
        planning: "PLANNING",
        plan_review: "PLAN_REVIEW",
        plan_reviewed: "PLANNING",
        setup: "SETUP",
        implementing: "IMPLEMENTING",
        replanning: "REPLANNING",
        pausing: "PAUSED",
        paused: "PAUSED",
        stopped: "STOPPED",
        resuming: "IMPLEMENTING",
        failed: "FAILED",
        completed: "COMPLETED",
        verifying: "VERIFYING",
        code_review: "CODE_REVIEW",
    };

    return stateToPhase[state] ?? null;
}

/** Strip the `task_` prefix for display (label already says "Task:"). */
export function stripTaskPrefix(id: string): string {
    return id.startsWith("task_") ? id.slice(5) : id;
}

/** Truncate a task description to a single displayable line for compact status views.
 *  Pipeline:
 *    1) Hard truncate at maxChars
 *    2) Strip everything from the first newline / carriage return onwards
 *    3) If a `. ` (period + space) is found, strip from there (keep the period)
 *    4) If result is exactly maxChars long, replace last char with ellipsis
 *    5) Return what remains trimmed */
export function truncateToSentence(text: string, maxChars: number = 120): string {
    // 1. Hard truncate — nothing longer than maxChars
    let s = text.length > maxChars ? text.slice(0, maxChars) : text;

    // 2. Strip from first newline / carriage return onwards (guarantee single line)
    const nlIdx = s.indexOf('\n');
    const crIdx = s.indexOf('\r');
    let cut: number | undefined;
    if (nlIdx >= 0 && crIdx >= 0) {
        cut = Math.min(nlIdx, crIdx);
    } else if (nlIdx >= 0) {
        cut = nlIdx;
    } else if (crIdx >= 0) {
        cut = crIdx;
    }
    if (cut !== undefined) {
        s = s.slice(0, cut);
    }

    // 3. Find first `. ` and strip from there (keep the period)
    const periodSpaceIdx = s.indexOf('. ');
    if (periodSpaceIdx >= 0) {
        s = s.slice(0, periodSpaceIdx + 1); // include the dot
    }

    // 4. If we ended up at exactly maxChars, the text was hard-truncated —
    //    replace the last character with an ellipsis (no length increase).
    if (s.length === maxChars) {
        s = s.slice(0, -1) + "\u2026";
    }

    return s.trim();
}

/**
 * Build a human-readable status summary for display.
 */
export function buildStatusSummary(plan: OrchestrationPlan): string {
    const counts = countTasksByStatus(plan);
    const parts: string[] = [];

    // Show phase/status indicator with granular label when in execution
    const state = OrchestratorState.currentState;
    if (isPlanningMode(state)) {
        parts.push(`Orchestration Status: planning`);
    } else if (isExecutingMode(state)) {
        const phase = computeExecutionPhaseLabel();
        const label = phase ? `${phase.toLowerCase()}` : plan.status;
        parts.push(`Orchestration Status: ${label}`);
    } else {
        parts.push(`Orchestration Status: ${plan.status}`);
    }

    if (plan.currentTaskId) {
        const task = (plan.tasks || []).find((t) => t.id === plan.currentTaskId);
        if (task) {
            parts.push(`Current task: ${stripTaskPrefix(task.id)} [${task.status}]`);
        }
    }

    // Task summary
    const taskParts: string[] = [];
    for (const [status, count] of Object.entries(counts)) {
        taskParts.push(`${count} ${status}`);
    }
    parts.push(`Tasks: ${taskParts.join(", ")}`);

    return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Setter helpers - centralised mutation points for settings-menu.ts
// ---------------------------------------------------------------------------

/** Set summarization concurrency with optional range validation (min 0). */
export function setSummarizationConcurrency(value: number): void {
    OrchestratorState.summarizationConcurrency = Math.max(0, value);
}

/** Set parallel task count with minimum of 1. */
export function setParallelTasks(value: number): void {
    OrchestratorState.parallelTasks = Math.max(1, value);
}

/** Set a timeout value (ms). 0 means no timeout. */
export function setTimeoutMs(
    key: "taskTimeoutMs" | "validatorTimeoutMs" | "taskSummaryTimeoutMs" | "subAgentIdleTimeoutMs",
    value: number
): void {
    if (key === "taskTimeoutMs") OrchestratorState.taskTimeoutMs = Math.max(0, value);
    else if (key === "validatorTimeoutMs") OrchestratorState.validatorTimeoutMs = Math.max(0, value);
    else if (key === "taskSummaryTimeoutMs") OrchestratorState.taskSummaryTimeoutMs = Math.max(0, value);
    else OrchestratorState.subAgentIdleTimeoutMs = Math.max(0, value);
}

/** Set the global max-turns limit for sub-agents. 0 means unlimited. */
export function setSubAgentMaxTurns(value: number): void {
    OrchestratorState.subAgentMaxTurns = Math.max(0, value);
}

/** Toggle a boolean setting on OrchestratorState. */
export function setBooleanSetting(
    key: "allowStopTool" | "validateSimpleTasks" | "validateComplexTasks" | "debugLogTransitions",
    value: boolean
): void {
    if (key === "allowStopTool") OrchestratorState.allowStopTool = value;
    else if (key === "validateSimpleTasks") OrchestratorState.validateSimpleTasks = value;
    else if (key === "validateComplexTasks") OrchestratorState.validateComplexTasks = value;
    else OrchestratorState.debugLogTransitions = value;
}

/** Set a model reference on OrchestratorState by key. Centralizes mutation of model config properties. */
export function setModelRef(
    key: keyof Pick<
        typeof OrchestratorState,
        | "simpleTaskModel"
        | "complexTaskModel"
        | "summaryModel"
        | "validatorModel"
        | "orchestrationModel"
        | "planningModel"
        | "reviewerModel"
        | "codeReviewModel"
    >,
    value: ModelRef | null
): void {
    (OrchestratorState as any)[key] = value;
}
