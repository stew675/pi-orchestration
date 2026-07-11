import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** Data stored in an orchestration status entry. */
interface OrchestratorStatusEntry {
    /** Short label for the event (e.g., "Task failed", "Paused"). */
    title: string;
    /** Full message text shown when expanded or inline. */
    message: string;
    /** Timestamp in ms since epoch. */
    timestamp: number;
}

/**
 * Register an entry renderer for orchestration status events and a helper
 * to append them without polluting the LLM context window.
 *
 * Unlike pi.sendMessage() which adds messages to conversation history (consuming
 * tokens), these entries are TUI-only — they appear in the transcript as styled
 * status cards but never reach the model's context. This keeps token usage lean
 * on long plans with 20+ tasks where dozens of notifications accumulate.
 */
export function setupOrchestratorStatusRenderer(pi: ExtensionAPI): void {
    pi.registerEntryRenderer<OrchestratorStatusEntry>("orchestration-status", (entry, _opts, theme) => {
        const data = entry.data ?? { title: "Unknown", message: "", timestamp: Date.now() };

        // Compact single-line display for the status card.
        const box = new Box(1, 1);
        const prefix = theme.fg("accent", "[orchestration]");
        const label = theme.fg("text", ` ${data.title}`);
        box.addChild(new Text(prefix + label, 0, 0));

        // Full message on second line (always shown for status entries).
        if (data.message) {
            const msgLine = new Text(theme.fg("dim", data.message), 0, 1);
            box.addChild(msgLine);
        }

        return box;
    });
}
