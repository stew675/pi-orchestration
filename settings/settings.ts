import { ModelRef } from "../core/types";
import * as fs from "fs";
import * as path from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { safeWriteFile } from "../context/state-manager";
import { notifyTui as coreNotifyTui } from "../core";

import {
    DEFAULT_TASK_TIMEOUT_MS,
    DEFAULT_VALIDATOR_TIMEOUT_MS,
    DEFAULT_SUMMARY_TIMEOUT_MS,
    DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS,
    DEFAULT_SUB_AGENT_MAX_TURNS
} from "../core/types";

/** Keys that hold model references (nullable ModelRef). */
const MODEL_KEYS = [
    "simpleTaskModel",
    "complexTaskModel",
    "summaryModel",
    "validatorModel",
    "orchestrationModel",
    "planningModel",
    "reviewerModel",
    "codeReviewModel"
] as const;

/** Keys that hold numeric concurrency values. */
const NUMBER_KEYS = ["summarizationConcurrency", "parallelTasks"] as const;

/** Keys that hold timeout values (in ms). */
const TIMEOUT_KEYS = ["taskTimeoutMs", "validatorTimeoutMs", "taskSummaryTimeoutMs", "subAgentIdleTimeoutMs"] as const;

/** Keys that hold integer limits. */
const LIMIT_KEYS = ["subAgentMaxTurns"] as const;

/** Keys that hold boolean behaviour flags. */
const BOOL_KEYS = ["allowStopTool", "validateSimpleTasks", "validateComplexTasks", "debugLogTransitions"] as const;

/** All configurable setting keys (union of the above groups). */
type SettingKey =
    | (typeof MODEL_KEYS)[number]
    | (typeof NUMBER_KEYS)[number]
    | (typeof TIMEOUT_KEYS)[number]
    | (typeof LIMIT_KEYS)[number]
    | (typeof BOOL_KEYS)[number];

/** Persisted model preferences for the orchestration extension. */
interface OrchestrationSettings {
    simpleTaskModel?: ModelRef;
    complexTaskModel?: ModelRef;
    summaryModel?: ModelRef;
    validatorModel?: ModelRef;
    orchestrationModel?: ModelRef;
    planningModel?: ModelRef;
    reviewerModel?: ModelRef;
    codeReviewModel?: ModelRef;
    summarizationConcurrency?: number;
    parallelTasks?: number;
    // Timeouts stored as human-readable strings (e.g. "12m", "4m30s")
    taskTimeoutMs?: number;
    validatorTimeoutMs?: number;
    taskSummaryTimeoutMs?: number;
    subAgentIdleTimeoutMs?: number;
    // Global limits
    subAgentMaxTurns?: number;
    // Behaviour flags
    allowStopTool?: boolean;
    validateSimpleTasks?: boolean;
    validateComplexTasks?: boolean;
    debugLogTransitions?: boolean;
}

/** Path to project-local settings (checked first). */
function getProjectSettingsPath(): string {
    return path.join(process.cwd(), CONFIG_DIR_NAME, "orchestration", "settings.json");
}

/** Path to global fallback settings (~/.pi/agent/orchestration-settings.json). */
function getGlobalSettingsPath(): string {
    return path.join(getAgentDir(), "orchestration-settings.json");
}

/**
 * Load a single settings file. Returns empty object if missing or invalid.
 */
function loadFile(p: string): OrchestrationSettings {
    if (!fs.existsSync(p)) return {};
    try {
        const data = fs.readFileSync(p, "utf-8");
        return JSON.parse(data) as OrchestrationSettings;
    } catch (e) {
        coreNotifyTui(`Failed to parse ${p}: ${String(e)}`);
        return {};
    }
}

/**
 * Load settings with two-tier resolution:
 * 1. Project-local  <cwd>/.pi/orchestration/settings.json  (checked first)
 * 2. Global fallback ~/.pi/agent/orchestration-settings.json
 *
 * If project-local exists, it takes full precedence.
 * If not, global settings are used as the effective configuration.
 */
function loadSettings(): OrchestrationSettings {
    const projectPath = getProjectSettingsPath();
    if (fs.existsSync(projectPath)) {
        return loadFile(projectPath);
    }
    // No project-local file - fall back to global
    return loadFile(getGlobalSettingsPath());
}

/**
 * Persist settings to the project-local path.
 * Always writes to <cwd>/.pi/orchestration/settings.json so that
 * per-project preferences override any global defaults.
 */
function saveProjectSettings(settings: OrchestrationSettings) {
    const settingsPath = getProjectSettingsPath();
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Use atomic write pattern for crash resilience (same as plan.json writes).
    safeWriteFile(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Delete the project-local settings file, allowing global fallback to take effect.
 */
function clearProjectSettings() {
    const settingsPath = getProjectSettingsPath();
    if (fs.existsSync(settingsPath)) {
        fs.unlinkSync(settingsPath);
    }
}

/**
 * Typed accessor for OrchestrationSettings - avoids repeated `(settings as any)` casts.
 */
function getSetting<K extends keyof OrchestrationSettings>(
    settings: OrchestrationSettings,
    key: K
): OrchestrationSettings[K] {
    return (settings as any)[key];
}

/**
 * Restore persisted model preferences into the in-memory OrchestratorState.
 *
 * Loads settings via two-tier resolution (project-local then global) and
 * mutates properties on the passed state object for any keys explicitly present
 * in the loaded settings. Missing values leave the existing state property unchanged.
 */
export function applySettingsToState(state: Record<SettingKey, unknown>) {
    const settings = loadSettings();

    // Model references - apply if truthy (non-null/non-undefined)
    for (const key of MODEL_KEYS) {
        if (getSetting(settings, key)) state[key] = getSetting(settings, key);
    }

    // Numeric values - apply only if explicitly a number
    for (const key of [...NUMBER_KEYS, ...TIMEOUT_KEYS, ...LIMIT_KEYS]) {
        const value = getSetting(settings, key as keyof OrchestrationSettings);
        if (typeof value === "number") {
            state[key] = value;
        }
    }

    // Boolean flags - apply only if explicitly a boolean
    for (const key of BOOL_KEYS) {
        const value = getSetting(settings, key as keyof OrchestrationSettings);
        if (typeof value === "boolean") {
            state[key] = value;
        }
    }
}

/**
 * Reset model choices to defaults. Clears any project-local overrides so that
 * global fallback (~/.pi/agent/orchestration-settings.json) takes effect.
 * If no global file exists, falls back to null (Pi default).
 *
 * Returns the effective settings after reset (for display to user).
 */
export function resetToDefaults(state: Record<SettingKey, unknown>): OrchestrationSettings {
    // Clear project-local overrides
    clearProjectSettings();

    // Now loadSettings() will fall back to global (or empty)
    const effective = loadSettings();

    // Model keys - set from effective or null
    for (const key of MODEL_KEYS) {
        state[key] = (effective as any)[key] ?? null;
    }

    // Numeric concurrency defaults
    if (typeof effective.summarizationConcurrency === "number") {
        state.summarizationConcurrency = effective.summarizationConcurrency;
    }
    state.parallelTasks = typeof effective.parallelTasks === "number" ? effective.parallelTasks : 1;

    // Timeout defaults - use built-in constants when not in global settings
    if (typeof effective.taskTimeoutMs === "number") state.taskTimeoutMs = effective.taskTimeoutMs;
    else state.taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
    if (typeof effective.validatorTimeoutMs === "number") state.validatorTimeoutMs = effective.validatorTimeoutMs;
    else state.validatorTimeoutMs = DEFAULT_VALIDATOR_TIMEOUT_MS;
    if (typeof effective.taskSummaryTimeoutMs === "number") state.taskSummaryTimeoutMs = effective.taskSummaryTimeoutMs;
    else state.taskSummaryTimeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS;
    if (typeof effective.subAgentIdleTimeoutMs === "number") state.subAgentIdleTimeoutMs = effective.subAgentIdleTimeoutMs;
    else state.subAgentIdleTimeoutMs = DEFAULT_SUB_AGENT_IDLE_TIMEOUT_MS;
    if (typeof effective.subAgentMaxTurns === "number") state.subAgentMaxTurns = effective.subAgentMaxTurns;
    else state.subAgentMaxTurns = DEFAULT_SUB_AGENT_MAX_TURNS;

    // Behaviour flags - hard-coded defaults
    state.allowStopTool = true;
    state.validateSimpleTasks = false;
    state.validateComplexTasks = true;
    state.debugLogTransitions = false;

    return effective;
}

/**
 * Persist current in-memory settings to disk.
 *
 * Writes model selections, concurrency values, timeouts, and behaviour flags
 * to the project-local settings file so that per-project preferences override
 * any global defaults.
 */
export function persistSettings(state: Record<SettingKey, unknown>): void {
    const settingsPath = getProjectSettingsPath();
    let settings: OrchestrationSettings = {};

    // Start from existing project-local file if present, otherwise start fresh
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as OrchestrationSettings;
        } catch {
            /* ignore */
        }
    }

    // Model keys - store if truthy, delete if null/undefined
    for (const key of MODEL_KEYS) {
        if ((state as any)[key]) {
            settings[key] = (state as any)[key];
        } else {
            delete (settings as any)[key];
        }
    }

    // summarizationConcurrency - only store if non-default (0)
    if (state.summarizationConcurrency !== 0) {
        settings.summarizationConcurrency = state.summarizationConcurrency as number;
    } else {
        delete settings.summarizationConcurrency;
    }

    // parallelTasks - only store if non-default (1)
    if ((state.parallelTasks as number) !== undefined && (state.parallelTasks as number) !== 1) {
        settings.parallelTasks = state.parallelTasks as number;
    } else {
        delete settings.parallelTasks;
    }

    // Timeouts - always stored explicitly so they survive reloads
    settings.taskTimeoutMs = state.taskTimeoutMs as number;
    settings.validatorTimeoutMs = state.validatorTimeoutMs as number;
    settings.taskSummaryTimeoutMs = state.taskSummaryTimeoutMs as number;
    settings.subAgentIdleTimeoutMs = state.subAgentIdleTimeoutMs as number;

    // Global limits - always stored explicitly
    settings.subAgentMaxTurns = state.subAgentMaxTurns as number;

    // Behaviour flags - only store if non-default
    const boolDefaults: Array<{ key: (typeof BOOL_KEYS)[number]; defaultValue: boolean }> = [
        { key: "allowStopTool", defaultValue: true },
        { key: "validateSimpleTasks", defaultValue: false },
        { key: "validateComplexTasks", defaultValue: true },
        { key: "debugLogTransitions", defaultValue: false }
    ];
    for (const { key, defaultValue } of boolDefaults) {
        const value = state[key] as boolean;
        if (value !== undefined && value !== defaultValue) {
            settings[key] = value;
        } else {
            delete settings[key];
        }
    }

    saveProjectSettings(settings);
}

