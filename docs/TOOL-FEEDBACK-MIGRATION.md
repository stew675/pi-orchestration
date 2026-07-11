# Implementation Plan: Automate Orchestrator Constraints via Tool-Call Feedback

## Problem Statement

The `ORCHESTRATOR_EXECUTION_SYSTEM_PROMPT` was ~8,650 characters (~1,720 tokens) of behavioral guidance. The model frequently ignored instructions buried deep in this prompt (task sizing, naming conventions, redundant verification tasks) while responding reliably to direct tool-call error feedback. System prompt bloat itself was making compliance worse - simpler prompts yield better adherence.

### Key Discovery: `promptGuidelines` Were Lost Under Custom System Prompt

When `before_agent_start` returns `{ systemPrompt: ORCHESTRATOR_EXECUTION_SYSTEM_PROMPT }`, it sets `_systemPromptOverride`. This **completely replaces** `_baseSystemPrompt` - which means all `promptGuidelines` from tool definitions were silently dropped. The model only saw our custom prompt text + raw function-calling schemas.

---

## What Was Implemented ✅

### Phase 1: Enhanced Tool Parameter Descriptions (`tools/task-crud.ts`)

All constraints that were in the system prompt are now encoded directly in function-calling parameter descriptions - these are **always visible** to the model as part of the tool schema, unlike system prompt text which gets diluted by conversation history.

| Parameter | New Description Highlights |
|---|---|
| Tool `description` | Naming convention, file limits, focus requirement, read-only type behavior |
| `id` | Must match `'task_phaseN_title'`, first 10 chars must be `'task_phase'` |
| `description` | Single-concern, explicit item names, never vague phrases like "all algorithms" |
| `files` | Max 2 for creation/editing (prefer 1), exempt types listed |
| `dependencies` | Build/test tasks MUST list ALL code-creation tasks. Never leave empty - causes data races |

### Phase 2: Silent Guidance via `{ display: false }` Messages (`tools/task-crud.ts`, `tools/execution-control.ts`)

Non-blocking warnings sent via `pi.sendMessage({ customType: "orchestrator_event", content: ..., display: false }, { deliverAs: "nextTurn" })`. The model sees these in conversation history but the user doesn't see noise in TUI.

| Trigger | Guidance Sent |
|---|---|
| Vague description detected (patterns: "all algorithms", "everything", "the rest", etc.) | Reminder to list specific items explicitly - sub-agent implements literally what you describe |
| Empty dependencies on non-read-only task with files | Warning about data races if task operates on files from other tasks |
| Build/test task started with no dependencies | Reminder to ensure code-creation tasks are listed as dependencies |
| Verification-phase first `add_task` (already existing) | Blocks first call, reminds model to check for redundant work before adding verification tasks |

### Phase 2b: Enhanced Tool Responses (`tools/execution-control.ts`)

`orchestrate_ready_tasks` response now includes inline guidance appended after the JSON payload:
- When `running` is non-empty: "The system will wake you automatically when complete - do not call any other tools."
- When `failed` is non-empty: "Use orchestrate_replan to enter recovery mode, then fix with orchestrate_edit_task."

### Phase 3: Reduced System Prompt (`index.ts`)

**From ~8,650 chars (1,720 tokens) → ~1,395 chars (270 tokens) - an 84% reduction.**

What was removed (now covered by tool parameters/validation):
- "TOOLING GUIDELINES" / "AVAILABLE TOOLS" section (~300 chars) - model sees tool schemas directly
- "TASK NAMING, FOCUS, AND SIZING" section (~600 chars) - moved to parameter descriptions + validation errors
- "TASK DEPENDENCY RULES" section (~500 chars) - moved to `dependencies` param description + silent guidance
- "EXPLICIT ITEM NAMING IN TASK DESCRIPTIONS" section (~300 chars) - moved to `description` param + vague-pattern warning
- "READ-ONLY TASK TYPES" section (~800 chars) - encoded in `taskType` enum description (implicit from tool grants anyway)
- "TOOL CALL FORMATTING" section (~150 chars) - framework-level concern, schemas handle this

What stays (purely behavioral guardrails):
- Role definition ("You are the Orchestrator...") - ~50 chars
- "Don't write code" rule - ~80 chars
- Stop after start_task - ~60 chars
- Execution loop flow (ready/running/failed branching) - ~200 chars
- Final review behavior - ~100 chars

---

## Constraint Coverage Matrix (After Changes)

| Constraint | Enforcement Layer |
|---|---|
| Task naming: `task_phaseN_title` | ✅ Validation error on add_task + param description |
| Max 2 files per task | ✅ `detectOversizedTasks()` throws + param description |
| Cycle detection | ✅ `validatePlan()` throws (unchanged) |
| File conflict detection | ✅ `orchestrate_start_task` throws (unchanged) |
| Build tasks depend on ALL code tasks | ✅ Param description + silent guidance on start_task |
| Never leave dependencies empty | ✅ Param description + silent guidance on add_task |
| Explicit item naming in descriptions | ✅ Param description + vague-pattern warning via sendMessage |
| Read-only task behavior | ✅ `taskType` enum description (implicit from tool grants) |
| Stop after start_task | ✅ System prompt rule + `terminate: true` on tool |
| Execution loop mechanics | ✅ System prompt flow + enhanced ready_tasks response |
| Final review: no redundant tasks | ✅ Verification-phase gate (blocks 1st add_task) + system prompt reminder |
| Handle tool errors intelligently | ✅ System prompt guidance |

---

## Risk Assessment & Mitigation

| Risk | Mitigation |
|---|---|
| Model loses behavioral context from removed SP sections | Tool parameter descriptions always visible in schemas; silent guidance reinforces at call time |
| Silent `{ display: false }` messages arrive too late (nextTurn delivery) | Cross-turn guidance is sufficient - orchestrator adds tasks then starts them in separate turns anyway |
| Vague-description regex catches legitimate text | Patterns are conservative ("all algorithms", "everything") - low false-positive rate; warning not blocking |
| Model ignores condensed system prompt entirely | Tool-call feedback is primary enforcement mechanism now; SP is just safety net |

## Rollback Plan

If behavior degrades:
1. Restore full system prompt (git revert) - instant rollback, tool enhancements remain as additive improvements
2. Iterate on which specific sections can be safely removed
3. The silent guidance and parameter description changes are harmless even with the old prompt

