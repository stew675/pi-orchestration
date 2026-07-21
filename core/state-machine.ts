import { OrchestratorState, getPlanDb, notifyTui as coreNotifyTui } from "./state-singleton";
import type { OrchestrationState } from "./types";

export type { OrchestrationState };

/**
 * Valid state transitions - only these transitions are allowed.
 * Key: current state, Value: array of allowed next states.
 */
export const STATE_TRANSITIONS: Record<OrchestrationState, Array<OrchestrationState>> = {
  inactive: ["planning", "implementing", "setup", "replanning", "paused", "stopped", "failed", "verifying", "completed", "code_review", "plan_review", "plan_reviewed", "resuming"],
  planning: ["plan_review", "setup", "inactive"],
  plan_review: ["planning", "setup", "inactive"],
  plan_reviewed: ["setup", "inactive"],
  setup: ["implementing", "stopped", "inactive"],
  implementing: ["pausing", "paused", "stopped", "failed", "verifying", "code_review", "replanning", "inactive"],
  replanning: ["implementing", "inactive"],
  pausing: ["paused", "failed", "inactive"],
  paused: ["implementing", "failed", "replanning", "inactive"],
  stopped: ["implementing", "replanning", "inactive"],
  resuming: ["implementing", "failed", "inactive"],
  failed: ["replanning", "implementing", "inactive"],
  verifying: ["implementing", "replanning", "completed", "inactive"],
  completed: ["planning", "inactive"],
  code_review: ["implementing", "verifying", "stopped", "failed", "inactive"],
};

/**
 * Current state of the orchestrator.
 * This is the single source of truth.
 */
export function getCurrentOrchestrationState(): OrchestrationState {
  return OrchestratorState.currentState;
}



/**
 * State transition function with validation.
 * Returns true if transition was successful, false if invalid.
 * Updates OrchestratorState.currentState.
 */
export function transitionTo(newState: OrchestrationState, force = false): boolean {
  const currentState = OrchestratorState.currentState;

  if (!force && !STATE_TRANSITIONS[currentState].includes(newState)) {
    coreNotifyTui(`[state-machine] Invalid transition: ${currentState} → ${newState}`);
    return false;
  }

  if (OrchestratorState.debugLogTransitions) {
    coreNotifyTui(`[state-machine] State transition: ${currentState} → ${newState}`);
  }

  // Update OrchestratorState.currentState directly as the single source of truth
  OrchestratorState.currentState = newState;

  // Sync to PlanDatabase if loaded
  const planDb = getPlanDb();
  if (planDb && planDb.getStatus() !== newState) {
    planDb.setStatus(newState);
  }

  return true;
}

// ---------------------------------------------------------------------------
// State predicates — pure functions derived from the canonical state enum.
// Replace all usage of OrchestratorState.isActive / .planningMode / .isExecuting.
// ---------------------------------------------------------------------------

/** Orchestrator has been activated (any state other than inactive). */
export function isActive(state: OrchestrationState): boolean {
  return state !== "inactive";
}

/** Orchestrator is in a planning-phase state (building or reviewing the plan). */
export function isPlanningMode(state: OrchestrationState): boolean {
  return state === "planning" || state === "plan_review" || state === "plan_reviewed";
}

/** Orchestrator is in an execution-phase state (any active implementation lifecycle state). */
export function isExecutingMode(state: OrchestrationState): boolean {
  const executingStates: OrchestrationState[] = [
    "setup", "replanning", "implementing", "pausing", "paused", "stopped",
    "resuming", "failed", "verifying", "code_review"
  ];
  return executingStates.includes(state);
}
