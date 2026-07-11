import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlanTools } from "./plan-tools";
import { registerTaskCrudTools } from "./task-crud";
import { registerExecutionControlTools } from "./execution-control";
import { registerReviewTools } from "./review-tools";
import { registerValidatorTools } from "./validator-tools";

/** Register all orchestration tools by delegating to phase-specific modules. */
export function registerTools(pi: ExtensionAPI) {
    registerPlanTools(pi);
    registerTaskCrudTools(pi);
    registerExecutionControlTools(pi);
    registerReviewTools(pi);
    registerValidatorTools(pi);
}
