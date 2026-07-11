import { Container, type Focusable, Input, Text } from "@earendil-works/pi-tui";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// AcceptOrEditDialog — hybrid selection + text input overlay.
//
// Renders two options:
//   [1] ✓ Accept (highlighted by default)
//   [2] ✎ Type your changes here...
//
// List mode:  ↑/↓ navigate, Enter on option 1 → accept, ↓ switches to edit mode
// Edit mode:  freeform typing in Input child, Enter → submit feedback, ↑ returns to list
// Escape     : always cancels (drops back to normal TUI command line)
// ---------------------------------------------------------------------------

export interface AcceptOrEditResult {
    accepted?: boolean; // true = user pressed Enter on option 1
    cancelled?: boolean; // true = user pressed Escape
    feedback?: string; // non-empty when user typed changes in edit mode
}

type Mode = "list" | "edit";

export class AcceptOrEditDialog extends Container implements Focusable {
    private mode: Mode = "list";
    private selectedIndex = 0; // 0 = Accept, 1 = Type changes
    private input: Input;
    private _focused = false;

    /** Theme callbacks (captured at construction time). */
    private fg: (color: string, text: string) => string;

    /** Resolved via done() callback. */
    public onDone?: (result: AcceptOrEditResult) => void;

    private enterEditMode() {
        this.mode = "edit";
        this.input.setValue("");
    }

    private returnToListMode() {
        this.mode = "list";
        this.selectedIndex = 1;
        this.invalidate();
    }

    constructor(fg: (color: string, text: string) => string) {
        super();
        this.fg = fg;
        this.input = new Input();
        this.input.onSubmit = () => {
            const value = this.input.getValue().trim();
            if (value.length > 0 && this.onDone) {
                this.onDone({ feedback: value });
            } else if (!value.length && this.onDone) {
                // Empty submit in edit mode — treat as accept with no changes
                this.onDone({ accepted: true });
            }
        };
        this.input.onEscape = () => {
            if (this.mode === "edit") {
                this.returnToListMode();
            } else if (this.onDone) {
                this.onDone({ cancelled: true });
            }
        };

        this.addChild(new Text("", 0, 0)); // placeholder, rebuilt on render
    }

    /** Focusable interface — propagate to input child for IME cursor positioning. */
    get focused(): boolean {
        return this._focused;
    }
    set focused(value: boolean) {
        this._focused = value;
        if (this.mode === "edit") {
            this.input.focused = value;
        }
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            if (this.onDone) {
                this.onDone({ cancelled: true });
            }
            return;
        }

        if (this.mode === "edit") {
            // Forward all input to the child Input component.
            // But intercept ↑ to return to list mode.
            if (matchesKey(data, Key.up)) {
                this.returnToListMode();
                return;
            }
            this.input.handleInput(data);
            this.invalidate();
        } else {
            // List mode navigation
            if (matchesKey(data, Key.down) && this.selectedIndex < 1) {
                this.selectedIndex++;
                if (this.selectedIndex === 1) {
                    // Switch to edit mode immediately on navigating to option 2
                    this.enterEditMode();
                }
            } else if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
                this.selectedIndex--;
            } else if (matchesKey(data, Key.enter)) {
                if (this.selectedIndex === 0) {
                    // Option 1 — Accept
                    if (this.onDone) this.onDone({ accepted: true });
                } else if (this.selectedIndex === 1) {
                    // Option 2 selected via Enter — switch to edit mode
                    this.enterEditMode();
                }
            }
            this.invalidate();
        }
    }

    render(width: number): string[] {
        const lines: string[] = [];

        if (this.mode === "list") {
            // Option 1 — Accept
            const acceptLine = this.selectedIndex === 0 ? "> ✓ Accept" : "  ✓ Accept";
            lines.push(this.fg("success", truncateToWidth(acceptLine, width)));

            // Option 2 — Type changes
            const editLabel =
                this.selectedIndex === 1 ? "> ✎ Type your changes here..." : "  ✎ Type your changes here...";
            lines.push(this.fg("dim", truncateToWidth(editLabel, width)));
        } else {
            // Edit mode — show the two options dimmed + active input line
            lines.push(this.fg("success", "  ✓ Accept"));
            lines.push(this.fg("accent", "> ✎ Type your changes here..."));

            // Render the Input component and prepend it with a prompt indicator
            const inputLines = this.input.render(width - 2);
            for (const line of inputLines) {
                lines.push(" " + line);
            }
        }

        return lines;
    }

    invalidate(): void {
        super.invalidate();
        if (this.mode === "edit") {
            this.input.invalidate();
        }
    }
}
