import { ModelRef } from "../core/types";
/**
 * Lightweight model picker for orchestration sub-agent model selection.
 *
 * Adapted from Pi's internal ModelSelectorComponent — stripped down to avoid
 * the SettingsManager dependency and default-model side effects.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Component,
    fuzzyFilter,
    getKeybindings,
    Input,
    Spacer,
    Text,
    type TUI
} from "@earendil-works/pi-tui";

interface ModelItem {
    provider: string;
    id: string;
    model: Model<any>;
}

function formatKeyText(key: string): string {
    return key
        .split("/")
        .map((k) =>
            k
                .split("+")
                .map((part) => {
                    const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
                    return displayPart.charAt(0).toUpperCase() + displayPart.slice(1);
                })
                .join("+")
        )
        .join("/");
}

function keyDisplayText(keybinding: string): string {
    try {
        // The keybinding string is typically in "scope.name" format.
        // Format it for display by capitalizing parts and handling platform differences.
        return formatKeyText(keybinding);
    } catch {
        return keybinding;
    }
}

/**
 * Factory for ctx.ui.custom() — returns a scrollable, searchable model list.
 */
export function createModelPicker(
    tui: TUI,
    theme: Theme,
    done: (model: Model<any> | null) => void,
    models: ModelItem[],
    currentModel?: ModelRef
): Component {
    let filteredModels = [...models];
    let selectedIndex = 0;

    function sortModels(list: ModelItem[]): ModelItem[] {
        return list.sort((a, b) => {
            const aIsCurrent = currentModel && a.provider === currentModel.provider && a.id === currentModel.id;
            const bIsCurrent = currentModel && b.provider === currentModel.provider && b.id === currentModel.id;
            if (aIsCurrent && !bIsCurrent) return -1;
            if (!aIsCurrent && bIsCurrent) return 1;
            return a.provider.localeCompare(b.provider);
        });
    }

    filteredModels = sortModels(filteredModels);

    // Find initial selection
    if (currentModel) {
        const idx = filteredModels.findIndex((m) => m.provider === currentModel.provider && m.id === currentModel.id);
        if (idx >= 0) selectedIndex = idx;
    }

    const searchInput = new Input();
    searchInput.onSubmit = () => {
        if (filteredModels[selectedIndex]) {
            done(filteredModels[selectedIndex].model);
        }
    };

    const root = new Container();

    // Search input
    root.addChild(searchInput);
    root.addChild(new Spacer(1));

    function buildModelLine(item: ModelItem, isSelected: boolean): string {
        const isCurrent = currentModel && item.provider === currentModel.provider && item.id === currentModel.id;
        const providerBadge = theme.fg("muted", `[${item.provider}]`);
        const checkmark = isCurrent ? theme.fg("success", " \u2713") : "";

        if (isSelected) {
            return `${theme.fg("accent", "\u2192 ")}${theme.fg("accent", item.id)} ${providerBadge}${checkmark}`;
        } else {
            return `  ${item.id} ${providerBadge}${checkmark}`;
        }
    }

    function renderList() {
        listContainer.clear();

        const maxVisible = 10;
        const startIndex = Math.max(
            0,
            Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredModels.length - maxVisible)
        );
        const endIndex = Math.min(startIndex + maxVisible, filteredModels.length);

        for (let i = startIndex; i < endIndex; i++) {
            const item = filteredModels[i];
            if (!item) continue;

            listContainer.addChild(new Text(buildModelLine(item, i === selectedIndex), 0, 0));
        }

        // Scroll indicator
        if (startIndex > 0 || endIndex < filteredModels.length) {
            const scrollInfo = theme.fg("muted", `  (${selectedIndex + 1}/${filteredModels.length})`);
            listContainer.addChild(new Text(scrollInfo, 0, 0));
        }

        if (filteredModels.length === 0) {
            listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
        } else {
            const selected = filteredModels[selectedIndex];
            listContainer.addChild(new Spacer(1));
            listContainer.addChild(
                new Text(theme.fg("muted", `  ${selected.model.name || selected.id} (${selected.provider})`), 0, 0)
            );
        }

        // Footer hints
        listContainer.addChild(new Spacer(1));
        listContainer.addChild(
            new Text(
                theme.fg(
                    "muted",
                    `${keyDisplayText("tui.select.confirm")} select  ${keyDisplayText("tui.select.cancel")} cancel`
                ),
                0,
                0
            )
        );
    }

    const listContainer = new Container();
    renderList();
    root.addChild(listContainer);

    function filterModels(query: string) {
        filteredModels = query
            ? fuzzyFilter(models, query, ({ id, provider, model }) => `${id} ${provider} ${model.name || ""}`)
            : [...models];

        filteredModels = sortModels(filteredModels);
        selectedIndex = Math.min(selectedIndex, Math.max(0, filteredModels.length - 1));
        renderList();
        tui.requestRender();
    }

    const kb = getKeybindings();

    (root as any).handleInput = (data: string) => {
        if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
            if (filteredModels.length === 0) return;
            const delta = kb.matches(data, "tui.select.up") ? -1 : 1;
            selectedIndex = (selectedIndex + delta + filteredModels.length) % filteredModels.length;
            renderList();
            tui.requestRender();
        } else if (kb.matches(data, "tui.select.confirm")) {
            const selected = filteredModels[selectedIndex];
            if (selected) {
                done(selected.model);
            }
        } else if (kb.matches(data, "tui.select.cancel")) {
            done(null);
        } else {
            searchInput.handleInput(data);
            filterModels(searchInput.getValue());
        }
    };

    return root as Component & { handleInput?: (data: string) => void };
}
