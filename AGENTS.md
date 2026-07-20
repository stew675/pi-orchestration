# Orchestration Extension - Agent Conventions

## Project Overview

This is a **pi coding agent extension** that provides multi-agent task orchestration. It spawns an Orchestrator LLM that decomposes user goals into tasks, then delegates each task to isolated sub-agents with restricted tool permissions.

### Key Capabilities
- **Planning phase**: Orchestrator explores the codebase and builds a detailed implementation plan (`.md` file) via `orchestrate_write_plan` / `orchestrate_edit_plan` tools
- **Execution phase**: Tasks run as isolated `pi --mode json` subprocesses with explicit tool grants (`read`, `write`, `bash`, `edit`)
- **Validation phase**: Complex tasks are reviewed by a dedicated read-only Validator sub-agent
- **Clarification loop**: Sub-agents can pause and ask the user questions (max 5 attempts before auto-fail)
- **Recovery**: Resume from any state; interrupted tasks reset to pending automatically

## Architecture

### Module Responsibilities

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point. Registers hooks (`session_start`, `before_agent_start`, `context`, `tool_result`, `turn_end`), commands, tools, and UI widget. Uses a **minimal system prompt + contextual hints** pattern for both phases — the planning system prompt contains the basic interactive flow (wait → explore → plan) so it works correctly in its conversational loop, while detailed quality guidelines are injected contextually via `PLANNING_HINT_PRE_WRITE` on first call to `orchestrate_write_plan`. The execution phase uses an equally minimal system prompt with all situational guidance injected via `pi.sendMessage()` at known trigger points. Runs a **watchdog timer** (2-second interval during execution mode) that monitors for a stalled orchestrator - after 5 consecutive watchdog ticks with no sub-agent activity, kicks the orchestrator with a nudge message. Resets whenever sub-agents are running or the agent processes a turn. Skips stall detection in `paused`, `stopped`, and `pausing` states. Also enforces **sub-agent idle timeout** and **max turns** limits via `enforceSubAgentLimits()` — iterates all registered agents, kills those exceeding thresholds via SIGTERM, sets `killedByWatchdog` reason for failure feedback. On `turn_end`, fires the **Accept/Edit dialog** (`showAcceptOrEditDialog`) when `_planJustUpdated` is true, giving the user 100 ms for tool output to render before overlaying the dialog.
| `core/` | Core module directory: |
| `core/index.ts` | Barrel entry - re-exports everything from `types.ts` and `state-singleton.ts`. Single import point for types, constants (including sub-agent limit defaults), model resolution functions, setter helpers (`setTimeoutMs`, `setSubAgentMaxTurns`, etc.), and state helpers. |
| `core/state-singleton.ts` | Global state singleton (`OrchestratorState`). Mode transitions (`setOrchestrationMode`), tool visibility gating (`updateActiveTools`), model switching helpers, status summary building, interrupted task recovery. Tracks configurable concurrency settings (`parallelTasks`, `summarizationConcurrency`). Exports **model resolution functions** - `resolveTaskModelByComplexity()` (simple/complex → fallback), `resolveValidatorModel()` (validatorModel → complexTaskModel → fallback), `resolveSummaryModel()` (summaryModel → simpleTaskModel → fallback). Defines `ExecutionPhaseLabel` type (`"PLANNING" | "SETUP" | "IMPLEMENTING" | "REPLANNING" | "PAUSED" | "STOPPED" | "VERIFYING" | "PLAN_REVIEW" | "CODE_REVIEW" | "COMPLETED" | "FAILED"`) and `computeExecutionPhaseLabel()` which maps the canonical state to a display label. Exports setter helpers (`setTimeoutMs`, `setSubAgentMaxTurns`, `setBooleanSetting`, `setModelRef`). Tracks global sub-agent limits: `subAgentIdleTimeoutMs` (idle watchdog) and `subAgentMaxTurns` (turn cap). Tracks one-shot hint flag `_preWriteHintSent` for guidance-in-the-moment injection. Exports shared `notifyTui()` helper used across modules for TUI-only notifications. |
| `core/types.ts` | TypeScript interfaces: `OrchestrationPlan`, `Task`, `TaskType`, `ModelRef`, `SubAgentEvent`. Constants like `MAX_CLARIFICATIONS`, timeout defaults (`DEFAULT_TASK_TIMEOUT_MS`, `DEFAULT_VALIDATOR_TIMEOUT_MS`, `DEFAULT_SUMMARY_TIMEOUT_MS`), sub-agent limits (`DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS = 330_000`, `DEFAULT_SUB_AGENT_MAX_TURNS = 30`), tool set constants (`FULL_TOOLS`, `READ_ONLY_TOOLS`, etc.), and event parsing helpers (`tryParseSubAgentEvent()`, `getEventToolName()`, `getEventParams()`). |
| `tools.ts` | Root-level thin facade - delegates to sub-directory modules via dynamic import (`require("./tools/index")`). Preserves backward-compatible public API for index.ts. Re-exports shared utilities (`validatePlan`, mode guards). |
| `runner.ts` | Root-level thin facade - exports the `Runner` class with static methods (`runTasks`, `awaitAllSummaries`, `cancelAllSummaries`, `cancelTaskSummary`, `validateTask`) that delegate to sub-directory modules via dynamic/static imports. Also re-exports `notifyOrchestrator` and `activeProcesses`. |
| `tools/` | Directory containing all orchestration tool registrations, split by phase: |
| `tools/index.ts` | Barrel entry - calls `registerPlanTools()`, `registerTaskCrudTools()`, `registerExecutionControlTools()`, `registerReviewTools()` |
| `tools/plan-tools.ts` | Planning-phase tools (`orchestrate_write_plan`, `orchestrate_edit_plan`, `orchestrate_present_plan`) with custom `renderShell: "self"` for Markdown rendering and progressive streaming via `renderCall`/`renderResult` hooks. Tool descriptions are enriched with plan quality guidance (file paths, line numbers, phase naming convention) so the model sees best-practice instructions right before calling the tool. |
| `tools/task-crud.ts` | Task manipulation tools (`orchestrate_add_task`, `orchestrate_delete_task`, `orchestrate_complete_task`, `orchestrate_edit_task`, `orchestrate_get_plan`). Each validates mode guards and calls `validatePlan()` before persisting. |
| `tools/execution-control.ts` | Execution-flow tools (`orchestrate_ready_tasks`, `orchestrate_start_task`, `orchestrate_check_status`, `orchestrate_replan`, `orchestrate_resume_task`, `orchestrate_stop`). Pre-flight file-conflict check on start; signals loop detector on task start. |
| `tools/review-tools.ts` | Review-phase tool (`orchestrate_approve_goal`) - only callable when plan status is `"plan_review"`. Resets internal state and transitions orchestrator out of execution mode. |
| `tools/shared.ts` | Shared utilities: render helpers for plan tools, `validatePlan()` (wraps cycle/file-conflict/oversized checks), and mode guard (`requireExecutionMode()`) plus `requireTaskCrudPrereqs()` which enforces setup/replanning-only state. |
| `tools/validator-tools.ts` | Validator signal tools (`orchestrate_validate_pass`, `orchestrate_validate_fail`). Thin pass/fail indicators - when called they tell the model to stop immediately. The orchestrator detects which tool was invoked by parsing JSONL stdout events (`tool_call` / `tool_execution_start`) and matching the tool name, then resolves the verdict accordingly.
| `runner/` | Directory containing task execution logic, split into focused modules: |
| `runner/scheduler.ts` | Main scheduling loop (`runTasks()`). Discovers ready tasks, enforces concurrency limits (`parallelTasks`), spawns sibling runners for parallel execution, and handles plan completion via `finishPlan()`. Uses a scheduling lock to prevent concurrent scheduling decisions. |
| `runner/executor.ts` | Single-task execution (`executeTask`). Handles status transitions (pending → running), sub-agent spawn via `runSubAgent`, post-result routing: validation loop for complex/read-only tasks, summarization, clarification handling, and failure marking. Auto-completes recoverable validator failures. |
| `runner/subagent-spawner.ts` | Spawns `pi --mode json` subprocesses with appropriate tool grants (read-only vs full). Wires stdout to both the monitor (`ingestLine`) and a `LoopDetector`. Registers the process via `monitor.registerAgent("implementation-{taskId}", child)` for unified idle/turn tracking. Captures discovered artifacts from write/edit tool calls. Returns `SubAgentResult` with exit code, loop-kill status, etc. |
| `runner/post-processor.ts` | Post-task processing (`processTaskResult`, `archiveTask`). Routes completed/clarification/failure states, archives prompts/results to `.pi/orchestration/archive/`, and notifies the orchestrator via `notifyOrchestrator()`. |
| `runner/summarizer.ts` | Task summarization with async concurrency support. Spawns summary sub-agents gated by a semaphore (`acquireSummarySlot`/`releaseSummarySlot`). Registers each via `monitor.registerAgent("summarization-{taskId}")`. Feeds JSON stream to monitor with `{ skipActive: true }` so it doesn't hijack the `/om-status` view. Tracks in-flight summaries in a `pendingSummaries` Map so `finishPlan()` can `awaitAllSummaries()`. Supports cancellation via `cancelTaskSummary()` and `cancelAllSummaries()`. Checks `killedByWatchdog` reason on process close for failure reporting. |
| `runner/validator.ts` | Validator sub-agent execution with tool-based verdict detection. Spawns read-only validator agents (`read,ls,find,grep`) plus two validate tools (`orchestrate_validate_pass`, `orchestrate_validate_fail`). The orchestrator detects the verdict by parsing JSONL stdout lines via `tryParseSubAgentEvent()` and checking for a `tool_call` / `tool_execution_start` event naming one of the validate tools. Registers each via `monitor.registerAgent("validator-{taskId}")`. Feeds JSON stream to monitor with `{ skipActive: true }` so it doesn't hijack the `/om-status` view. Retries up to 2 times if the validator times out without issuing a verdict (other outcomes short-circuit). Persists validation prompts to `validations/<id>.prompt.md` and final responses to `validations/<id>.response.json` for debugging.
| `runner/utils.ts` | Shared utilities: `notifyOrchestrator()` sends system messages to wake the orchestrator; `savePlanSafely()` wraps `StateManager.savePlan()` with shutdown guard. |
| `context/` | Context-building and state management directory: |
| `context/context-builder.ts` | Builds system prompt files injected into sub-agents (task context, validator context). Assembles goal, dependency summaries, sibling task info, and **relevant implementation-plan.md excerpts** for authoritative grounding. Section extraction matches plan headings against task file names and description keywords; skips injection entirely if fewer than 5 matching lines are found. Validator prompts instruct the model to call `orchestrate_validate_pass` or `orchestrate_validate_fail` (verdict detected via JSONL stdout event parsing, not a structured response body). |
| `context/prompts.ts` | Prompt templates. Exports minimal system prompts (`ORCHESTRATOR_PLANNING_SYSTEM_PROMPT`, `ORCHESTRATOR_EXECUTION_SYSTEM_PROMPT`) — the planning prompt includes the basic interactive flow (wait → explore → plan) so it works in its conversational loop, while detailed quality guidelines are injected contextually via `PLANNING_HINT_PRE_WRITE` on first write_plan call. Also exports `PLANNING_HINT_EDIT` (thoroughness guidance, prepended to user edit feedback). Phase-specific prompts: `ORCHESTRATOR_REVIEW_SYSTEM_PROMPT`, `ORCHESTRATOR_CODE_REVIEW_DECISION_SYSTEM_PROMPT`. Code-review sub-agent instructions are embedded inline in `context-builder.ts`. |
| `context/state-manager.ts` | (`StateManager`) Persistent state management - reads/writes plan files under `.pi/orchestration/plans/` (`plan.json`, `plan.md`, `implementation-plan.md`) and archives task prompts/results under `.pi/orchestration/archive/`. Persists validator artifacts in `.pi/orchestration/validations/` (prompts as `<id>.prompt.md`, responses as `<id>.response.json`). Provides two static escaping helpers: `StateManager.escapeMdInline()` for short metadata fields (escapes `<`/`>`) and `StateManager.escapeMdContent()` for multi-line summaries (preserves markdown structure including `#` headings). Uses atomic writes (write-to-temp + rename) with backup files (`.old`). Supports legacy migration - falls back to root-level plan files for pre-reorganisation projects, cleans up on first save. |
| `process/` | Process management and monitoring directory: |
| `process/process-manager.ts` | Spawns `pi --mode json` child processes with watchdog timers (SIGTERM → SIGKILL escalation) and stdout line callbacks for event parsing. |
| `process/monitor.ts` | Tracks sub-agents and ingests raw JSONL output lines for `/om-status`. Unified agent tracking via **`registerAgent(taggedId, child)`** — registers any sub-agent (task/validator/summarizer) with a tagged ID (`implementation-`, `validator-`, `summarization-`) and wires a `close` handler for automatic cleanup. The `MonitoredAgent` interface tracks `lastActivityAt`, `turnCount`, and `killedByWatchdog`. **`ingestLine()`** accepts `{ skipActive?: boolean }` — when true (used by validators/summarizers), the agent's stream is parsed but does not hijack the active `/om-status` view. Creates transcript entries for `message_end` (user/assistant text) and `error` events. Other streaming event types (`tool_call`, etc.) trigger UI refresh only - no transcript entries are created for tool events, producing a "model-only" real-time view. Renders user messages as plain text. |
| `process/loop-detector.ts` | Detects repetitive loops in a sub-agent's event stream by extracting signatures from `message_end` and `tool_call` events using raw parameter values (no normalisation - no path/URL/number substitution, avoiding false positives from reading different files). Excludes `tool_result` events to prevent false positives on sequential reads. After 5 repetitions of a cycle (up to 3 events deep), fires a callback that kills the process. Also contains **orchestrator-level loop detection**: tracks per-turn tool-call signatures and sends a nudge message after 4 consecutive identical turns during execution mode. Exported as `LoopDetector` class with `ingest()` / `reset()`. |
| `process/capture.ts` | Shared formatting for captured sub-agent output lines. Exports `formatCapturedLines()` and `truncateCapturedOutput()` to produce readable plain-text summaries of raw JSON event streams, used by failure diagnostics in `monitor.ts` and `process-manager.ts`. |
| `ui/` | TUI components directory: |
| `ui/ui.ts` | TUI widget (status border above the editor) and overlay rendering. Uses a shared **`buildPlanDisplay()`** function to produce consistent output for both the compact widget (`compact: true`) and detailed overlay (`detailed: true`). Displays a task progress bar (`█`/`░`, 20 or 30 chars wide depending on context). The `OrchestrationEditor` class extends `CustomEditor` with **dynamic border recoloring** - top/bottom borders are recolored each render based on phase: amber (planning), green (executing), red (paused/failed during execution), violet (idle or completed). Uses `recolorBorderChars()` to walk ANSI escape sequences and replace only visible border characters. Transcript rendering reverses the `entries` array before rendering (newest-first) while preserving internal line order within each message; user messages are shown without redundant headers. |
| `ui/accept-or-edit-dialog.ts` | TUI overlay component (`AcceptOrEditDialog`) that renders a hybrid selection + text-input dialog: `[✓ Accept]` or `[✎ Type your changes here...]`. Shown after the orchestrator writes/edits a plan (triggered by `_planJustUpdated` on `turn_end`). Returns `{ accepted }`, `{ cancelled }`, or `{ feedback }`. |
| `ui/model-picker.ts` | UI component for selecting LLM models by provider/id. |
| `ui/orchestrator-status-entry.ts` | Status entry rendering - builds the status summary text displayed in the TUI overlay, formatting active tasks, plan progress, and phase information into a compact readable block. |
| `commands/` | Slash command handlers directory: |
| `commands/commands.ts` | Slash command handlers (`/om-enable`, `/om-plan`, `/om-accept`, `/om-pause`, `/om-resume`, `/om-stop`, `/om-reset`, `/om-status`). When user provides edit feedback via the Accept/Edit dialog, `showAcceptOrEditDialog()` prepends `PLANNING_HINT_EDIT` to the feedback message so the planner receives thoroughness guidance at exactly the moment it needs it. |
| `settings/` | Settings management directory: |
| `settings/settings.ts` | Loads persisted model preferences and timeout settings from storage into `OrchestratorState`. Uses **two-tier resolution**: checks project-local `<cwd>/.pi/orchestration/settings.json` first, then falls back to global `~/.pi/agent/orchestration-settings.json`. Project-local takes full precedence when present. Exports `resetToDefaults(state)` which clears project overrides then reloads effective settings from the tier chain, `applySettingsToState(state)` which mutates up to 16 properties on the passed state object at session start (including sub-agent idle timeout and max turns), and `persistSettings(state)` which writes current in-memory choices to disk. |
| `settings/settings-menu.ts` | Interactive settings overlay for configuring models, summarization concurrency, all three sub-agent timeouts (task, validator, summary), sub-agent idle timeout, and sub-agent max turns via TUI input dialogs. |
| `settings/time-utils.ts` | Parse/format human-readable timeout strings (e.g., "30s", "1m20s") to/from milliseconds. 0 = no timeout. |
| `utils/` | Shared utility directory: |
| `utils/file-utils.ts` | Shared file utilities (e.g., JSON extraction from content). |
| `validation/` | Plan validation directory: |
| `validation/validation.ts`

### Data Flow

```
User goal → Orchestrator (planning prompt) → orchestrate_write_plan() → plan.md on disk
     ↓ user approves via /om-accept
Orchestrator (execution prompt) → orchestrate_add_task → plan.json
     ↓ orchestrate_start_task()
Runner.runTasks() → runSubAgent() for each task → sub-agent subprocess
     ↓ task completes
Validator (complex tasks only) → pass/fail feedback
     ↓ task summary generated
Next ready task auto-starts OR orchestrator woken for review
```

### State Persistence

- **`plans/plan.json`** - Source of truth. Stored under `.pi/orchestration/plans/`. Contains goal, status, tasks with full state.
- **`plans/implementation-plan.md`** - Human-readable plan written during planning phase. Read-only projection; never edited directly by code (only via `orchestrate_write_plan` / `orchestrate_edit_plan` tools).
- **`tasks/`** - Active `.prompt.md` files for each running task's context.
- **`archive/`** - Completed task results and prompts moved here after completion for debugging.
- **`validations/`** - Validator artifacts: `<id>.prompt.md` (validation prompt) and `<id>.response.json` ({pass, feedback} result with timestamp).
- **Migration**: Existing projects with plan files at the root level are supported automatically - they load from legacy locations on first run and migrate to `plans/` on next save.

## Coding Conventions

### TypeScript Patterns
- **Strict types**: All interfaces are in `core/types.ts`. Use explicit return types on public functions.
- **Named exports**: Prefer named exports over default exports (except `index.ts`).
- **No top-level side effects** outside of function/class bodies; initialization happens via event hooks.
- **Error handling**: Throw descriptive `Error` objects from tool execute handlers - the framework surfaces them to the user. Use `try/catch` for subprocess and file I/O errors.

### Naming Conventions
- **Tasks**: `task_<name>` (e.g., `task_header`, `task_noise`)
- **State flags**: camelCase booleans on `OrchestratorState` with `_` prefix for one-shot internal flags (`_planJustUpdated`)

### Tool Registration
- Tools use `Type.Object()` from `typebox` for parameter schemas.
- Each tool must check `OrchestratorState.isActive` and call the appropriate mode guards.
- **Shared mode guards** (in `tools/shared.ts`):
  - `requireExecutionMode()` - rejects task manipulation during planning mode.
  - `requireTaskCrudPrereqs()` — composite guard used by all CRUD tools: checks active + execution-mode + allows only `setup` or `replanning` states.
- Planning tools: `orchestrate_write_plan`, `orchestrate_edit_plan`, `orchestrate_present_plan` (registered in `tools/plan-tools.ts`)
- Execution/task manipulation tools: all others including `orchestrate_add_task`, `orchestrate_delete_task`, `orchestrate_complete_task`, `orchestrate_edit_task`, `orchestrate_get_plan`, `orchestrate_ready_tasks`, `orchestrate_start_task`, `orchestrate_check_status`, `orchestrate_replan`, `orchestrate_resume_task`, `orchestrate_stop` (registered in `tools/task-crud.ts` and `tools/execution-control.ts`)
- Review tool: `orchestrate_approve_goal` (registered in `tools/review-tools.ts`; gated by plan status `"plan_review"`)
- Validator tools: `orchestrate_validate_pass`, `orchestrate_validate_fail` (registered in `tools/validator-tools.ts`; no parameters, called only by validator sub-agents - never available to the orchestrator or task sub-agents)

### Sub-Agent Spawning
- Tasks run via `pi --mode json --no-session --tools read,write,bash,edit --append-system-prompt <promptFile> -p "<description>"`
- Validators run with read-only tools plus validate signal tools: `read,ls,find,grep,orchestrate_validate_pass,orchestrate_validate_fail`. The validator prompt instructs the model to call exactly one of these two tools and stop. Verdict is detected by parsing JSONL stdout events and matching the tool name.
- Summarizers run with read-only tools: `read,ls,find,grep`.
- **Read-only tasks** (`taskType` = `reviewing` or `research`): Spawn sub-agents with only `read,ls,find,grep` tools. They skip summarization entirely - the final assistant message text is captured directly as the task summary. They are still evaluated by the Validator to ensure they generated output aligning with the task goal.
- **Loop detection**: Every running task sub-agent has a `LoopDetector` instance attached to its event stream. The detector extracts signatures from `message_end` and `tool_call` events using raw parameter values (no normalisation - reading different files produces distinct signatures, avoiding false positives). `tool_result` events are excluded to prevent false positives on sequential reads. If a cycle of 1–3 events repeats 5 or more times, the process is killed with `SIGTERM`. The task is marked `failed` with feedback indicating loop detection.
- **Parallel tasks**: Configurable via `/om-settings` (`parallelTasks`, default 1). When set > 1, multiple independent ready tasks run simultaneously. Each `runTasks()` instance fires a sibling copy of itself after picking a task (before blocking on the sub-agent), so all parallel slots fill immediately without waiting for watchdog re-kicks. The concurrency gate (`activeImplementationTasks.length >= parallelTasks`) prevents over-subscription - excess siblings return instantly.
- **Summarization concurrency**: Configurable via `/om-settings` (`summarizationConcurrency`, default 0 = synchronous). When >= 1, task summaries run asynchronously in parallel (gated by a semaphore of size N), allowing the main execution loop to continue scheduling ready tasks while summaries complete in background. The runner awaits all pending summaries before entering final review.
- **Configurable models** (set via `/om-settings`):
  - `orchestrationModel` - main model driving the orchestrator agent
  - `planningModel` - model used while building/editing plans
  - `simpleTaskModel` / `complexTaskModel` - per-complexity task sub-agent models; missing complexity defaults to complex
  - `validatorModel` - dedicated validator sub-agents (priority: validatorModel → complexTaskModel → Pi default)
  - `summaryModel` - dedicated task-summary sub-agents (priority: summaryModel → simpleTaskModel → Pi default)
- **Configurable timeouts** (set via `/om-settings`): task default (`taskTimeoutMs`, default 12m), validator (`validatorTimeoutMs`, default 4m), task summary (`taskSummaryTimeoutMs`, default 2m). Format: "30s", "1m20s", "15m", or "0" for no timeout. Per-task `timeoutMs` in plan.json can override the task default - values below the configured default are silently raised to it, and values above 2× the default are capped. Both `orchestrate_add_task` and `orchestrate_edit_task` accept a `timeoutMs` parameter.
- **Sub-agent idle timeout** (`subAgentIdleTimeoutMs`, default 5m30s): Global watchdog in index.ts enforces this every 2 seconds during execution mode. Iterates all agents registered via `monitor.registerAgent()` — if an agent's `lastActivityAt` (updated on every JSON stream event) exceeds the threshold, the process is killed via SIGTERM and `killedByWatchdog` is set to `"idle_timeout"`. Applied globally to task, validator, and summarizer sub-agents. 0 = disabled.
- **Sub-agent max turns** (`subAgentMaxTurns`, default 30): Global watchdog enforces this every 2 seconds alongside idle timeout. If an agent's `turnCount` (incremented on each assistant `message_end`) exceeds the limit, the process is killed via SIGTERM and `killedByWatchdog` is set to `"max_turns"`. Applied globally to all sub-agent types. 0 = unlimited.
- **Tagged registration**: Each sub-agent registers with a tagged ID for watchdog mapping: `implementation-{taskId}` (task), `validator-{taskId}` (validator), `summarization-{taskId}` (summarizer). The monitor auto-cleans on process close via a wired `child.on("close")` handler — no manual unregister needed.
- **skipActive option**: `ingestLine()` accepts `{ skipActive: true }`. When set, the agent's JSON stream is parsed for idle/turn tracking but does not update the active `/om-status` view. Validators and summarizers use this so only task sub-agents appear in the live monitoring overlay.
- **Failure feedback**: When a sub-agent is killed by the watchdog (idle or turns), `executor.ts`, `validator.ts`, and `summarizer.ts` check `monState.killedByWatchdog` and report the specific reason (`"idle_timeout"` / `"max_turns"`) in failure feedback to the orchestrator model, rather than a generic timeout message.
- **Task summaries** are generated by a dedicated sub-agent that reads every artifact file and produces an exhaustive listing of all public APIs (data types, classes, functions with full signatures, constants), line numbers, and behavioral constraints. This summary is injected verbatim into dependent tasks' prompts - completeness here directly impacts downstream task quality.

### State Transitions
Plan status flows: `planning` → `implementing` → `verifying` → `completed` (or `paused`, `stopped`, or `failed` at any point). The `pausing` state is an intermediate transition set by `/om-pause` - the runner lets the current task finish, then settles to `paused`. The `stopped` state is entered immediately via `/om-stop` or `orchestrate_stop` — all processes are killed and execution halts.

Task status: `pending` → `running` → `validating` (complex tasks only) → `summarizing` → `completed` (with possible detours to `awaiting_clarification` or `failed`).

**Pause vs Stop**: `/om-pause` transitions to `paused` (graceful — current task finishes), while `/om-stop` and the `orchestrate_stop` tool transition to `stopped` (immediate — all processes killed). Both states display distinct TUI labels (`PAUSED` in amber, `STOPPED` in red) and can be resumed with `/om-resume`. The watchdog skips stall detection for `paused`, `stopped`, and `pausing` states so it doesn't nudge the orchestrator when execution is intentionally halted.

### Error & Notification Messages
- **Orchestrator notifications** (via `notifyOrchestrator()`): Prefix with `"System: "` for system-initiated messages. Include task IDs when relevant. No trailing period.
- **Console warnings/errors**: Use `[module-name]` prefix pattern, e.g., `[validator attempt 1]`, `[task-summary task_01]`.

## Adding New Features

### New Tools
1. Add the tool registration in the appropriate module under `tools/` - `plan-tools.ts`, `task-crud.ts`, `execution-control.ts`, or `review-tools.ts` - and import it in `tools/index.ts`.
2. If it should be available during planning, add its name to `PLANNING_TOOLS` in `core/state-singleton.ts`; otherwise add to `EXECUTION_TOOLS`.
3. Ensure mode guards (`requireExecutionMode()` or explicit checks) are applied.

### New Commands
1. Add the command handler function in `commands/commands.ts`.
2. Register it via `pi.registerCommand()` - either directly in `index.ts` or inside `registerOrchestrationCommands()`.

### New State Fields
1. Add to the relevant interface in `core/types.ts` if it's part of the plan schema.
2. If it's runtime-only state, add to `OrchestratorState` in `core/state-singleton.ts` and ensure `resetState()` clears it.
3. Ensure persistence is handled in `context/state-manager.ts` if the field must survive restarts.

## Important Gotchas

- **Never modify plan.json directly** - always go through `StateManager.savePlan()`. It guards against writes during shutdown.
- **One-shot flags** on `OrchestratorState` (prefixed with `_`) are reset at specific lifecycle points; don't set them from multiple paths without understanding the reset logic.
- **Tool visibility is mode-gated** via `updateActiveTools()` - after any mode change, this must be called to ensure correct tool availability.
- **Model switching**: The extension captures and restores models at several boundaries (enter/exit orchestration mode, enter/exit planning mode). Always use the helper functions in `core/state-singleton.ts` rather than calling `pi.setModel()` directly.
