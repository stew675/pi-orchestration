import { OrchestratorState } from "./state-singleton";
import type { OrchestrationPlan } from "./types";

/**
 * Well-defined orchestration states.
 *
 * - inactive: Extension not active (before /om-enable)
 * - planning: Building/editing plan
 * - reviewing: Plan under review (by reviewer model or user)
 * - reviewed: Plan approved, waiting for execution start
 * - setup: Ready to create structured tasks after plan approval
 * - implementing: Actively running tasks
 * - replanning: Modifying tasks to recover from a failure
 * - pausing: Graceful pause requested, letting current task(s) finish
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
  | "setup"
  | "implementing"
  | "replanning"
  | "pausing"
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
  inactive: ["planning", "implementing", "setup", "replanning", "paused", "failed", "verifying", "completed", "code_review", "reviewing", "reviewed", "resuming"],
  planning: ["reviewing", "setup", "inactive"],
  reviewing: ["planning", "setup", "inactive"],
  reviewed: ["setup", "inactive"],
  setup: ["implementing", "inactive"],
  implementing: ["pausing", "paused", "failed", "verifying", "code_review", "replanning", "inactive"],
  replanning: ["implementing", "inactive"],
  pausing: ["paused", "failed", "inactive"],
  paused: ["implementing", "failed", "replanning", "inactive"],
  resuming: ["implementing", "failed", "inactive"],
  failed: ["replanning", "implementing", "inactive"],
  verifying: ["completed", "inactive"],
  completed: ["planning", "inactive"],
  code_review: ["implementing", "verifying", "failed", "inactive"],
};

/**
 * Current state of the orchestrator.
 * This is the single source of truth.
 */
export function getCurrentOrchestrationState(_plan: OrchestrationPlan | null): OrchestrationState {
  return OrchestratorState.currentState;
}

/** Fire TUI-only notification (non-fatal). */
function notifyTui(msg: string): void {
    const pi = OrchestratorState.pi;
    if (pi) {
        try {
            pi.appendEntry("orchestration-status", { title: msg.substring(0, 60).trim(), message: msg, timestamp: Date.now() });
        } catch { /* non-fatal */ }
    }
}

/**
 * State transition function with validation.
 * Returns true if transition was successful, false if invalid.
 * Updates OrchestratorState.currentState and maps plan.status to match.
 */
export function transitionTo(newState: OrchestrationState, plan: OrchestrationPlan): boolean {
  const currentState = OrchestratorState.currentState;

  if (!STATE_TRANSITIONS[currentState].includes(newState)) {
    notifyTui(`[state-machine] Invalid transition: ${currentState} → ${newState}`);
    return false;
  }

  // Update OrchestratorState.currentState directly as the single source of truth
  OrchestratorState.currentState = newState;

  // Update plan status to match as a projection of currentState
  plan.status = mapStateToPlanStatus(newState);

  return true;
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
    setup: "setup",
    implementing: "implementing",
    replanning: "replanning",
    pausing: "pausing",
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
 * Map plan status to orchestration state.
 */
export function mapPlanStatusToState(status: OrchestrationPlan["status"]): OrchestrationState {
  switch (status) {
    case "planning":
      return "planning";
    case "setup":
      return "setup";
    case "implementing":
      return "implementing";
    case "replanning":
      return "replanning";
    case "pausing":
      return "pausing";
    case "paused":
      return "paused";
    case "verifying":
      return "verifying";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "code_review":
      return "code_review";
    default:
      return "planning";
  }
}

/**
 * Get all valid transitions from a given state for documentation/debugging.
 */
export function getValidTransitionsFrom(state: OrchestrationState): Array<OrchestrationState> {
  return STATE_TRANSITIONS[state] || [];
}
