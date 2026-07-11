import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tool names used by validator sub-agents to signal pass/fail. */
export const VALIDATE_PASS_TOOL = "orchestrate_validate_pass";
export const VALIDATE_FAIL_TOOL = "orchestrate_validate_fail";
export const VALIDATOR_TOOLS = `${VALIDATE_PASS_TOOL},${VALIDATE_FAIL_TOOL}` as const;

/** Check if a tool name is one of our validator signal tools. Returns the result or null. */
export function parseValidateToolCall(toolName: string): "pass" | "fail" | null {
    if (toolName === VALIDATE_PASS_TOOL) return "pass";
    if (toolName === VALIDATE_FAIL_TOOL) return "fail";
    return null;
}

/** Register the validator tools (orchestrate_validate_pass, orchestrate_validate_fail).
 *
 * These are thin signal-only tools — when called they immediately tell the model to stop.
 * The orchestrator detects which tool was invoked via stdout events and resolves accordingly. */
export function registerValidatorTools(pi: ExtensionAPI) {
    pi.registerTool({
        name: "orchestrate_validate_pass",
        label: "Validate Pass",
        description: [
            "Call this when you have verified the task was completed successfully.",
            "After calling, stop — do not make any further tool calls or messages."
        ].join("\n"),
        parameters: { type: "object" } as any,
        async execute() {
            return {
                content: [
                    { type: "text", text: "Validation passed. You may now stop — no further action needed." }
                ] as any,
                terminate: true,
                details: {}
            };
        }
    });

    pi.registerTool({
        name: "orchestrate_validate_fail",
        label: "Validate Fail",
        description: [
            "Call this when you have determined the task was NOT completed successfully.",
            "After calling, stop — do not make any further tool calls or messages."
        ].join("\n"),
        parameters: { type: "object" } as any,
        async execute() {
            return {
                content: [
                    { type: "text", text: "Validation failed. You may now stop — no further action needed." }
                ] as any,
                terminate: true,
                details: {}
            };
        }
    });
}
