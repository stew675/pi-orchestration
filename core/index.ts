// ─── Types & Constants ──────────────────────────────────────────────
export {
    ALL_TASK_STATUSES,
    ACTIVE_TASK_STATUSES,
    EXECUTION_PHASE_STATUSES,
    FULL_TOOLS,
    READ_ONLY_TOOLS,
    ARTIFACT_PRODUCING_TOOLS,
    MAX_CLARIFICATIONS,
    DEFAULT_TASK_TIMEOUT_MS,
    DEFAULT_VALIDATOR_TIMEOUT_MS,
    DEFAULT_SUMMARY_TIMEOUT_MS,
    DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS,
    DEFAULT_SUB_AGENT_MAX_TURNS,
    isTaskReadOnly,
    tryParseSubAgentEvent,
    getEventToolName,
    getEventParams
} from "./types";

export type { OrchestrationPlan, Task, TaskType, ModelRef, SubAgentEvent } from "./types";

// ─── Runtime State Singleton ────────────────────────────────────────
export {
    OrchestratorState,
    setOrchestrationMode,
    NOT_ACTIVE_MSG,
    getPi,
    requireActive,
    resetState,
    requestSystemPromptRestore,
    captureCurrentModel,
    switchToOrchestrationModel,
    restoreMainModel,
    enterPlanningMode,
    exitPlanningMode,
    beginShutdown,
    updateActiveTools,
    resolveTaskModelByComplexity,
    resolveValidatorModel,
    resolveSummaryModel,
    switchToReviewerModel,
    restoreFromReviewPhase,
    formatModel,
    recoverInterruptedTasks,
    computeExecutionPhaseLabel,
    stripTaskPrefix,
    truncateToSentence,
    buildStatusSummary,
    setSummarizationConcurrency,
    setParallelTasks,
    setTimeoutMs,
    setSubAgentMaxTurns,
    setBooleanSetting,
    setModelRef
} from "./state-singleton";

export type { ExecutionPhaseLabel } from "./state-singleton";

// ─── State Machine Predicates ───────────────────────────────────────
export {
    isActive,
    isPlanningMode,
    isExecutingMode
} from "./state-machine";
