export interface ModelRef {
    provider: string;
    id: string;
}

export const MAX_CLARIFICATIONS = 5;

/** Default timeout for task sub-agents (12 min). */
export const DEFAULT_TASK_TIMEOUT_MS = 720_000;
/** Default timeout for validator sub-agents (4 min). */
export const DEFAULT_VALIDATOR_TIMEOUT_MS = 240_000;
/** Default timeout for task-summary sub-agents (2 min). */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 120_000;

/** Default idle timeout for any sub-agent — no JSON stream activity (5m30s). */
export const DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS = 330_000;
/** Default maximum model turns for any sub-agent. */
export const DEFAULT_SUB_AGENT_MAX_TURNS = 30;

/** Maximum orchestrator turns during the VERIFICATION phase before auto-approve (50). */
export const DEFAULT_VERIFYING_ORCHESTRATOR_MAX_TURNS = 50;

/** Well-known tool grant strings for sub-agent spawning. */
export const READ_ONLY_TOOLS = "read,ls,find,grep";
export const FULL_TOOLS = "read,write,bash,edit";

/** Tool names that produce artifact files (used for discovery). */
export const ARTIFACT_PRODUCING_TOOLS = ["write", "edit"] as const;

/** Well-known task types that determine file-count limits during validation. */
export type TaskType = "creation" | "editing" | "building" | "administrative" | "research" | "reviewing" | "other";

/**
 * Returns true for task types that only read files (never write).
 *
 * Read-only tasks:
 * - Skip conflict detection when paired with other read-only peers
 * - Spawn sub-agents with read-only tools (`read,ls,find,grep`)
 * - Skip the summarization step (their direct output serves as the summary)
 */
export function isTaskReadOnly(taskType?: TaskType): boolean {
    return ["reviewing", "research"].includes(taskType ?? "");
}

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

export interface OrchestrationPlan {
    goal: string;
    currentTaskId?: string;
    status?: OrchestrationState;
    tasks: Task[];
    attributes?: string[];
}

export const ALL_TASK_STATUSES = [
    "pending",
    "running",
    "validating",
    "summarizing",
    "awaiting_clarification",
    "completed",
    "failed"
] as const;
export const ACTIVE_TASK_STATUSES = ["running", "validating", "summarizing", "awaiting_clarification"] as const;

export interface Task {
    id: string; // e.g., "task_01"
    description: string;
    files: string[]; // Predicted list of files this task will modify/read
    dependencies: string[]; // IDs of tasks providing context/files

    status: (typeof ALL_TASK_STATUSES)[number];

    // Output structure
    result?: {
        summary: string;
        artifacts?: string[]; // Actual list of files created/modified
        manuallyCompleted?: boolean; // True if the task was completed via /om-accept instead of sub-agent
    };

    // Retry & Validation
    validatorFeedback?: string;
    attempts: number;
    complexity: "simple" | "complex";
    taskType?: TaskType; // e.g., creation, editing, building, administrative, research, reviewing, other

    // Robustness & Timing
    timeoutMs: number;
    startedAt?: number;

    // Clarification support
    clarificationQuery?: string;
    clarificationAttempts?: number; // Number of times this task has requested clarification
    clarificationHistory?: Array<{ query: string; answer: string }>;
}

// ---------------------------------------------------------------------------
// Shared sub-agent event interface - used by monitor, capture, loop-detector, runner
// ---------------------------------------------------------------------------

/** Raw JSON events emitted by `pi --mode json` stdout. */
export interface SubAgentEvent {
    type: string;
    message?: { role: string; content?: unknown[] };
    tool?: string;
    name?: string;
    params?: Record<string, unknown>;
    success?: boolean;
    result?: unknown;
    error?: string;
}

/** Check if an event represents a tool call or execution start.
 *
 * Both legacy (`tool_call`) and streaming (`tool_execution_start`) formats are matched.
 */
export function isToolCallEvent(ev: SubAgentEvent): boolean {
    return ev.type === "tool_call" || ev.type === "tool_execution_start";
}

/** Safely parse a raw JSON line into a SubAgentEvent. Returns null on failure. */
export function tryParseSubAgentEvent(raw: string): SubAgentEvent | null {
    try {
        return JSON.parse(raw) as SubAgentEvent;
    } catch {
        return null;
    }
}

/** Extract a tool name from an inconsistently shaped event.
 *
 * Events use different field names depending on type:
 * - `tool_call` / `tool_execution_start`: `.tool`, `.toolName`, or `.name`
 * - `tool_result` / `tool_execution_end`: `.toolName`
 */
export function getEventToolName(ev: SubAgentEvent): string {
    return String((ev as any).tool || (ev as any).toolName || ev.name || "?");
}

/** Extract argument/parameter map from an inconsistently shaped event.
 *
 * Events may carry parameters under `.params` or `.args`, or omit them entirely.
 */
export function getEventParams(ev: SubAgentEvent): Record<string, unknown> {
    return ((ev as any).params || (ev as any).args || {}) as Record<string, unknown>;
}
