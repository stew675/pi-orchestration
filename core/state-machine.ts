import { OrchestratorState } from "./state-singleton";
import type { OrchestrationPlan } from "./types";

/**
 * Well-defined orchestration states.
 *
 * - inactive: Extension not active (before /om-enable)
 * - planning: Building/editing plan
 * - plan_review: Plan under review (by reviewer model or user)
 * - plan_reviewed: Plan approved, waiting for execution start
 * - setup: Ready to create structured tasks after plan approval
 * - implementing: Actively running tasks
 * - replanning: Modifying tasks to recover from a failure
 * - pausing: Graceful pause requested, letting current task(s) finish
 * - paused: User-initiated graceful pause
 * - stopped: Immediate halt (/om-stop or orchestrate_stop)
 * - resuming: Resuming from pause/crash
 * - failed: Task failed, awaiting recovery
 * - verifying: All tasks done, awaiting orchestrate_approve_goal
 * - completed: orchestrate_approve_goal called, completely idle
 * - code_review: Automated code review in progress
 */
export type OrchestrationState =
  | "inactive"
  | "planning"
  | "plan_review"
  | "plan_reviewed"
  | "setup"
  | "implementing"
  | "replanning"
  | "pausing"
  | "paused"
  | "stopped"
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
  verifying: ["completed", "inactive"],
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
export function transitionTo(newState: OrchestrationState, plan?: OrchestrationPlan, force = false): boolean {
  const currentState = OrchestratorState.currentState;

  if (!force && !STATE_TRANSITIONS[currentState].includes(newState)) {
    notifyTui(`[state-machine] Invalid transition: ${currentState} → ${newState}`);
    return false;
  }

  if (OrchestratorState.debugLogTransitions) {
    notifyTui(`[state-machine] State transition: ${currentState} → ${newState}`);
  }

  // Update OrchestratorState.currentState directly as the single source of truth
  OrchestratorState.currentState = newState;

  // Update plan status to match as a projection of currentState
  if (plan) {
    plan.status = mapStateToPlanStatus(newState);
  }

  return true;
}

/**
 * Map orchestration state to plan.json status field.
 */
function mapStateToPlanStatus(state: OrchestrationState): OrchestrationPlan["status"] {
  const mapping: Record<OrchestrationState, OrchestrationPlan["status"]> = {
    inactive: "planning", // fallback
    planning: "planning",
    plan_review: "planning",
    plan_reviewed: "planning",
    setup: "setup",
    implementing: "implementing",
    replanning: "replanning",
    pausing: "pausing",
    paused: "paused",
    stopped: "paused",
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
      return "resuming";
    case "replanning":
      return "replanning";
    case "pausing":
      return "resuming";
    case "paused":
      return "resuming";
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
