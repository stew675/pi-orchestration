# Pi Orchestration Extension

A goal-based multi-agent task orchestration system with planning, execution, validation, and user-in-the-loop clarification.

## Summary

Intended for complex, goal-based fire-and-forget LLM driven multi-step goals (refactoring, migrations, large features) where a model can't hold the full context.

This extension spawns an **Orchestration** LLM that decomposes your goal into tasks, then delegates each task to independent sub-agents with explicit tool permissions and focused context.

## How To Install

Installation is easy.  Just clone this repository wherever you want it to be, and then create a symlink from the repository directory to your Pi Agent Extensions directory (typically `~/.pi/agent/extensions/`

For example:
```
# Example of clone repository into ~/src in your home directory
mkdir -p ~/src && cd ~/src
git clone https://github.com/stew675/pi-orchestration

# Link the cloned repository as a Pi Agent Extension
mkdir -p ~/.pi/agent/extensions
ln -s ~/src/pi-orchestration ~/.pi/agent/extensions/orchestration
```

## Features

- **Declarative planning**: Orchestrator builds a plan via `orchestrate_write_plan` / `orchestrate_edit_plan`, producing an `implementation-plan.md` you review with an Accept/Edit dialog
- **Automated multi-model use**: Specify the models you want to use for Planning, Orchestration, Simple Tasks, Complex Tasks, Reviewing and Verifying, Summarizing
- **Dynamic Error Recovery**: The orchestrator can recover from errors mid-execution via `orchestrate_replan`, which returns control to planning mode so new or modified tasks can be added in response to events and issues
- **Live User Plan Changes**: The user can pause orchestration (`/om-pause`), edit `implementation-plan.md` directly on disk, then resume with `/om-resume`. On resume the orchestrator re-reads the plan from disk and adapts its execution to incorporate the changes.
- **Focused System Prompts**: The system uses tailored system prompts for each mode of operation so your models always know exactly what their role is at all times
- **Context Pruning**: The system will aggressively prune the context history when switching modes so your models can stay focused on exactly what they need to be
- **Sub-agent delegation**: Each task runs in an isolated `pi --mode json` process with restricted tool access
- **Internal validation**: Complex tasks are automatically reviewed by a dedicated Validator sub-agent; if the validator returns feedback the task retries once with that feedback injected into the prompt. After exhausting retries (or on non-retryable failures) the task is marked `failed`
- **Task summarization**: After each task, a summary agent scans all artifact files and produces an exhaustive API listing (types, classes, functions with signatures, constants, line numbers) is injected verbatim into dependent tasks' prompts. Runs synchronously by default or asynchronously with configurable concurrency (`/om-settings`)
- **Read-only tasks**: Tasks of type `reviewing` or `research` spawn sub-agents with only `read`, `ls`, `find`, `grep` tools, and skip summarization entirely. They still undergo validation to ensure they produced output that aligns with the task.
- **Clarification loop**: Sub-agents can pause and ask the user questions; answers flow back via the Orchestrator. Full clarification history is tracked per task
- **Infinite loop protection**: Tasks auto-fail after exceeding 5 clarification attempts (i.e., on the 6th request)
- **Sub-Agent Loop detection**: A cycle detector extracts signatures from sub-agents and kills the sub-agent process if a model loop is detected
- **Orchestrator Loop detection**: A cycle detector monitors the main orchestration model and will inject prompts to attempt to break it out of a looping pattern
- **Live Sub-Agent monitoring**: `/om-status` includes a real-time stream of the current task's sub-agent output events. Validators and summarizers feed into the monitor for JSON parsing but do not hijack the active view (`skipActive: true`)
- **Sub-agent idle timeout**: Global watchdog kills any sub-agent with no JSON stream activity for a configurable period (default 5m30s, set via `/om-settings`). Prevents stalled agents that consume resources without progress
- **Sub-agent max turns**: Global watchdog kills any sub-agent exceeding a maximum model turn count (default 30, set via `/om-settings`). Prevents runaway agents stuck in inefficient loops
- **Parallel execution**: Configurable number of simultaneous tasks via `/om-settings` (`parallelTasks`, default 1)
- **Graceful recovery**: Resume from any state (paused, failed, reviewing) without losing progress
- **Watchdog timers**: Each sub-agent phase has an independent timeout; exceeded tasks are killed via SIGTERM → SIGKILL escalation

## Commands

| Command | Description |
|---------|-------------|
| `/om-enable` | Toggle orchestration mode on/off (with confirmation) |
| `/om-plan` | Toggle planning mode on/off (build/edit implementation plan) |
| `/om-status` | Live-updating overlay of the task list + sub-agent live-stream |
| `/om-settings` | Open settings overlay |
| `/om-accept` | Approve the plan and begin execution |
| `/om-pause` | Gracefully halts execution. Lets the current task finish, then stops |
| `/om-stop` | Immediately kill active sub-agents and pauses |
| `/om-resume` | Resume from last known state (handles all states) |
| `/om-reset` | Clear current progress entirely and start fresh |

## Available Settings

| Setting | Description |
|---------|-------------|
| `planning model` | LLM model to use for building implementation plans |
| `orchestration model` | LLM model to use for orchestrating tasks |
| `simple task model` | LLM model to use for simple tasks |
| `complex task model` | LLM model to use for complex tasks |
| `validation model` | LLM model to use for task validation |
| `summarization model` | LLM model to use for summarizing tasks |
| `summarization concurrency` | Maximum parallel summaries permitted |
| `parallel tasks` | maximum concurrent simple/complex tasks |
| `allow orchestrator stop` | Allows orchestrator to stop on severe issues |
| `Validate Simple Tasks` | Whether to use validation on simple tasks |
| `Validate Complex Tasks` | Whether to use validation on complex tasks |
| `Sub-agent idle timeout` | Kill any sub-agent with no JSON activity for this period (default 5m30s; 0 = disabled) |
| `Sub-agent max turns` | Kill any sub-agent exceeding this model turn count (default 30; 0 = unlimited) |
| `Reset Defaults` | Reset settings to default |


## Work Flow OverView

1. Enable orchestration: `/om-enable` (automatically enters planning mode)
2. Describe your goal (e.g., *"Refactor the auth module to use JWT instead of session cookies"*)
3. The Orchestrator builds an implementation plan for you
4. Either accept the plan, or describe changes, or modify it directly on disk
5. Once approved (`/om-accept`), the Orchestrator decomposes the plan into phase based tasks begins execution
6. Inspect ongoing progress with `/om-status`
7. To re-enter planning mode after completion or pause/stop: `/om-plan`
8. When ready, approve and start execution: `/om-accept`
9. If a task needs clarification, you'll be prompted to provide an answer and resume with `/om-resume`
10. When all tasks complete, the Orchestrator performs a final review


## Plan Structure

The orchestrator will create the `.pi/orchstration/` directory in your project directory where it manages its state

```
.pi/orchestration/
├── plans/                   ← Plan documents (JSON + Markdown)
│   ├── plan.json            ← Source of truth (JSON) with crash-resilient backups (.old)
│   ├── implementation-plan.md  ← Human-readable plan written during planning phase
│   └── plan.md              ← Rendered Markdown projection of plan.json
├── tasks/                   ← Active task prompt files (.prompt.md) for running sub-agents
├── validations/             ← Validator artifacts (mirrors summaries/ pattern)
│   ├── <taskId>.prompt.md    ← Validation prompt sent to the validator agent
│   └── <taskId>.response.json ← Validator JSON result {pass, feedback, validatedAt}
├── summaries/               ← Summary sub-agent artifacts (.prompt.md, .response.md, .error.md)
├── archive/                 ← Completed task results and prompts moved here after completion
└── agent-logs/              ← Raw sub-agent transcript logs (.log)
```


### Task Schema

**Tasks** form a flat graph with dependencies encoded as JSON

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (e.g., `"task_01"`) |
| `description` | string | What the task should accomplish |
| `files` | string[] | Predicted list of files to read/modify |
| `dependencies` | string[] | Task IDs providing context/files |
| `taskType` | string | One of: `creation`, `editing`, `building`, `administrative`, `research`, `reviewing`, or `other`. Read-only types (`reviewing`/`research`) spawn sub-agents with only `read,ls,find,grep` tools and skip summarization |
| `complexity` | string | `"simple"` or `"complex"` (only `complex` triggers validation) |
| `timeoutMs` | number | Max execution time before watchdog kills the sub-agent (default from settings; per-task override) |
| `status` | string | Current state: `pending`, `running`, `validating`, `summarizing`, `completed`, `failed`, or `awaiting_clarification` |
| `result.artifacts` | string[] | Actual list of files created/modified (populated during execution) |
| `validatorFeedback` | string | Validator feedback or failure reason |
| `attempts` | number | Number of execution attempts for this task |
| `result.summary` | string | API surface summary generated after completion; injected into dependent tasks' prompts |
| `clarificationHistory` | object[] | History of clarification Q&A exchanges for this task

When a task completes, its prompt file is moved from `tasks/` to `archive/` alongside the result JSON. This lets you inspect exactly what context was given to each sub-agent.


## How It All Works

### Planning Phase
- The Orchestrator receives your goal and uses `orchestrate_write_plan` / `orchestrate_edit_plan` to build an `implementation-plan.md` on disk.
- After each write or edit, an **Accept/Edit dialog** overlays the TUI: you can accept the plan as-is, type feedback for the orchestrator to incorporate, or cancel back to planning mode.
- The user may, if they wish, directly edit the `implementation-plan.md` saved on disk, and reload the new version via `/om-plan` and accept their updated version
- If Pi is exited mid-plan, then the Pr Orchestrator will prompt to continue with editing the plan on the next startup.

### Task Building Phase
- Once the proposed implementation plan is accepted by the user, the orchestrator clears all prior session context and then focuses on just the plan.
- The orchestrator splits up the implementation plan and commits them to the dependency graph for automated execution
- Tasks must only create or modify on one or two files at a time
  - This keeps tasks small and focused, which generally leads to better results
- The orchestrator must specify all dependencies for each task.
  - If the automated dependency scanning system catches a missed dependency it will reject the task until the orchestrator corrects it
  - Why reject and not just automatically add the dependency?  This is because rejection causes the model to consider dependencies more carefully and generally results in a better task breakdown.

### Execution Phase
- Ready tasks (all dependencies satisfied) are scheduled by the `Runner` class via `pi --mode json` subprocesses
- Sub-agents get explicit tool permissions (`read`, `write`, `bash`, `edit`)
  - No file system access beyond what's needed. eg. A **read-only task** (`taskType: reviewing/research`) get only get access to `read,ls,find,grep`
- All necessary context for a task is injected as a system prompt (goal, dependency summaries from completed ancestor tasks, sibling task info)
- **Parallel execution**
  - When `parallelTasks` > 1 in settings, multiple independent ready tasks run simultaneously up to the configured limit
- **Loop detection**
  - Every running sub-agent has a `LoopDetector` attached to its event stream.
  - The detector extracts signatures from `message_end` and `tool_call` events using raw parameter values (no normalisation). `tool_result` events are excluded to prevent false positives on sequential reads.
  - If a cycle of 1–3 events repeats ≥5 times, the process is killed with SIGTERM and the task marked `failed`
### Live Sub-Agent Monitoring
`/om-status` streams the current task's sub-agent output in real time. The monitor displays a "model-only" view - assistant text without tool-call/result noise - while maintaining undelayed responsiveness via streaming event refresh triggers.
- The orchestration can be paused and return to the Task Building Phase at any time to take corrective actions or to modify the live plan

### Task Validation (Complex and Read-Only Tasks)
Tasks marked as complex spawn a dedicated Validator sub-agent that reviews all artifact files and either approves or returns structured feedback.
- Validator agents run with read-only tool access (`read`, `ls`, `find`, `grep`).
- If the validator fails to produce valid JSON output, it retries up to 2 times (JSON parsing only).
- If validation fails: recoverable failures (sub-agent exited cleanly) are auto-completed with a validator note. Non-recoverable failures mark the task as `failed` and wake the orchestrator for replanning via `orchestrate_replan`.
- Read-only tasks are always validated to ensure they produced relevant output.
- Tasks marked as simple do not automatically undergo validation (unless `validateSimpleTasks` is enabled in settings).
- Validation artifacts are persisted in `.pi/orchestration/validations/`: the prompt sent to the validator (`<id>.prompt.md`) and the final response JSON (`<id>.response.json`) for debugging.

### Task Summarization (All except Read-Only Tasks)
After a task completes (and passes validation if applicable), a summary sub-agent reads every artifact file and produces an exhaustive listing of all public APIs, data types, classes, functions with full signatures, constants, line numbers, and behavioral constraints.
- This summary is stored in the task's `result.summary` field and injected verbatim into dependent tasks' prompts.
- Summarization runs *synchronously* by default or *asynchronously*
  - Asynchronous summarization occurs when `summarizationConcurrency` ≥ 1
  - The runner schedules other ready tasks while summaries complete in background via a semaphore.
  - Task dependency always enforced.  Any task relying on the summary of another must wait until summarization is complete.
- Read-only tasks skip summarization.  A read-only task's output messages are captured directly as the summary.

### Task Clarification Flow
A Task Sub-Agent may call for clarification if it finds its prompt to be unclear.  The way this works is as follows:
1. Sub-agent writes `clarification.json` to its temp directory with a query
2. Task status → `awaiting_clarification`, execution pauses
3. Orchestrator prompts you via TUI notification
4. You answer, Orchestrator calls `orchestrate_resume_task(id, answer)`
5. Sub-agent resumes with the answer injected into its context
6. If clarification is requested more than 5 times (i.e., on the 6th request), task auto-fails and may be edited and rescheduled by the orchestrator
7. All Q&A exchanges are tracked in the task's `clarificationHistory` array for audit/debugging

### State Recovery
Plan state persists in `.pi/orchestration/plans/plan.json` with crash-resilient backups (`.old`). If an active plan is found at startup:
- Execution state → prompts to resume; interrupted tasks auto-reset to `pending`
- Paused/clarification → shows what's waiting
- Reviewing → wakes the reviewer on resume

### Final Verification
When all tasks are completed the orchestration model will perform one final assessment before approving the goal.  It may create remedial tasks to correct issues where the project has not met the goal.

### Configurable Timeouts
All sub-agent watchdog timeouts are configurable via `/om-settings` (TUI) or by editing `settings.json`. Three independent timers control different phases:

| Timeout | Default | Controls |
|---------|---------|----------|
| Task timeout | 12m | Main implementation sub-agents; per-task `timeoutMs` in plan overrides this |
| Validator timeout | 4m | Read-only validation agents for complex tasks |
| Task summary timeout | 2m | Per-task API surface summaries injected into dependent tasks |
| Sub-agent idle timeout | 5m30s | Kill any sub-agent with no JSON stream activity (global, all types) |
| Sub-agent max turns | 30 | Kill any sub-agent exceeding this model turn count (global, all types) |

Time formats: `30s`, `1m20s`, `15m`, or `0` (no timeout). Settings use a two-tier resolution: project-local `.pi/orchestration/settings.json` is checked first, then falls back to global `~/.pi/agent/orchestration-settings.json`. Project-local takes full precedence when present. Sub-agent processes use SIGTERM → SIGKILL escalation for timeout enforcement.

## Limitations & Deferred Items

The following features are partially implemented or deferred:

- **User interrupt detection**: Explicit `/om-pause` or `/om-stop` are the current mechanisms for pausing orchestration
  - Detection of user keyboard interrupts during sub-agent runs is not implemented for safety to prevent a stray escape key press from interrupting orchestration
- **State rotation/purge**: Archived task context files in `.pi/orchestration/archive/` accumulate indefinitely and are never purged automatically
