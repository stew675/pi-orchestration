import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StateManager } from "../context/state-manager";
import { OrchestratorState, NOT_ACTIVE_MSG } from "../core";
import { renderPlanResult, renderWritePlanCall, renderWritePlanResult } from "./shared";

/** Build a standard tool response with terminate flag. */
function toolResponse(text: string) {
    return { content: [{ type: "text", text }] as any, terminate: true, details: {} };
}

/** Register the implementation-plan tools (planning phase). */
export function registerPlanTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: "orchestrate_write_plan",
        label: "Write Plan File",
        description:
            "Create or overwrite the implementation plan file (.pi/orchestration/plans/implementation-plan.md). Use this during planning to persist your current plan. No path needed.\n" +
            "Plan quality: be detailed with file paths, line number ranges, and function names. Refer to sections as 'Phase' (not 'Task'). Provide concrete examples of what to change or add.",
        promptSnippet: "Write the full implementation plan to disk",
        promptGuidelines: [
            "Use orchestrate_write_plan to create or update the implementation plan file.",
            "Call it whenever you finalize a section of the plan, so progress is preserved."
        ],
        parameters: Type.Object({
            content: Type.String({ description: "The full markdown content for the implementation plan" })
        }),
        executionMode: "sequential",
        renderShell: "self",
        renderCall: renderWritePlanCall,
        renderResult: renderWritePlanResult as any,
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            if (!OrchestratorState.isActive) throw new Error(NOT_ACTIVE_MSG);
            StateManager.saveImplementationPlan(params.content);
            return toolResponse("Implementation plan saved.");
        }
    });

    pi.registerTool({
        name: "orchestrate_edit_plan",
        label: "Edit Plan File",
        description:
            "Surgically edit the implementation plan file. Provide the exact text to replace and its replacement. No path needed.\n" +
            "When editing, search and update ALL relevant sections to enact every requested change — don't just patch one spot.",
        promptSnippet: "Edit a section of the implementation plan",
        promptGuidelines: [
            "Use orchestrate_edit_plan for surgical updates to an existing plan.",
            "The oldText must match exactly (including whitespace). Use orchestrate_get_plan first if unsure."
        ],
        parameters: Type.Object({
            oldText: Type.String({ description: "The exact text in the file to replace" }),
            newText: Type.String({ description: "The replacement text" })
        }),
        executionMode: "sequential",
        renderShell: "self",
        renderResult: renderPlanResult,
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            if (!OrchestratorState.isActive) throw new Error(NOT_ACTIVE_MSG);
            const result = StateManager.editImplementationPlan(params.oldText, params.newText);
            return toolResponse(result);
        }
    });

    pi.registerTool({
        name: "orchestrate_present_plan",
        label: "Present Plan for Review",
        description:
            "Load the existing implementation plan from disk and present it to the user for review. " +
            "Use this when asked to display an existing plan - do NOT summarize or rewrite it.",
        promptSnippet: "Display the existing implementation plan and trigger the Accept/Edit dialog",
        promptGuidelines: [
            "Call orchestrate_present_plan when instructed by the system to show an existing plan. " +
                "After calling this, STOP immediately - do not generate any further content.",
            "Do NOT call this during normal planning; only use it when explicitly requested."
        ],
        parameters: Type.Object({}),
        renderShell: "self",
        renderResult: renderPlanResult,
        executionMode: "sequential",
        async execute(_id, _params, _signal, _onUpdate, _ctx) {
            if (!OrchestratorState.isActive) throw new Error(NOT_ACTIVE_MSG);

            const planContent = StateManager.loadImplementationPlan();
            if (!planContent || !planContent.trim()) {
                return toolResponse("No implementation plan found on disk.");
            }

            // Flag that the plan was just presented - triggers Accept/Edit dialog on turn_end.
            OrchestratorState._planJustUpdated = true;
            OrchestratorState._incorporatingFeedback = false; // Finished incorporating review feedback.

            return toolResponse(`--- Implementation Plan ---\n\n${planContent}`);
        }
    });

    pi.registerTool({
        name: "orchestrate_review_plan",
        label: "Write Plan Review",
        description:
            "Write a review of the implementation plan to .pi/orchestration/plans/plan-review.md. " +
            "This tool is used by the reviewer model to capture its assessment of the plan.\n" +
            "After calling this, STOP IMMEDIATELY — do not generate further content.",
        parameters: Type.Object({
            reviewContent: Type.String({ description: "The full markdown content for the plan review" })
        }),
        executionMode: "sequential",
        async execute(_id, params, _signal, _onUpdate, _ctx) {
            if (!OrchestratorState.isActive) throw new Error(NOT_ACTIVE_MSG);
            StateManager.savePlanReview(params.reviewContent);
            return toolResponse("Plan review saved to plan-review.md.");
        }
    });
}
