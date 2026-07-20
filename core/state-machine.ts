import { OrchestratorState, notifyTui as coreNotifyTui } from "./state-singleton";
import type { Task } from "./types";

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

  return true;
}

/**
 * Infer the OrchestrationState when resuming based on the state of tasks and attributes.
 */
export function inferStateFromTasks(tasks: Task[], attributes: string[] = []): OrchestrationState {
  if (attributes.includes("VERIFIED")) {
    return "completed";
  }

  if (attributes.includes("CODE_REVIEW_REJECTED")) {
    return "code_review";
  }

  // If the plan has not been approved yet, we are in the planning phase.
  if (!attributes.includes("PLAN_APPROVED")) {
    return "planning";
  }

  if (!tasks || tasks.length === 0) {
    return "setup";
  }

  // If any task is failed, resume in 'failed' so the user/orchestrator can replan
  if (tasks.some((t) => t.status === "failed")) {
    return "failed";
  }

  // If all tasks are completed
  if (tasks.every((t) => t.status === "completed")) {
    const codeReviewModel = OrchestratorState.codeReviewModel;
    if (codeReviewModel) {
      if (attributes.includes("CODE_REVIEW_APPROVED")) {
        return "verifying";
      }
      return "code_review";
    }
    return "verifying";
  }

  // Default to implementing
  return "implementing";
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
