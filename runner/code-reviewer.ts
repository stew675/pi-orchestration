import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "../core/types";
import { tryParseSubAgentEvent, getEventToolName } from "../core/types";
import { OrchestratorState } from "../core";
import { StateManager } from "../context/state-manager";
import * as monitor from "../process/monitor";
import { spawnAgent } from "../process/process-manager";
import { buildCodeReviewContext } from "../context/context-builder";
import { formatTimeout } from "../settings/time-utils";
import {
    CODE_REVIEW_TOOLS,
    CODE_REVIEW_APPROVE_TOOL,
    CODE_REVIEW_REJECT_TOOL
} from "../tools/code-review-tools";
import * as fs from "fs";

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

    // Save prompt context to a temporary file in plans directory
    const promptPath = StateManager.getCodeReviewPath().replace(".md", ".prompt.md");
    StateManager.initDirs();
    fs.writeFileSync(promptPath, context, "utf-8");

    const monitorId = "code-review";

    return await new Promise((resolve) => {
        const toolsArg = `read,ls,find,grep,${CODE_REVIEW_TOOLS}`;

        const args = ["--mode", "json", "--no-session", "--tools", toolsArg, "--append-system-prompt", promptPath];
        args.push("--model", `${model.provider}/${model.id}`);
        args.push("-p", `Perform a code review of the modified/created files and call either orchestrate_code_review_approve or orchestrate_code_review_reject.`);

        let verdict: "approve" | "reject" | null = null;
        let lastAssistantText: string | undefined;

        const { child, clearTimeout } = spawnAgent(
            args,
            {
                // Use validatorTimeoutMs as a reasonable default for code reviews
                timeoutMs: OrchestratorState.validatorTimeoutMs,
                label: "code-review",
                taskId: monitorId
            },
            (line) => {
                // Feed to monitor with skipActive: true so it tracks metrics without hijacking status TUI
                monitor.ingestLine(monitorId, line, { skipActive: true });

                const event = tryParseSubAgentEvent(line);
                if (!event) return;

                if (verdict === null && (event.type === "tool_call" || event.type === "tool_execution_start")) {
                    const toolName = getEventToolName(event);
                    if (toolName === CODE_REVIEW_APPROVE_TOOL) {
                        verdict = "approve";
                    } else if (toolName === CODE_REVIEW_REJECT_TOOL) {
                        verdict = "reject";
                    }
                }

                if (event.type === "message_end" && event.message?.role === "assistant") {
                    for (const part of event.message.content || []) {
                        const partObj = part as Record<string, unknown>;
                        if (partObj.type === "text") {
                            lastAssistantText = String(partObj.text).trim();
                        }
                    }
                }
            }
        );

        // Register with the monitor
        const taggedId = `code-reviewer-subagent`;
        monitor.registerAgent(taggedId, child);

        child.on("close", () => {
            clearTimeout();

            // Clean up prompt file
            try {
                if (fs.existsSync(promptPath)) {
                    fs.unlinkSync(promptPath);
                }
            } catch { /* ignore */ }

            if (verdict === "approve") {
                resolve({ approved: true });
                return;
            }
            if (verdict === "reject") {
                resolve({ approved: false, feedback: lastAssistantText });
                return;
            }

            // Check watchdog killed reason
            const monState = monitor.getMonitoredAgent(taggedId);
            const killReason = monState?.killedByWatchdog ?? null;

            if (killReason === "idle_timeout") {
                resolve({ approved: false, feedback: `Code review idle timeout — no JSON stream activity for ${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)}.` });
                return;
            }
            if (killReason === "max_turns") {
                resolve({ approved: false, feedback: `Code review exceeded max turns limit of ${OrchestratorState.subAgentMaxTurns}.` });
                return;
            }

            if (child.killed) {
                resolve({ approved: false, feedback: "Code review sub-agent timed out." });
                return;
            }

            // Fallback to checking code-review.md on disk
            const codeReviewPath = StateManager.getCodeReviewPath();
            if (fs.existsSync(codeReviewPath)) {
                const content = fs.readFileSync(codeReviewPath, "utf-8");
                if (content.startsWith("APPROVED")) {
                    resolve({ approved: true });
                    return;
                }
                resolve({ approved: false, feedback: "Changes needed according to code review." });
                return;
            }

            resolve({ approved: false, feedback: "Code review sub-agent exited without providing a verdict." });
        });

        child.on("error", (err) => {
            clearTimeout();
            try {
                if (fs.existsSync(promptPath)) {
                    fs.unlinkSync(promptPath);
                }
            } catch { /* ignore */ }
            resolve({ approved: false, feedback: `Code review process error: ${err.message}` });
        });
    });
}
