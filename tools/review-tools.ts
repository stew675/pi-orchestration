import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StateManager } from "../context/state-manager";
import { Runner } from "../runner";
import { OrchestratorState, getPi, setOrchestrationMode, NOT_ACTIVE_MSG } from "../core";
import { refreshBorder } from "../ui/ui";
import { resetLoopState } from "../process/loop-detector";
import { buildFinalReviewMessage, notifyOrchestrator } from "../runner/utils";
import { transitionTo, isActive as stateIsActive } from "../core/state-machine";

/** Plan status that permits goal approval (verification phase). */
const REVIEW_STATUS = "verifying";

/** Register review-phase tools (approve_goal). */
export function registerReviewTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: "orchestrate_approve_goal",
        label: "Approve Goal",
        description:
            "Mark the goal as fully satisfied and complete the orchestration. Only callable during review phase.",
        promptSnippet: "Approve that the project meets the original goal and finish",
        promptGuidelines: [
            "Call orchestrate_approve_goal ONLY when plan status is 'plan_review' (after all tasks completed). " +
                "It will FAIL if called during planning, executing, or any other phase."
        ],
        parameters: Type.Object({
            summary: Type.String({ description: "Brief summary of what was delivered" })
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            const plan = StateManager.loadPlan();
            if (!plan) throw new Error("No plan exists.");

            if (OrchestratorState.currentState === "code_review") {
                throw new Error(
                    "orchestrate_approve_goal may not be used when in the CODE_REVIEW phase. " +
                    "To exit the CODE_REVIEW phase, you must either use orchestrate_complete_review, " +
                    "or issue 1 or more task commands (such as orchestrate_add_task) followed by orchestrate_start_task."
                );
            }

            // Only allow approval during the verification phase - prevents premature approval
            if (OrchestratorState.currentState !== REVIEW_STATUS) {
                throw new Error(
                    `Cannot approve: plan is in '${OrchestratorState.currentState}' status. ` +
                        "orchestrate_approve_goal can only be called when the plan is in 'verifying' status " +
                        "(after all tasks have completed and the system has entered verification mode)."
                );
            }

            // Clear all internal orchestrator state so a new goal starts fresh.
            resetLoopState();
            Runner.cancelAllSummaries();

            // Transition to completed state and out of execution mode via the state machine
            setOrchestrationMode("completed", getPi(), refreshBorder, plan);
            StateManager.savePlan(plan);

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

    pi.registerTool({
        name: "orchestrate_complete_review",
        label: "Complete Code Review",
        description: "Complete the code review phase and proceed to final verification. Only callable during the CODE_REVIEW phase.",
        parameters: Type.Object({}),
        async execute() {
            if (!stateIsActive(OrchestratorState.currentState)) throw new Error(NOT_ACTIVE_MSG);
            const plan = StateManager.loadPlan();
            if (!plan) throw new Error("No plan exists.");

            if (OrchestratorState.currentState !== "code_review") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "orchestrate_complete_review may only be used when in the CODE_REVIEW phase."
                        }
                    ],
                    details: {}
                };
            }

            // Transition to the VERIFYING phase
            if (!transitionTo("verifying", plan)) {
                throw new Error("Failed to transition to verifying state after code review");
            }
            StateManager.savePlan(plan);

            // Wake up the orchestrator model and enter final review
            const reviewMessage = buildFinalReviewMessage(plan, "System: Code review complete. Entering FINAL REVIEW.");
            notifyOrchestrator(getPi(), reviewMessage, { tuiVisible: false });

            return {
                content: [
                    {
                        type: "text",
                        text: "Code review marked as complete. Proceeding to final review."
                    }
                ],
                details: {}
            };
        }
    });
}
