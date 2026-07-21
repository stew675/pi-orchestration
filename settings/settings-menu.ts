import { Container, Input, SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    OrchestratorState,
    formatModel,
    setSummarizationConcurrency,
    setParallelTasks,
    setTimeoutMs,
    setSubAgentMaxTurns,
    setVerifyingOrchestratorMaxTurns,
    setBooleanSetting
} from "../core";
import { isActive as stateIsActive, isPlanningMode } from "../core/state-machine";
import { persistSettings, resetToDefaults } from "./settings";
import { createModelPicker } from "../ui/model-picker";
import { parseTimeout, formatTimeout, formatTimeoutCompact } from "./time-utils";
import { getKeybindings } from "@earendil-works/pi-tui";
import { notifyTuiOnly } from "../runner/utils";

// ---------------------------------------------------------------------------
// Shared submenu builder — standard Container → Border → Title → SelectList layout
// ---------------------------------------------------------------------------

function buildSubmenu(
    ctx: ExtensionContext,
    title: string,
    items: SelectItem[],
    helpText: string,
    initialIndex: number = 0
): Promise<string | null> {
    return ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

            const selectList = new SelectList(items, Math.min(items.length, 18), {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => theme.fg("accent", t),
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t)
            });
            selectList.setSelectedIndex(initialIndex);
            selectList.onSelect = (item) => done(item.value);
            selectList.onCancel = () => done(null);
            container.addChild(selectList);
            container.addChild(new Text(theme.fg("dim", helpText), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    selectList.handleInput(data);
                    tui.requestRender();
                }
            };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "60%", margin: 1 } }
    );
}


/** Mapping of model scope identifiers to their OrchestratorState property keys and display labels. */
const MODEL_SCOPES: Record<
    string,
    {
        key: keyof Pick<
            typeof OrchestratorState,
            | "orchestrationModel"
            | "planningModel"
            | "simpleTaskModel"
            | "complexTaskModel"
            | "validatorModel"
            | "summaryModel"
            | "reviewerModel"
            | "codeReviewModel"
        >;
        label: string;
    }
> = {
    orchestration: { key: "orchestrationModel", label: "Orchestration model" },
    planning: { key: "planningModel", label: "Planning model" },
    simpleTask: { key: "simpleTaskModel", label: "Simple task model" },
    complexTask: { key: "complexTaskModel", label: "Complex task model" },
    validator: { key: "validatorModel", label: "Validator model" },
    summary: { key: "summaryModel", label: "Summary model" },
    reviewer: { key: "reviewerModel", label: "Plan review model" },
    codeReview: { key: "codeReviewModel", label: "Code review model" }
};

/**
 * Open the orchestration settings overlay.
 *
 * Presents a menu of configurable options:
 *   - Orchestration model (opens model picker) - main model used during orchestration
 *   - Planning model (opens model picker) - model used while building/editing plans
 *   - Task model (opens model picker)
 *   - Validator model (opens model picker)
 *   - Summarization concurrency (number input)
 *   - Reset models to defaults
 *
 * Escape closes without changes.  Enter on an item dispatches the handler.
 */
export async function openSettingsMenu(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(
            `Orchestration settings:\n` +
                `  Orchestration:         ${formatModel(OrchestratorState.orchestrationModel)}\n` +
                `  Planning:              ${formatModel(OrchestratorState.planningModel)}\n` +
                `  Simple task model:     ${formatModel(OrchestratorState.simpleTaskModel)}\n` +
                `  Complex task model:    ${formatModel(OrchestratorState.complexTaskModel)}\n` +
                `  Validator:             ${formatModel(OrchestratorState.validatorModel)}\n` +
                `  Summary:               ${formatModel(OrchestratorState.summaryModel)}\n` +
                `  Reviewer:              ${formatModel(OrchestratorState.reviewerModel) || "(disabled)"}\n` +
                `  Code Review:           ${formatModel(OrchestratorState.codeReviewModel) || "(disabled)"}\n` +
                `  Summary concurrency:   ${OrchestratorState.summarizationConcurrency}\n` +
                `  Parallel tasks:        ${OrchestratorState.parallelTasks}\n` +
                `  Task timeout:          ${formatTimeout(OrchestratorState.taskTimeoutMs)}\n` +
                `  Validator timeout:     ${formatTimeout(OrchestratorState.validatorTimeoutMs)}\n` +
                `  Task summary timeout:  ${formatTimeout(OrchestratorState.taskSummaryTimeoutMs)}\n` +
                `  Sub-agent idle timeout:${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)}\n` +
                `  Sub-agent max turns:   ${OrchestratorState.subAgentMaxTurns}\n` +
                `  Verifying turn limit:  ${OrchestratorState.verifyingOrchestratorMaxTurns === 0 ? "unlimited" : OrchestratorState.verifyingOrchestratorMaxTurns}\n` +
                `  Allow stop tool:       ${OrchestratorState.allowStopTool ? "enabled" : "disabled"}\n` +
                `  Validate simple tasks: ${OrchestratorState.validateSimpleTasks ? "enabled" : "disabled"}\n` +
                `  Validate complex tasks: ${OrchestratorState.validateComplexTasks ? "enabled" : "disabled"}\n` +
                `  Debug transitions:     ${OrchestratorState.debugLogTransitions ? "enabled" : "disabled"}\n\n` +
                `Use /om-settings in TUI mode for interactive configuration, or:\n` +
                `  /om-settings orchestration <provider/model>\n` +
                `  /om-settings planning <provider/model>\n` +
                `  /om-settings simple-task <provider/model>\n` +
                `  /om-settings complex-task <provider/model>\n` +
                `  /om-settings validator <provider/model>\n` +
                `  /om-settings summary <provider/model>\n` +
                `  /om-settings code-review <provider/model>\n` +
                `  /om-settings default`,
            "info"
        );
        return;
    }



    // --- Top-level menu (category level) ---
    const showTopMenu = (initialIndex: number = 0) => {
        const topItems: SelectItem[] = [
            { value: "models", label: "Models" },
            { value: "execution", label: "Execution" },
            { value: "behavior", label: "Behavior" }
        ];
        return buildSubmenu(ctx, "Orchestration Settings", topItems, "↑↓ navigate • enter select • esc cancel", initialIndex);
    };

    // --- Models sub-menu ---
    function buildModelItems(): SelectItem[] {
        return [
            { value: "orchestration-model", label: `Orchestration model (${formatModel(OrchestratorState.orchestrationModel)})` },
            { value: "planning-model", label: `Planning model (${formatModel(OrchestratorState.planningModel)})` },
            { value: "reviewer-model", label: `Plan review model (${formatModel(OrchestratorState.reviewerModel) || "(disabled)"})` },
            { value: "simple-task-model", label: `Simple task model (${formatModel(OrchestratorState.simpleTaskModel)})` },
            { value: "complex-task-model", label: `Complex task model (${formatModel(OrchestratorState.complexTaskModel)})` },
            { value: "summary-model", label: `Summary model (${formatModel(OrchestratorState.summaryModel)})` },
            { value: "code-review-model", label: `Code review model (${formatModel(OrchestratorState.codeReviewModel) || "(disabled)"})` },
            { value: "validator-model", label: `Validator model (${formatModel(OrchestratorState.validatorModel)})` },
            { value: "reset-defaults", label: "Reset models to defaults" }
        ];
    }

    const showModelsMenu = (initialIndex: number = 0) => buildSubmenu(ctx, "Models", buildModelItems(), "↑↓ navigate • enter select • esc back", initialIndex);

    // --- Execution sub-menu ---
    function buildExecutionItems(): SelectItem[] {
        return [
            { value: "summarization-concurrency", label: `Summarization concurrency (${OrchestratorState.summarizationConcurrency})` },
            { value: "parallel-tasks", label: `Parallel tasks (${OrchestratorState.parallelTasks})` },
            { value: "timeout-task", label: `Task timeout (${formatTimeout(OrchestratorState.taskTimeoutMs)})` },
            { value: "timeout-validator", label: `Validator timeout (${formatTimeout(OrchestratorState.validatorTimeoutMs)})` },
            { value: "timeout-task-summary", label: `Task summary timeout (${formatTimeout(OrchestratorState.taskSummaryTimeoutMs)})` },
            { value: "timeout-sub-agent-idle", label: `Sub-agent idle timeout (${formatTimeout(OrchestratorState.subAgentIdleTimeoutMs)})` },
            { value: "max-turns", label: `Sub-agent max turns (${OrchestratorState.subAgentMaxTurns === 0 ? "unlimited" : OrchestratorState.subAgentMaxTurns})` },
            { value: "verifying-max-turns", label: `Verifying turn limit (${OrchestratorState.verifyingOrchestratorMaxTurns === 0 ? "unlimited" : OrchestratorState.verifyingOrchestratorMaxTurns})` }
        ];
    }

    const showExecutionMenu = (initialIndex: number = 0) => buildSubmenu(ctx, "Execution", buildExecutionItems(), "↑↓ navigate • enter select • esc back", initialIndex);

    // --- Behavior sub-menu ---
    function buildBehaviorItems(): SelectItem[] {
        return [
            { value: "allow-stop-tool", label: `Allow orchestrate_stop (${OrchestratorState.allowStopTool ? "enabled" : "disabled"})` },
            { value: "validate-simple-tasks", label: `Validate simple tasks (${OrchestratorState.validateSimpleTasks ? "enabled" : "disabled"})` },
            { value: "validate-complex-tasks", label: `Validate complex tasks (${OrchestratorState.validateComplexTasks ? "enabled" : "disabled"})` },
            { value: "debug-log-transitions", label: `Debug state transitions (${OrchestratorState.debugLogTransitions ? "enabled" : "disabled"})` }
        ];
    }

    const showBehaviorMenu = (initialIndex: number = 0) => buildSubmenu(ctx, "Behavior", buildBehaviorItems(), "↑↓ navigate • enter toggle • esc back", initialIndex);

    // Build a strategy map for menu dispatch.
    const choiceHandlers: Record<string, () => Promise<void>> = {
        "orchestration-model": () => handleModelSelection(ctx, pi, "orchestration"),
        "planning-model": () => handleModelSelection(ctx, pi, "planning"),
        "simple-task-model": () => handleModelSelection(ctx, pi, "simpleTask"),
        "complex-task-model": () => handleModelSelection(ctx, pi, "complexTask"),
        "validator-model": () => handleModelSelection(ctx, pi, "validator"),
        "summary-model": () => handleModelSelection(ctx, pi, "summary"),
        "reviewer-model": () => handleReviewerModelSelection(ctx, pi),
        "code-review-model": () => handleCodeReviewModelSelection(ctx, pi),
        "summarization-concurrency": async () => {
            await handleNumberInput(
                ctx,
                "Summarization concurrency",
                OrchestratorState.summarizationConcurrency,
                0,
                (val) => {
                    setSummarizationConcurrency(val);
                    persistSettings(OrchestratorState);
                }
            );
        },
        "parallel-tasks": async () => {
            await handleNumberInput(ctx, "Parallel tasks", OrchestratorState.parallelTasks, 1, (val) => {
                setParallelTasks(val);
                persistSettings(OrchestratorState);
            });
        },
        "timeout-task": () => handleTimeoutInput(ctx, "task", OrchestratorState.taskTimeoutMs),
        "timeout-validator": () => handleTimeoutInput(ctx, "validator", OrchestratorState.validatorTimeoutMs),
        "timeout-task-summary": () => handleTimeoutInput(ctx, "taskSummary", OrchestratorState.taskSummaryTimeoutMs),
        "timeout-sub-agent-idle": () => handleSubAgentIdleTimeoutInput(ctx),
        "max-turns": async () => {
            await handleNumberInput(ctx, "Sub-agent max turns", OrchestratorState.subAgentMaxTurns, 0, (val) => {
                setSubAgentMaxTurns(val);
                persistSettings(OrchestratorState);
            });
        },
        "verifying-max-turns": async () => {
            await handleNumberInput(ctx, "Verifying turn limit", OrchestratorState.verifyingOrchestratorMaxTurns, 0, (val) => {
                setVerifyingOrchestratorMaxTurns(val);
                persistSettings(OrchestratorState);
            });
        },
        "allow-stop-tool": async () => {
            toggleBooleanSetting(
                ctx,
                () => OrchestratorState.allowStopTool,
                (v) => setBooleanSetting("allowStopTool", v),
                (v) =>
                    `orchestrate_stop ${v ? "enabled" : "disabled"}. ${
                        v
                            ? "The orchestrator can halt execution via orchestrate_stop."
                            : "When called, the tool returns a nudge message instead of stopping."
                    }`
            );
        },
        "validate-simple-tasks": async () => {
            toggleBooleanSetting(
                ctx,
                () => OrchestratorState.validateSimpleTasks,
                (v) => setBooleanSetting("validateSimpleTasks", v),
                (v) => `Validation for simple tasks ${v ? "enabled" : "disabled"}.`
            );
        },
        "validate-complex-tasks": async () => {
            toggleBooleanSetting(
                ctx,
                () => OrchestratorState.validateComplexTasks,
                (v) => setBooleanSetting("validateComplexTasks", v),
                (v) => `Validation for complex tasks ${v ? "enabled" : "disabled"}.`
            );
        },
        "debug-log-transitions": async () => {
            toggleBooleanSetting(
                ctx,
                () => OrchestratorState.debugLogTransitions,
                (v) => setBooleanSetting("debugLogTransitions", v),
                (v) => `Debug state transition logging ${v ? "enabled" : "disabled"}.`
            );
        },
        "reset-defaults": async () => {
            resetToDefaults(OrchestratorState);
            persistSettings(OrchestratorState);
            ctx.ui.notify(
                `Models reset to defaults.\n` +
                    `  Orchestration: ${formatModel(OrchestratorState.orchestrationModel)}\n` +
                    `  Planning:      ${formatModel(OrchestratorState.planningModel)}\n` +
                    `  Simple tasks:  ${formatModel(OrchestratorState.simpleTaskModel)}\n` +
                    `  Complex tasks: ${formatModel(OrchestratorState.complexTaskModel)}\n` +
                    `  Validators:    ${formatModel(OrchestratorState.validatorModel)}\n` +
                    `  Summaries:     ${formatModel(OrchestratorState.summaryModel)}`,
                "info"
            );
        }
    };

    // Main loop: top-level menu → sub-menu or action → back to top.
    // Track last-selected value per sub-menu so the cursor stays on the changed item.
    let lastModelChoice: string | null = null;
    let lastExecChoice: string | null = null;
    let lastBehavChoice: string | null = null;

    // Top-level category index map (matches topItems order).
    const TOP_INDEX: Record<string, number> = { models: 0, execution: 1, behavior: 2 };
    let lastTopCategory: string | null = null; // remember which category to restore cursor on

    while (true) {
        const prevTopIndex = lastTopCategory != null ? TOP_INDEX[lastTopCategory] ?? 0 : 0;
        if (prevTopIndex > 0) lastTopCategory = null; // consumed
        const topChoice = await showTopMenu(prevTopIndex);
        if (!topChoice) return; // escape - done

        // Category navigation — enter a sub-menu, then return here after each action.
        if (topChoice === "models") {
            lastTopCategory = "models";
            while (true) {
                const prevIndex = lastModelChoice != null
                    ? buildModelItems().findIndex(i => i.value === lastModelChoice)
                    : 0;
                if (prevIndex > 0) lastModelChoice = null; // consumed

                const modelChoice = await showModelsMenu(prevIndex);
                if (!modelChoice) break; // esc back to top menu
                lastModelChoice = modelChoice; // remember for next rebuild
                const handler = choiceHandlers[modelChoice];
                if (handler) await handler();
            }
        } else if (topChoice === "execution") {
            lastTopCategory = "execution";
            while (true) {
                const prevIndex = lastExecChoice != null
                    ? buildExecutionItems().findIndex(i => i.value === lastExecChoice)
                    : 0;
                if (prevIndex > 0) lastExecChoice = null; // consumed

                const execChoice = await showExecutionMenu(prevIndex);
                if (!execChoice) break; // esc back to top menu
                lastExecChoice = execChoice; // remember for next rebuild
                const handler = choiceHandlers[execChoice];
                if (handler) await handler();
            }
        } else if (topChoice === "behavior") {
            lastTopCategory = "behavior";
            while (true) {
                const prevIndex = lastBehavChoice != null
                    ? buildBehaviorItems().findIndex(i => i.value === lastBehavChoice)
                    : 0;
                if (prevIndex > 0) lastBehavChoice = null; // consumed

                const behavChoice = await showBehaviorMenu(prevIndex);
                if (!behavChoice) break; // esc back to top menu
                lastBehavChoice = behavChoice; // remember for next rebuild
                const handler = choiceHandlers[behavChoice];
                if (handler) await handler();
            }
        }
    }
}

/**
 * Open the model picker for a specific scope and save the result.
 */
interface ModelItem {
    provider: string;
    id: string;
    model: any;
}
async function handleModelSelection(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    scope: keyof typeof MODEL_SCOPES
): Promise<void> {
    const scopeInfo = MODEL_SCOPES[scope];
    if (!scopeInfo) throw new Error(`Unknown model scope: ${scope}`);

    try {
        const availableModels = await ctx.modelRegistry.getAvailable();
        if (availableModels.length === 0) {
            ctx.ui.notify("No models available. Check your provider configuration.", "error");
            return;
        }

        // Read current model from state using the mapping
        const currentModel = OrchestratorState[scopeInfo.key] || undefined;

        const items: ModelItem[] = availableModels.map((m) => ({ provider: m.provider, id: m.id, model: m }));

        const selected = await ctx.ui.custom<ModelItem | null>(
            (tui, theme, _keybindings, done) =>
                createModelPicker(tui, theme, (r: any) => done(r as ModelItem | null), items, currentModel),
            { overlay: true }
        );

        if (selected && selected.provider && selected.id) {
            // Write selected model using the mapping
            OrchestratorState[scopeInfo.key] = { provider: selected.provider, id: selected.id };
            persistSettings(OrchestratorState);

            const label = scopeInfo.label;

            if (stateIsActive(OrchestratorState.currentState) && (scope === "orchestration" || scope === "planning")) {
                // Only live-switch when the selected scope matches the current active mode:
                //   planning model → while in planning mode
                //   orchestration model → while NOT in planning mode (idle or executing)
                const shouldLiveSwitch =
                    (scope === "planning" && isPlanningMode(OrchestratorState.currentState)) ||
                    (scope === "orchestration" && !isPlanningMode(OrchestratorState.currentState));

                if (shouldLiveSwitch) {
                    const liveModel =
                        scope === "planning" ? OrchestratorState.planningModel : OrchestratorState.orchestrationModel;
                    if (liveModel) {
                        const targetModel = ctx.modelRegistry.find(liveModel.provider, liveModel.id);
                        if (!targetModel) {
                            ctx.ui.notify(
                                `${label} set to ${selected.provider}/${selected.id}. (Not found in registry - will apply next session.)`,
                                "warning"
                            );
                            return;
                        }
                        const success = await pi.setModel(targetModel);
                        if (!success) {
                            ctx.ui.notify(
                                `Cannot switch to ${label.toLowerCase()} ${liveModel.provider}/${liveModel.id} - no configured API key.`,
                                "warning"
                            );
                            return;
                        }
                    }
                }
            }

            ctx.ui.notify(`${label} set to ${selected.provider}/${selected.id}.`, "info");
        }
    } catch (err) {
        notifyTuiOnly(OrchestratorState.pi, "Model picker error: " + String(err));
        ctx.ui.notify(`Error opening model picker: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
}

/** Shared picker for optional model scopes (reviewer, code-review) that includes a "(None)" sentinel. */
interface OptionalPickerItem {
    none?: boolean;
    provider?: string;
    id?: string;
}

async function pickOptionalModel(
    ctx: ExtensionContext,
    title: string,
    currentLabel: () => string,
    _getter: () => { provider: string; id: string } | null,
    setter: (val: { provider: string; id: string } | null) => void,
    disabledMsg: string,
    setMsgTemplate: (providerId: string) => string
): Promise<void> {
    try {
        const availableModels = await ctx.modelRegistry.getAvailable();
        if (availableModels.length === 0) {
            setter(null);
            persistSettings(OrchestratorState);
            ctx.ui.notify(disabledMsg, "info");
            return;
        }

        const items: OptionalPickerItem[] = [
            { none: true },
            ...availableModels.map((m) => ({ provider: m.provider, id: m.id }))
        ];

        const selected = await ctx.ui.custom<OptionalPickerItem | null>(
            (tui, theme, _keybindings, done) => {
                const container = new Container();
                container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
                container.addChild(new Text(
                    theme.fg("muted", `Current: ${currentLabel()}`),
                    1, 0
                ));

                const displayItems: SelectItem[] = items.map((item, index) => {
                    if (item.none) {
                        return { value: String(index), label: "(None) — disable" };
                    }
                    return { value: String(index), label: `${item.provider}/${item.id}` };
                });

                const selectList = new SelectList(displayItems, Math.min(displayItems.length, 18), {
                    selectedPrefix: (t) => theme.fg("accent", t),
                    selectedText: (t) => theme.fg("accent", t),
                    description: (t) => theme.fg("muted", t),
                    scrollInfo: (t) => theme.fg("dim", t),
                    noMatch: (t) => theme.fg("warning", t)
                });

                selectList.onSelect = (item) => {
                    const idx = parseInt(item.value, 10);
                    done(items[idx] || null);
                };
                selectList.onCancel = () => done(null);

                container.addChild(selectList);
                container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
                container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

                return {
                    render: (w) => container.render(w),
                    invalidate: () => container.invalidate(),
                    handleInput: (data) => {
                        selectList.handleInput(data);
                        tui.requestRender();
                    }
                };
            },
            { overlay: true, overlayOptions: { anchor: "center", width: "60%", margin: 2 } }
        );

        if (!selected) return; // cancelled

        if (selected.none) {
            setter(null);
            persistSettings(OrchestratorState);
            ctx.ui.notify(disabledMsg, "info");
        } else if (selected.provider && selected.id) {
            setter({ provider: selected.provider, id: selected.id });
            persistSettings(OrchestratorState);
            ctx.ui.notify(setMsgTemplate(`${selected.provider}/${selected.id}`), "info");
        }
    } catch (err) {
        notifyTuiOnly(OrchestratorState.pi, `${title} picker error: ` + String(err));
        ctx.ui.notify(`Error opening ${title.toLowerCase()} picker: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
}

async function handleReviewerModelSelection(
    ctx: ExtensionContext,
    _pi: ExtensionAPI
): Promise<void> {
    return pickOptionalModel(
        ctx,
        "Select Plan Review Model",
        () => formatModel(OrchestratorState.reviewerModel) || "(disabled)",
        () => OrchestratorState.reviewerModel,
        (v) => { OrchestratorState.reviewerModel = v; },
        "Plan review disabled.",
        (pid) => `Plan review model set to ${pid}.`
);
}

/**
 * Shared helper to render a text input dialog with common container setup.
 */
async function showTextInputDialog(
    ctx: ExtensionContext,
    title: string,
    currentHint: string,
    helpLines: string[],
    defaultInput: string
): Promise<string | null> {
    return await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) => {
            const container = new Container();

            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(theme.fg("accent", theme.bold(`Set ${title}`)), 1, 0));
            container.addChild(new Text(theme.fg("muted", `${currentHint}\n`), 1, 0));
            for (const line of helpLines) {
                container.addChild(new Text(theme.fg("dim", line), 1, 0));
            }

            const input = new Input();
            for (const ch of defaultInput) {
                input.handleInput(ch);
            }
            container.addChild(input);

            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", "enter confirm  esc cancel"), 0, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

            input.onSubmit = () => {
                const val = input.getValue().trim();
                done(val || null);
            };

            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
                    const kb = getKeybindings();
                    if (kb.matches(data, "tui.select.cancel")) {
                        done(null);
                    } else if (kb.matches(data, "tui.select.confirm")) {
                        input.onSubmit?.(input.getValue());
                    } else {
                        input.handleInput(data);
                        tui.requestRender();
                    }
                }
            };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "60%", margin: 2 } }
    );
}

/** Toggle a boolean setting on OrchestratorState and notify the user. */
function toggleBooleanSetting(
    ctx: ExtensionContext,
    getter: () => boolean,
    setter: (v: boolean) => void,
    notificationMsg: (newVal: boolean) => string
): void {
    const newVal = !getter();
    setter(newVal);
    persistSettings(OrchestratorState);
    ctx.ui.notify(notificationMsg(newVal), "info");
}

/**
 * Open a text input dialog for editing a numeric value.
 */
async function handleNumberInput(
    ctx: ExtensionContext,
    label: string,
    currentValue: number,
    minValue: number = 1,
    onSave: (val: number) => void
): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(`Setting ${label} interactively is only supported in TUI mode.`, "info");
        return;
    }

    const currentStr = currentValue.toString();
    const result = await showTextInputDialog(
        ctx,
        label,
        `Current: ${currentStr}`,
        [`Enter an integer value >= ${minValue}\n`],
        currentStr
    );

    if (result === null || result.trim() === "") return;

    const parsed = parseInt(result, 10);
    if (isNaN(parsed) || parsed < minValue) {
        ctx.ui.notify(`Invalid number: must be an integer >= ${minValue}`, "error");
        return;
    }
    onSave(parsed);
    ctx.ui.notify(`${label} set to ${parsed}.`, "info");
}

/**
 * Open a text input dialog for editing a timeout value.
 */
async function handleTimeoutInput(
    ctx: ExtensionContext,
    scope: "task" | "validator" | "taskSummary",
    currentValueMs: number
): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(
            `Set timeout via: /om-settings ${scope} <time>\n` +
                `  e.g. "/om-settings task 15m" or "/om-settings validator 2m30s"`,
            "info"
        );
        return;
    }

    const currentStr = formatTimeout(currentValueMs);
    const label = getTimeoutLabel(scope);

    const result = await showTextInputDialog(
        ctx,
        label,
        `Current: ${currentStr}`,
        ['Formats: "30s" | "5m" | "2m30s" | "0" (no timeout)\n'],
        currentValueMs === 0 ? "0" : formatTimeoutCompact(currentValueMs)
    );

    if (result === null || result.trim() === "") return; // cancelled or empty

    try {
        const ms = parseTimeout(result);

        // Apply to state
        const timeoutKeyMap: Record<string, "taskTimeoutMs" | "validatorTimeoutMs" | "taskSummaryTimeoutMs"> = {
            task: "taskTimeoutMs",
            validator: "validatorTimeoutMs",
            taskSummary: "taskSummaryTimeoutMs"
        };
        setTimeoutMs(timeoutKeyMap[scope], ms);

        persistSettings(OrchestratorState);
        ctx.ui.notify(`${label} set to ${formatTimeout(ms)}.`, "info");
    } catch (err) {
        ctx.ui.notify(`Invalid timeout: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
}



/** Human-readable label for a timeout scope. */
function getTimeoutLabel(scope: "task" | "validator" | "taskSummary"): string {
    switch (scope) {
        case "task":
            return "Task timeout";
        case "validator":
            return "Validator timeout";
        case "taskSummary":
            return "Task summary timeout";
    }
}

/**
 * Open a text input dialog for editing the global sub-agent idle timeout.
 */
async function handleSubAgentIdleTimeoutInput(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(
            `Set idle timeout via: /om-settings sub-agent-idle <time>\n` +
                `  e.g. "/om-settings sub-agent-idle 5m30s"`,
            "info"
        );
        return;
    }

    const currentStr = formatTimeout(OrchestratorState.subAgentIdleTimeoutMs);

    const result = await showTextInputDialog(
        ctx,
        "Sub-agent idle timeout",
        `Current: ${currentStr}`,
        ['Formats: "30s" | "5m" | "2m30s" | "0" (no limit)\n'],
        OrchestratorState.subAgentIdleTimeoutMs === 0 ? "0" : formatTimeoutCompact(OrchestratorState.subAgentIdleTimeoutMs)
    );

    if (result === null || result.trim() === "") return; // cancelled or empty

    try {
        const ms = parseTimeout(result);
        setTimeoutMs("subAgentIdleTimeoutMs", ms);
        persistSettings(OrchestratorState);
        ctx.ui.notify(`Sub-agent idle timeout set to ${formatTimeout(ms)}.`, "info");
    } catch (err) {
        ctx.ui.notify(`Invalid timeout: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
}

/**
 * Open a custom code-review model picker that includes a "(None)" sentinel option.
 */
async function handleCodeReviewModelSelection(
    ctx: ExtensionContext,
    _pi: ExtensionAPI
): Promise<void> {
    return pickOptionalModel(
        ctx,
        "Select Code Review Model",
        () => formatModel(OrchestratorState.codeReviewModel) || "(disabled)",
        () => OrchestratorState.codeReviewModel,
        (v) => { OrchestratorState.codeReviewModel = v; },
        "Code review disabled.",
        (pid) => `Code review model set to ${pid}.`
    );
}

