import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StateManager } from "../context/state-manager";

/** Tool names used by code-review sub-agents to signal verdict. */
export const CODE_REVIEW_APPROVE_TOOL = "orchestrate_code_review_approve";
export const CODE_REVIEW_REJECT_TOOL = "orchestrate_code_review_reject";

/** Register the code review tools. These tools are used only by the code-review sub-agent. */
export function registerCodeReviewTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: CODE_REVIEW_APPROVE_TOOL,
        label: "Code Review Approve",
        description: [
            "Call this when you have verified that all code changes are correct, robust, and align with the implementation plan.",
            "This will record your approval and stop the sub-agent process."
        ].join("\n"),
        parameters: Type.Object({}),
        async execute() {
            // Delete old code-review.md if present, and write APPROVED
            StateManager.deleteCodeReview();
            StateManager.saveCodeReview("APPROVED\n");

            return {
                content: [
                    { type: "text", text: "Code review approved successfully. You may now stop." }
                ],
                terminate: true,
                details: {}
            };
        }
    });

    pi.registerTool({
        name: CODE_REVIEW_REJECT_TOOL,
        label: "Code Review Reject",
        description: [
            "Call this when you find issues that must be addressed before approval.",
            "Requires a detailed markdown review listing specific issues and recommendations.",
            "This will record the feedback and stop the sub-agent process."
        ].join("\n"),
        parameters: Type.Object({
            review: Type.String({ description: "Detailed markdown code review including issues and recommended changes." })
        }),
        async execute(_id, params) {
            // Delete old code-review.md if present, and write CHANGES NEEDED followed by the review
            StateManager.deleteCodeReview();
            StateManager.saveCodeReview(`CHANGES NEEDED\n\n${params.review}`);

            return {
                content: [
                    { type: "text", text: "Code review rejected with feedback. You may now stop." }
                ],
                terminate: true,
                details: {}
            };
        }
    });
}
