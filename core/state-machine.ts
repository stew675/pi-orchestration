import { OrchestratorState } from "./state-singleton";
import type { OrchestrationPlan } from "./types";

/**
 * Well-defined orchestration states.
 *
 * - inactive: Extension not active (before /om-enable)
 * - planning: Building/editing plan
 * - reviewing: Plan under review (by reviewer model or user)
 * - reviewed: Plan approved, waiting for execution start
 * - implementing: Actively running tasks
 * - paused: User-initiated pause (graceful or stop)
 * - resuming: Resuming from pause/crash
 * - failed: Task failed, awaiting recovery
 * - verifying: All tasks done, awaiting orchestrate_approve_goal
 * - completed: orchestrate_approve_goal called, completely idle
 * - code_review: Automated code review in progress
 */
export type OrchestrationState =
  | "inactive"
  | "planning"
  | "reviewing"
  | "reviewed"
  | "implementing"
  | "paused"
  | "resuming"
  | "failed"
  | "verifying"
  | "completed"
  | "code_review";

/**
 * Valid state transitions - only these transitions are allowed.
 * Key: current state, Value: array of allowed next states.
 */
export const STATE_TRANSITIONS: Record<OrchestrationState, Array<OrchestrationState>> = {
  inactive: ["planning"],
  planning: ["reviewing", "implementing"],
  reviewing: ["planning", "implementing"],
  reviewed: ["implementing"],
  implementing: ["paused", "failed", "verifying", "code_review"],
  paused: ["implementing", "failed"],
  resuming: ["implementing", "failed"],
  failed: ["planning", "implementing"],
  verifying: ["completed"],
  completed: ["planning"],
  code_review: ["implementing", "verifying", "failed"],
};

/**
 * Current state derived from OrchestratorState + plan file.
 * This is the source of truth for the orchestrator's current state.
 */
export function getCurrentOrchestrationState(plan: OrchestrationPlan | null): OrchestrationState {
  if (!OrchestratorState.isActive) {
    return "inactive";
  }

  // Planning mode takes precedence
  if (OrchestratorState.planningMode) {
    return "planning";
  }

  // Implementation mode
  if (OrchestratorState.isExecuting) {
    if (plan?.status === "paused" || OrchestratorState._pauseReason) {
      return "paused";
    }
    if (plan?.status === "failed") {
      return "failed";
    }
    if (plan?.status === "verifying") {
      return "verifying";
    }
    if (plan?.status === "code_review") {
      return "code_review";
    }
    return "implementing";
  }

  // Idle but active - should not normally happen
  return "inactive";
}

/**
 * State transition function with validation.
 * Returns true if transition was successful, false if invalid.
 * Updates both OrchestratorState flags and plan.status.
 */
export function transitionTo(newState: OrchestrationState, plan: OrchestrationPlan): boolean {
  const currentState = getCurrentOrchestrationState(plan);

  if (!STATE_TRANSITIONS[currentState].includes(newState)) {
    console.warn(`[state-machine] Invalid transition: ${currentState} → ${newState}`);
    return false;
  }

  // Update OrchestratorState flags to reflect new state
  updateStateFlags(newState);

  // Update plan status to match
  plan.status = mapStateToPlanStatus(newState);

  return true;
}

/**
 * Update OrchestratorState boolean flags based on the target state.
 */
function updateStateFlags(state: OrchestrationState): void {
  // Reset all flags first
  OrchestratorState.isExecuting = false;
  OrchestratorState.planningMode = false;

  switch (state) {
    case "planning":
      OrchestratorState.planningMode = true;
      break;

    case "implementing":
    case "verifying":
    case "code_review":
      OrchestratorState.isExecuting = true;
      break;

    case "paused":
    case "failed":
    case "completed":
    case "inactive":
      OrchestratorState.isExecuting = false;
      OrchestratorState.planningMode = false;
      break;

    case "reviewing":
    case "reviewed":
    case "resuming":
      // These states can have isExecuting depending on context
      // Let the caller set appropriate flags if needed
      break;
  }
}

/**
 * Map orchestration state to plan.json status field.
 */
function mapStateToPlanStatus(state: OrchestrationState): OrchestrationPlan["status"] {
  const mapping: Record<OrchestrationState, OrchestrationPlan["status"]> = {
    inactive: "planning", // fallback
    planning: "planning",
    reviewing: "planning",
    reviewed: "planning",
    implementing: "implementing",
    paused: "paused",
    resuming: "implementing",
    failed: "failed",
    completed: "completed",
    verifying: "verifying",
    code_review: "code_review",
  };
  return mapping[state];
}

/**
 * Get all valid transitions from a given state for documentation/debugging.
 */
export function getValidTransitionsFrom(state: OrchestrationState): Array<OrchestrationState> {
  return STATE_TRANSITIONS[state] || [];
}
