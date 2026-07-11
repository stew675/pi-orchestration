import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StateManager } from "../context/state-manager";
import { Runner } from "../runner";
import { OrchestratorState, getPi, setOrchestrationMode, NOT_ACTIVE_MSG } from "../core";
import { refreshBorder } from "../ui/ui";
import { resetLoopState } from "../process/loop-detector";

/** Plan status that permits goal approval. */
const REVIEW_STATUS = "reviewing";

/** Register review-phase tools (approve_goal). */
export function registerReviewTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: "orchestrate_approve_goal",
        label: "Approve Goal",
        description:
            "Mark the goal as fully satisfied and complete the orchestration. Only callable during review phase.",
        promptSnippet: "Approve that the project meets the original goal and finish",
        promptGuidelines: [
            "Call orchestrate_approve_goal ONLY when plan status is 'reviewing' (after all tasks completed). " +
                "It will FAIL if called during planning, executing, or any other phase."
        ],
        parameters: Type.Object({
            summary: Type.String({ description: "Brief summary of what was delivered" })
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            if (!OrchestratorState.isActive) throw new Error(NOT_ACTIVE_MSG);
            const plan = StateManager.loadPlan();
            if (!plan) throw new Error("No plan exists.");

            // Only allow approval during the review phase — prevents premature approval
            if (plan.status !== REVIEW_STATUS) {
                throw new Error(
                    `Cannot approve: plan is in '${plan.status}' status. ` +
                        "orchestrate_approve_goal can only be called when the plan is in 'reviewing' status " +
                        "(after all tasks have completed and the system has entered review mode)."
                );
            }

            plan.status = "completed";
            StateManager.savePlan(plan);

            // Clear all internal orchestrator state so a new goal starts fresh.
            resetLoopState();
            Runner.cancelAllSummaries();

            // Transition out of execution mode so the TUI border reflects completion.
            setOrchestrationMode(true, false, false, getPi(), refreshBorder);

            return {
                content: [
                    {
                        type: "text",
                        text: `Goal approved. Orchestration completed successfully.\n\nDeliverables: ${params.summary}`
                    }
                ],
                terminate: true,
                details: {}
            };
        }
    });
}
