import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "../core/types";
import { getEventToolName, isToolCallEvent } from "../core/types";
import { OrchestratorState } from "../core";
import { StateManager } from "../context/state-manager";
import { runReadOnlyAgent } from "./subagent-spawner";
import { buildCodeReviewContext } from "../context/context-builder";
import { formatTimeout } from "../settings/time-utils";
import {
    CODE_REVIEW_TOOLS,
    CODE_REVIEW_APPROVE_TOOL,
    CODE_REVIEW_REJECT_TOOL
} from "../tools/code-review-tools";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Spawn the code-review sub-agent and wait for it to complete. */
export async function runCodeReview(
    _pi: ExtensionAPI,
    model: ModelRef
): Promise<{ approved: boolean; feedback?: string }> {
    if (OrchestratorState.shuttingDown) {
        return { approved: false, feedback: "Code review skipped - orchestrator is shutting down." };
    }

    const plan = StateManager.loadPlan();
    if (!plan) {
        return { approved: false, feedback: "No plan exists." };
    }

    // Find all unique created/modified files from all completed tasks
    const files = new Set<string>();
    for (const task of plan.tasks || []) {
        if (task.result?.artifacts) {
            for (const f of task.result.artifacts) {
                files.add(f);
            }
        } else if (task.files) {
            for (const f of task.files) {
                files.add(f);
            }
        }
    }

    const context = buildCodeReviewContext(plan, Array.from(files));

    // Save prompt context to a temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-"));
    const promptPath = path.join(tempDir, "prompt.md");
    fs.writeFileSync(promptPath, context, "utf-8");

    const monitorId = "code-review";
    const toolsArg = `read,ls,find,grep,${CODE_REVIEW_TOOLS}`;
    const args = ["--mode", "json", "--no-session", "--tools", toolsArg, "--append-system-prompt", promptPath];
    args.push("--model", `${model.provider}/${model.id}`);
    args.push("-p", `Perform a code review of the modified/created files and call either orchestrate_code_review_approve or orchestrate_code_review_reject.`);

    const res = await runReadOnlyAgent<"approve" | "reject">({
        taggedId: "code-reviewer-subagent",
        args,
        label: "code-review",
        timeoutMs: OrchestratorState.validatorTimeoutMs,
        taskId: monitorId,
        captureAssistantText: true,
        onEvent: (event) => {
            if (isToolCallEvent(event)) {
                const toolName = getEventToolName(event);
                if (toolName === CODE_REVIEW_APPROVE_TOOL) return "approve";
                if (toolName === CODE_REVIEW_REJECT_TOOL) return "reject";
            }
            return null;
        }
    });

    // Clean up prompt file and directory
    try {
        if (fs.existsSync(promptPath)) {
            fs.unlinkSync(promptPath);
        }
        if (fs.existsSync(tempDir)) {
            fs.rmdirSync(tempDir);
        }
    } catch { /* ignore */ }

    if (res.resolved) {
        if (res.value === "approve") {
            return { approved: true };
        } else {
            return { approved: false, feedback: res.lastAssistantText };
        }
    }

    if (res.killedByWatchdog === "idle_timeout") {
        return { approved: false, feedback: `Code review idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)}.` };
    }
    if (res.killedByWatchdog === "max_turns") {
        return { approved: false, feedback: `Code review exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns}.` };
    }

    if (res.killed) {
        return { approved: false, feedback: "Code review sub-agent timed out." };
    }

    // Fallback to checking code-review.md on disk
    const codeReviewPath = StateManager.getCodeReviewPath();
    if (fs.existsSync(codeReviewPath)) {
        const content = fs.readFileSync(codeReviewPath, "utf-8");
        if (content.startsWith("APPROVED")) {
            return { approved: true };
        }
        return { approved: false, feedback: "Changes needed according to code review." };
    }

    return { approved: false, feedback: "Code review sub-agent exited without providing a verdict." };
}
