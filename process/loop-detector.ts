// ---------------------------------------------------------------------------
// Loop detector: identifies when a sub-agent is repeating the same sequence of
// actions (message + tool_call/result cycles) and emits after N repetitions.
// ---------------------------------------------------------------------------

import { SubAgentEvent, getEventToolName, getEventParams } from "../core/types";

/** How many full repeats before we kill the process. */
const REQUIRED_CYCLES = 5;

/** Maximum cycle depth to consider (1–3 messages deep). */
const MAX_CYCLE_DEPTH = 3;

/** Minimum buffer size before detection runs (REQUIRED_CYCLES × MAX_CYCLE_DEPTH). */
const MIN_BUFFER_SIZE = REQUIRED_CYCLES * MAX_CYCLE_DEPTH; // 15

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function sigMessageEnd(event: SubAgentEvent): string {
    const role = String(event.message?.role ?? "?");
    return `msg:${role}`;
}

function sigToolCall(event: SubAgentEvent): string {
    const tool = getEventToolName(event);
    const params = getEventParams(event);
    // Use raw param values - no normalisation. This way reading different files
    // (read(src/a.ts), read(src/b.ts)) produces distinct signatures and avoids
    // false positives. Genuine loops on the same file are still caught.
    return `call:${tool}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`;
}

function signature(event: SubAgentEvent): string {
    switch (event.type) {
        case "message_end":
            return sigMessageEnd(event);
        case "tool_call":
        case "tool_execution_start":
            return sigToolCall(event);
        case "tool_result":
        case "tool_execution_end":
            return ""; // excluded - uniform ok/err signatures cause false positives on sequential reads
        default:
            return ""; // ignore other event types
    }
}

// ---------------------------------------------------------------------------
// Cycle detection algorithm
// ---------------------------------------------------------------------------

interface LoopInfo {
    /** Length of the repeating cycle (number of events). */
    cycleLen: number;
    /** Number of full repetitions observed. */
    cycles: number;
    /** The signature strings that make up one cycle. */
    pattern: string[];
}

/**
 * Check if `buf` ends with a repeating cycle of length `cycleLen`.
 * Returns the count of full repetitions, or 0 if no match.
 */
function countCycles(buf: string[], cycleLen: number): number {
    const total = buf.length;
    const fullSegments = Math.floor(total / cycleLen);
    if (fullSegments < REQUIRED_CYCLES) return 0;

    for (let i = 1; i < fullSegments; i++) {
        for (let j = 0; j < cycleLen; j++) {
            if (buf[i * cycleLen + j] !== buf[j]) {
                return 0; // mismatch at position j in segment i
            }
        }
    }
    return fullSegments;
}

/**
 * Scan the buffer for a repeating cycle. Returns loop info or null.
 */
function detectCycle(buf: string[]): LoopInfo | null {
    if (buf.length < MIN_BUFFER_SIZE) return null;

    for (let len = 1; len <= MAX_CYCLE_DEPTH; len++) {
        const cycles = countCycles(buf, len);
        if (cycles >= REQUIRED_CYCLES) {
            return { cycleLen: len, cycles, pattern: buf.slice(0, len) };
        }
    }

    // Buffer is growing - trim to keep memory bounded.
    // Keep enough for the worst-case detection window plus a small margin.
    const maxKeep = MIN_BUFFER_SIZE * 3;
    if (buf.length > maxKeep) {
        buf.splice(0, buf.length - maxKeep);
    }

    return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for configuring the LoopDetector.
 */
export interface LoopDetectorOptions {
    /** Callback fired when a loop is detected. */
    onLoopDetected: (info: LoopInfo) => void;
}

/**
 * Stateful loop detector - feed parsed sub-agent events to it via `ingest()`.
 * After detecting a repetitive cycle (≥5 repetitions of 1–3 events), fires the callback once.
 */
export class LoopDetector {
    private sigs: string[] = [];
    private triggered: boolean = false;
    private onLoopDetected: (info: LoopInfo) => void;

    constructor(options: LoopDetectorOptions) {
        this.onLoopDetected = options.onLoopDetected;
    }

    /** Feed a single parsed JSON event. */
    ingest(event: SubAgentEvent): void {
        if (this.triggered) return; // already fired, no-op

        const sig = signature(event);
        if (!sig) return; // uninteresting event type

        this.sigs.push(sig);

        const loop = detectCycle(this.sigs);
        if (loop) {
            this.triggered = true;
            this.onLoopDetected(loop);
        }
    }
}

// ---------------------------------------------------------------------------
// Orchestrator-level loop detection - watches the orchestrator's own turn
// patterns during execution mode. Unlike LoopDetector above (which tracks raw
// sub-agent event streams), this tracks per-turn tool-call signatures and
// detects repeated consecutive turns.
// ---------------------------------------------------------------------------

/** Number of identical consecutive turns before we consider it a loop. */
const ORCHESTRATOR_LOOP_THRESHOLD = 4;

/** Build a normalised signature for a single tool call (strips volatile params). */
function _orchToolSignature(toolName: string, args: Record<string, unknown>): string {
    const keyParams: string[] = [];
    if (args.taskId) keyParams.push(`taskId=${args.taskId}`);
    if (args.mode) keyParams.push(`mode=${args.mode}`);

    // Include distinguishing parameters for exploration tools so that reading
    // different files produces distinct signatures - prevents false-positive loop
    // detection when the orchestrator sequentially reads multiple source files.
    switch (toolName) {
        case "read":
            if (args.path) keyParams.push(`path=${args.path}`);
            break;
        case "grep":
            if (args.pattern) keyParams.push(`pattern=${args.pattern}`);
            if (args.path) keyParams.push(`path=${args.path}`);
            break;
        case "find":
            if (args.pattern) keyParams.push(`pattern=${args.pattern}`);
            if (args.path) keyParams.push(`path=${args.path}`);
            break;
        case "ls":
            if (args.path) keyParams.push(`path=${args.path}`);
            break;
        case "bash": {
            const cmd = args.command || args.cmd || "";
            // Truncate long commands to keep signatures manageable
            const truncated = String(cmd).slice(0, 80);
            if (truncated) keyParams.push(`command=${truncated}`);
            break;
        }
    }
    return `call:${toolName}(${keyParams.join(",")})`;
}

/**
 * Stateful orchestrator-level loop detector. Tracks per-turn tool-call signatures
 * and fires after a threshold of consecutive identical turns.
 */
class OrchestratorLoopDetector {
    /** Per-turn tool execution tracker: maps toolCallId → { toolName, args } */
    private _pendingToolExecutions = new Map<string, { toolName: string; args: Record<string, unknown> }>();

    /** Previous turn signature for comparison. */
    private _lastTurnSignature: string | null = null;

    /** Count of consecutive turns matching `_lastTurnSignature`. */
    private _consecutiveCount = 0;

    /** Whether the orchestrator loop breaker has already fired this execution session (prevents spam). */
    private _loopBreakerFired = false;

    /**
     * Track whether we've moved past the initial "task assignment" phase.
     * During task assignment, the orchestrator fires many orchestrate_add_task calls
     * that all produce identical signatures - loop detection must be skipped here.
     * Set to true when orchestrate_start_task is first called (sub-agent execution begins).
     */
    private _pastTaskAssignmentPhase = false;

    // --- Public methods ---

    /** Record a tool execution for the current turn. */
    recordToolExecution(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
        this._pendingToolExecutions.set(toolCallId, { toolName, args });
    }

    /** Clear pending tool executions at the start of a new turn. */
    clearTurnTools(): void {
        this._pendingToolExecutions.clear();
    }

    /** Build a composite signature for an entire turn from its tool executions. */
    buildTurnSignature(): string {
        if (this._pendingToolExecutions.size === 0) return "turn:none";
        const parts: string[] = [];
        for (const exec of this._pendingToolExecutions.values()) {
            parts.push(_orchToolSignature(exec.toolName, exec.args));
        }
        // Sort is intentional - tool executions may fire in any order within a turn.
        parts.sort();
        return `turn:${parts.join("|")}`;
    }

    /** Get the last turn signature. */
    getLastTurnSignature(): string | null {
        return this._lastTurnSignature;
    }

    /** Set the last turn signature. */
    setLastTurnSignature(sig: string | null): void {
        this._lastTurnSignature = sig;
    }

    /** Increment consecutive count. */
    incrementConsecutiveCount(): void {
        this._consecutiveCount++;
    }

    /** Get current consecutive count. */
    getConsecutiveCount(): number {
        return this._consecutiveCount;
    }

    /** Reset consecutive count to 1 (new pattern observed). */
    resetConsecutiveCount(): void {
        this._consecutiveCount = 1;
    }

    /** Check if the loop breaker has already fired. */
    isLoopBreakerFired(): boolean {
        return this._loopBreakerFired;
    }

    /** Set the one-shot loop-breaker flag (prevents spam). */
    setLoopBreakerFired(): void {
        this._loopBreakerFired = true;
    }

    /** Reset the one-shot loop-breaker flag so detection can fire again on next cycle. */
    resetLoopBreakerFlag(): void {
        this._loopBreakerFired = false;
    }

    /** Signal that orchestrate_start_task was called - loop detection can now activate. */
    signalTaskStarted(): void {
        this._pastTaskAssignmentPhase = true;
    }

    /** Check if we're past the task assignment phase (loop detection is allowed). */
    isPastTaskAssignmentPhase(): boolean {
        return this._pastTaskAssignmentPhase;
    }

    /** Reset all orchestrator loop detection state (called after goal approval or session end). */
    resetLoopState(): void {
        this._lastTurnSignature = null;
        this._consecutiveCount = 0;
        this._loopBreakerFired = false;
        this._pendingToolExecutions.clear();
        this._pastTaskAssignmentPhase = false; // allow new task-assignment phase without loop detection
    }
}

// Singleton instance
const _orchestratorLoopDetector = new OrchestratorLoopDetector();

// Convenience wrappers around the singleton OrchestratorLoopDetector instance.
// The class methods carry the full JSDoc; these delegates are kept thin for
// ergonomic access from index.ts without importing the class directly.
export function buildTurnSignature(): string {
    return _orchestratorLoopDetector.buildTurnSignature();
}

export function recordToolExecution(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    _orchestratorLoopDetector.recordToolExecution(toolCallId, toolName, args);
}

export function clearTurnTools(): void {
    _orchestratorLoopDetector.clearTurnTools();
}

export function getLastTurnSignature(): string | null {
    return _orchestratorLoopDetector.getLastTurnSignature();
}

export function setLastTurnSignature(sig: string | null): void {
    _orchestratorLoopDetector.setLastTurnSignature(sig);
}

export function incrementConsecutiveCount(): void {
    _orchestratorLoopDetector.incrementConsecutiveCount();
}

export function getConsecutiveCount(): number {
    return _orchestratorLoopDetector.getConsecutiveCount();
}

export function resetConsecutiveCount(): void {
    _orchestratorLoopDetector.resetConsecutiveCount();
}

export function setLoopBreakerFired(): void {
    _orchestratorLoopDetector.setLoopBreakerFired();
}

export function isLoopBreakerFired(): boolean {
    return _orchestratorLoopDetector.isLoopBreakerFired();
}

export function resetLoopBreakerFlag(): void {
    _orchestratorLoopDetector.resetLoopBreakerFlag();
}

export function signalTaskStarted(): void {
    _orchestratorLoopDetector.signalTaskStarted();
}

export function isPastTaskAssignmentPhase(): boolean {
    return _orchestratorLoopDetector.isPastTaskAssignmentPhase();
}

export function resetLoopState(): void {
    _orchestratorLoopDetector.resetLoopState();
}

/** Threshold constant exported for index.ts turn_end logic. */
export { ORCHESTRATOR_LOOP_THRESHOLD };
