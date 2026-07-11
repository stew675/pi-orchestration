import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Thin facade — preserves the exact same public API for index.ts.
// All logic is delegated to phase-specific modules under tools/.
// ---------------------------------------------------------------------------

/**
 * Register all orchestration tools via modular sub-files:
 * - plan-tools.ts          → write_plan, edit_plan, present_plan (planning)
 * - task-crud.ts           → add_task, delete_task, complete_task, edit_task, get_plan
 * - execution-control.ts   → ready_tasks, start_task, check_status, replan, resume_task, stop
 * - review-tools.ts        → approve_goal (review phase)
 */
export function registerTools(pi: ExtensionAPI): void {
    const { registerTools: delegate } = require("./tools/index");
    delegate(pi);
}
