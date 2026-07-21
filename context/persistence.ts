/** All public-facing file operations use `path.basename()` to sanitize task IDs before constructing paths, preventing directory traversal attacks via crafted identifiers. */

import * as fs from "fs";
import * as path from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { OrchestrationPlan, TaskType, ALL_TASK_STATUSES } from "../core/types";
import { PlanDatabase } from "../core/plan-database";
import { OrchestratorState, notifyTui as coreNotifyTui, getPlanDb, setPlanDb, setPlanDbChangeListener } from "../core";

const ORCHESTRATION_BASE = path.join(process.cwd(), CONFIG_DIR_NAME, "orchestration");

/** Build a path under `.pi/orchestration/`. Optional `subDir` and `fileName` are appended. */
function getOrchestrationPath(subDir?: string, fileName?: string): string {
    if (subDir) {
        return fileName ? path.join(ORCHESTRATION_BASE, subDir, fileName) : path.join(ORCHESTRATION_BASE, subDir);
    }
    return fileName ? path.join(ORCHESTRATION_BASE, fileName) : ORCHESTRATION_BASE;
}

function getPlansDir(): string {
    return getOrchestrationPath("plans");
}
function getPlanJsonPath(): string {
    return getOrchestrationPath("plans", "plan.json");
}
function getPlanMdPath(): string {
    return getOrchestrationPath("plans", "plan.md");
}
function getImplementationPlanPath(): string {
    return getOrchestrationPath("plans", "implementation-plan.md");
}
function getPlanReviewPath(): string {
    return getOrchestrationPath("plans", "plan-review.md");
}

/** Legacy root-level plan paths (pre-reorganisation). Used for migration fallback. */
function legacyPlanJsonPath(): string {
    return getOrchestrationPath(undefined, "plan.json");
}
function legacyImplementationPlanPath(): string {
    return getOrchestrationPath(undefined, "implementation-plan.md");
}
function legacyPlanMdPath(): string {
    return getOrchestrationPath(undefined, "plan.md");
}

function getTasksDir(): string {
    return getOrchestrationPath("tasks");
}
function getArchiveDir(): string {
    return getOrchestrationPath("archive");
}
function getSummariesDir(): string {
    return getOrchestrationPath("summaries");
}
function getValidationsDir(): string {
    return getOrchestrationPath("validations");
}
function getAgentLogsDir(): string {
    return getOrchestrationPath("agent-logs");
}

/** @internal Listener registry for plan-change notifications. Called after every save/clear to trigger UI updates. */
let planChangeListeners: Array<() => void> = [];

/** @internal Cached copy of the implementation plan markdown content. Invalidated by clearPlan(). Uses undefined as "not yet populated" sentinel to distinguish from "plan doesn't exist". */
let cachedImplementationPlan: string | null | undefined = undefined;

/** @internal Cached copy of the plan review markdown content. Invalidated by clearPlan(). Uses undefined as "not yet populated" sentinel to distinguish from "review doesn't exist". */
let cachedPlanReview: string | null | undefined = undefined;

/** Subscribe to plan-change events. Returns an unsubscribe function. */
export function onPlanChange(listener: () => void): () => void {
    planChangeListeners.push(listener);
    return () => {
        planChangeListeners = planChangeListeners.filter((l) => l !== listener);
    };
}

/** Remove all registered plan-change listeners. Called during shutdown to prevent leaks. */
export function drainPlanChangeListeners(): void {
    planChangeListeners = [];
}

let saveTimer: NodeJS.Timeout | null = null;

export function startPlanSaveTimer(): void {
    if (saveTimer) return;
    saveTimer = setInterval(() => {
        try {
            const planDb = getPlanDb();
            if (planDb && planDb.isDirty()) {
                PersistenceManager.flushPlan();
            }
        } catch (e) {
            coreNotifyTui("PersistenceManager auto-save error: " + String(e));
        }
    }, 1000);
    if (saveTimer.unref) {
        saveTimer.unref();
    }
}

export function stopPlanSaveTimer(): void {
    if (saveTimer) {
        clearInterval(saveTimer);
        saveTimer = null;
    }
}

/** @internal Unsubscribe handle for PlanDatabase change listener. */
let planDbUnsubscribe: (() => void) | null = null;

/** Wire up the auto-save flush to PlanDatabase dirty tracking.
 *  Called at session start after the database is loaded. */
export function wirePlanPersistence(): void {
    // Unsubscribe from any previous connection
    if (planDbUnsubscribe) {
        planDbUnsubscribe();
    }
    const db = getPlanDb();
    if (!db) return;

    // Wire PlanDatabase error reporter so listener failures are surfaced via TUI.
    PlanDatabase.reportError = (msg: string) => coreNotifyTui(msg);

    planDbUnsubscribe = db.onDidChange(() => {
        // Only fire change notifications (UI updates) — no disk I/O here.
        // All persistence flows through the debounced timer in startPlanSaveTimer().
    });
}

// Register change listener so setPlanDb automatically re-wires persistence
setPlanDbChangeListener(() => {
    wirePlanPersistence();
});

/** Fire UI listeners without invalidating the in-memory cache. Used by savePlan() - we already have the plan in memory, no need to re-read disk. */
function notifyPlanChange(): void {
    for (const listener of planChangeListeners) {
        try {
            listener();
        } catch (e) {
            coreNotifyTui("Plan change listener error: " + String(e));
        }
    }
}

/** Invalidate the in-memory cache and fire UI listeners. Used by clearPlan/clearPlanJsonOnly - disk state has been wiped, so we must re-read next time. */
function emitPlanChange() {
    notifyPlanChange();
}

/** @internal Validate that a plain object has the required fields and types of a Task. */
function isValidTask(task: Record<string, unknown>): boolean {
    if (typeof task.id !== "string") return false;
    if (typeof task.description !== "string") return false;
    if (!Array.isArray(task.files)) return false;
    if (!task.files.every((f: unknown) => typeof f === "string" && f.trim() !== "")) return false;
    if (!Array.isArray(task.dependencies)) return false;
    if (!task.dependencies.every((d: unknown) => typeof d === "string")) return false;

    if (!ALL_TASK_STATUSES.includes(task.status as any)) return false;
    if (typeof task.attempts !== "number") return false;
    if (task.complexity !== "simple" && task.complexity !== "complex") return false;
    if (typeof task.timeoutMs !== "number") return false;

    // Validate optional fields when present
    if (task.taskType !== undefined) {
        const validTypes: TaskType[] = [
            "creation",
            "editing",
            "building",
            "administrative",
            "research",
            "reviewing",
            "other"
        ];
        if (!validTypes.includes(task.taskType as TaskType)) return false;
    }
    if (task.result !== undefined) {
        const r = task.result as Record<string, unknown>;
        if (typeof r !== "object" || r === null || typeof r.summary !== "string") return false;
        if (
            r.artifacts !== undefined &&
            (!Array.isArray(r.artifacts) || !r.artifacts.every((a: unknown) => typeof a === "string"))
        ) {
            return false;
        }
    }
    if (task.startedAt !== undefined && typeof task.startedAt !== "number") return false;
    if (task.clarificationAttempts !== undefined && typeof task.clarificationAttempts !== "number") return false;
    if (task.clarificationQuery !== undefined && typeof task.clarificationQuery !== "string") return false;
    if (task.validatorFeedback !== undefined && typeof task.validatorFeedback !== "string") return false;
    if (task.clarificationHistory !== undefined) {
        if (
            !Array.isArray(task.clarificationHistory) ||
            !task.clarificationHistory.every((entry: unknown) => {
                const e = entry as Record<string, unknown>;
                return e && typeof e === "object" && typeof e.query === "string" && typeof e.answer === "string";
            })
        ) {
            return false;
        }
    }
    return true;
}

function isValidOrchestrationPlan(obj: unknown): obj is OrchestrationPlan {
    if (!obj || typeof obj !== "object") return false;
    const plan = obj as Record<string, unknown>;
    if (typeof plan.goal !== "string") return false;

    if (plan.currentTaskId !== undefined && typeof plan.currentTaskId !== "string") return false;

    if (!Array.isArray(plan.tasks)) return false;
    for (const item of plan.tasks) {
        if (!item || typeof item !== "object" || !isValidTask(item as Record<string, unknown>)) {
            return false;
        }
    }

    const planObj = obj as OrchestrationPlan;
    const idSet = new Set<string>();
    for (const task of planObj.tasks) {
        if (idSet.has(task.id)) return false; // duplicate ID
        idSet.add(task.id);
    }
    for (const task of planObj.tasks) {
        for (const depId of task.dependencies || []) {
            if (!idSet.has(depId)) return false; // dangling reference
        }
    }

    return true;
}

/**
 * Attempt best-effort recovery of a structurally invalid plan.
 *
 * Repairs performed (in order):
 *   1. Filter out entries that aren't valid task objects, coercing missing optional fields.
 *   2. Drop duplicate-ID tasks (keep first occurrence).
 *   3. Strip dangling dependency references from tasks that point to non-existent task IDs.
 *
 * After repairs, re-validates the full plan via `isValidOrchestrationPlan`. Returns a valid
 * OrchestrationPlan if recovery succeeds, or null if the damage is too deep.
 *
 * All repairs are logged via TUI notification so they surface in the status view.
 */
function recoverPlan(obj: unknown): OrchestrationPlan | null {
    if (!obj || typeof obj !== "object") return null;
    const plan = obj as Record<string, unknown> & { tasks?: Array<Record<string, unknown>> };

    // Plan-level fields must be intact - we can't recover a missing goal.
    if (typeof plan.goal !== "string") {
        coreNotifyTui("Plan recovery failed: missing or invalid 'goal' field");
        return null;
    }
    if (plan.currentTaskId !== undefined && typeof plan.currentTaskId !== "string") {
        coreNotifyTui("Plan recovery failed: invalid currentTaskId");
        return null;
    }
    if (!Array.isArray(plan.tasks)) {
        coreNotifyTui("Plan recovery failed: tasks is not an array");
        return null;
    }

    // Filter to structurally valid task objects, coercing missing optional fields to defaults.
    const warnings: string[] = [];
    let tasks = plan.tasks.filter((item, idx) => {
        if (!item || typeof item !== "object") {
            warnings.push(`Dropped entry at index ${idx}: not a valid task object`);
            return false;
        }
        const t = item as Record<string, unknown>;
        if (!t.id || typeof t.id !== "string") {
            warnings.push(`Dropped task at index ${idx}: missing id`);
            return false;
        }
        if (typeof t.description !== "string" && t.description === undefined) {
            warnings.push(`Dropped task '${t.id}': missing description`);
            return false;
        }
        // Coerce optional fields that may be missing from older plan formats
        if (!Array.isArray(t.files)) t.files = [];
        if (!Array.isArray(t.dependencies)) t.dependencies = [];
        if (typeof t.attempts !== "number") t.attempts = 0;
        if (t.complexity === undefined) t.complexity = "simple";
        if (typeof t.timeoutMs !== "number") t.timeoutMs = 720_000;

        return isValidTask(t);
    });

    // Deduplicate by ID - keep first occurrence, drop later ones.
    const seenIds = new Set<string>();
    const deduped: typeof tasks = [];
    for (const task of tasks) {
        if (seenIds.has(task.id as string)) {
            warnings.push(`Dropped duplicate task '${task.id}'`);
        } else {
            seenIds.add(task.id as string);
            deduped.push(task);
        }
    }
    tasks = deduped;

    // Strip dangling dependency references.
    const taskIdSet = new Set(tasks.map((t) => t.id as string));
    for (const task of tasks) {
        const deps = task.dependencies as unknown[] | undefined;
        if (!Array.isArray(deps)) continue;
        const before = deps.length;
        const filtered = deps.filter((d: unknown) => typeof d === "string" && taskIdSet.has(d));
        task.dependencies = filtered as string[];
        if (filtered.length < before) {
            warnings.push(`Stripped dangling dependencies from '${task.id}'`);
        }
    }

    // Rebuild plan object with cleaned tasks.
    const repaired: OrchestrationPlan = {
        goal: plan.goal as string,
        currentTaskId: typeof plan.currentTaskId === "string" ? (plan.currentTaskId as string) : undefined,
        tasks: tasks as unknown as OrchestrationPlan["tasks"]
    };

    // Final validation - if it passes, we have a recovered plan.
    if (isValidOrchestrationPlan(repaired)) {
        for (const w of warnings) {
            coreNotifyTui(`Plan recovery: ${w}`);
        }
        coreNotifyTui(
            `Plan recovered with repairs (${repaired.tasks.length} tasks retained). ` +
                `The plan will be re-saved to persist the fixes.`
        );
        return repaired;
    }

    // Recovery failed - log what we had and give up.
    coreNotifyTui(
        `Plan recovery failed after repairs (${warnings.length} issue(s) addressed, still invalid). ` +
            `The plan file may need manual intervention.`
    );
    return null;
}

/** @internal Atomic file write with backup. Copies existing to `.old`, writes new content to `.new` temp, fsyncs both, then atomically renames. */
export function safeWriteFile(targetPath: string, content: string): void {
    const dir = path.dirname(targetPath);
    const basename = path.basename(targetPath);
    const oldPath = path.join(dir, `.${basename}.old`);
    const newPath = path.join(dir, `.${basename}.new`);

    // 1. Copy to old file & sync (backup failure should not block the new write)
    if (fs.existsSync(targetPath)) {
        try {
            fs.copyFileSync(targetPath, oldPath);
        } catch (copyErr) {
            coreNotifyTui(`Failed to create backup copy for ${targetPath}:` + String(copyErr));
        }

        // Only attempt fsync if the copy succeeded and the file exists.
        if (fs.existsSync(oldPath)) {
            const fdOld = fs.openSync(oldPath, "r");
            try {
                fs.fsyncSync(fdOld);
            } catch (fsyncErr) {
                coreNotifyTui(`Backup fsync failed for ${oldPath} - new write will proceed without synced backup: ${String(fsyncErr)}`);
            } finally {
                fs.closeSync(fdOld);
            }
        }
    }

    // 2. Create new version & sync
    const fdNew = fs.openSync(newPath, "w");
    try {
        fs.writeSync(fdNew, content, null, "utf-8");
        fs.fsyncSync(fdNew);
    } finally {
        fs.closeSync(fdNew);
    }

    // 3. Atomic move
    fs.renameSync(newPath, targetPath);
}

/**
 * Persistent state manager for orchestration plans.
 *
 * Handles atomic writes (write-to-temp + rename), Markdown rendering,
 * task prompt persistence, and archive management. All public methods
 * are synchronous - they block the caller during I/O.
 */
export class PersistenceManager {
    /** Ensure all required directories exist on disk (orchestration/, plans/, tasks/, archive/, agent-logs/, summaries/, validations/). */
    static initDirs(): void {
        fs.mkdirSync(ORCHESTRATION_BASE, { recursive: true });
        for (const getter of [
            getPlansDir,
            getTasksDir,
            getArchiveDir,
            getAgentLogsDir,
            getSummariesDir,
            getValidationsDir
        ]) {
            fs.mkdirSync(getter(), { recursive: true });
        }
    }

    /**
     * Load the plan from `plans/plan.json`. Falls back to legacy root-level
     * `plan.json` for backwards compatibility with pre-reorganisation projects.
     * Returns null if the file is missing or structurally invalid.
     */
    static loadPlan(): OrchestrationPlan | null {
        const planPath = getPlanJsonPath();

        function tryLoad(filePath: string): OrchestrationPlan | null {
            if (!fs.existsSync(filePath)) return null;
            try {
                const data = fs.readFileSync(filePath, "utf-8");
                const parsed = JSON.parse(data);
                if (isValidOrchestrationPlan(parsed)) {
                    return parsed;
                }

                // Strict validation failed - attempt best-effort recovery.
                const recovered = recoverPlan(parsed);
                if (recovered) {
                    // Persist the repaired plan so subsequent loads are fast.
                    try {
                        safeWriteFile(filePath, JSON.stringify(recovered, null, 2));
                    } catch {
                        /* If we can't write back, return recovered anyway - caller will re-save on next savePlan. */
                    }
                    return recovered;
                }

                coreNotifyTui(`Loaded ${filePath} is structurally invalid`);
            } catch (e) {
                coreNotifyTui(`Failed to parse ${filePath}: ${String(e)}`);
            }
            return null;
        }

        const primary = tryLoad(planPath);
        if (primary) {
            return primary;
        }

        // Try backup in plans/ directory
        const backupPath = planPath + ".old";
        // Always attempt backup recovery, even if primary was deleted by the user.
        const backup = tryLoad(backupPath);
        if (backup) {
            coreNotifyTui(`Recovered plan from backup: ${backupPath}`);
            return backup;
        }

        // Legacy fallback: check root-level plan.json for pre-reorganisation projects
        const legacyPath = legacyPlanJsonPath();
        const legacyBackup = legacyPath + ".old";
        // Always attempt legacy primary first, then legacy backup regardless of primary existence.
        const legacyPrimary = tryLoad(legacyPath);
        if (legacyPrimary) {
            return legacyPrimary;
        }
        const legacyBkp = tryLoad(legacyBackup);
        if (legacyBkp) {
            coreNotifyTui(`Recovered plan from legacy backup: ${legacyBackup}`);
            return legacyBkp;
        }

        return null;
    }

    /**
     * Flush the PlanDatabase state to disk. Only writes if the database
     * is marked dirty (i.e., mutations occurred since last flush).
     */
    static flushPlan(): void {
        const planDb = getPlanDb();
        if (!planDb || !planDb.isDirty()) {
            return;
        }

        try {
            this.initDirs();
            // Take a snapshot via toJSON (returns defensive deep copy)
            const snapshot = planDb.toJSON();

            const planPath = getPlanJsonPath();
            safeWriteFile(planPath, JSON.stringify(snapshot, null, 2));

            // One-shot migration cleanup: remove legacy root-level plan files
            for (const getter of [legacyPlanJsonPath, legacyImplementationPlanPath, legacyPlanMdPath]) {
                const p = getter();
                if (fs.existsSync(p)) {
                    try {
                        fs.unlinkSync(p);
                    } catch {
                        /* ignore */
                    }
                }
                // Also remove legacy backup dotfiles
                for (const suffix of [".old", ".new"]) {
                    const bp = p + suffix;
                    if (fs.existsSync(bp)) {
                        try {
                            fs.unlinkSync(bp);
                        } catch {
                            /* ignore */
                        }
                    }
                }
            }

            // Markdown rendering uses PlanDatabase.toMarkdown()
            const md = planDb.toMarkdown(OrchestratorState.currentState);
            safeWriteFile(getPlanMdPath(), md);

            // Clear dirty flag after successful write
            planDb.clearDirty();

            notifyPlanChange();
        } catch (e) {
            coreNotifyTui("PersistenceManager: Failed to save plan.json - " + String(e));
        }
    }

    /**
     * Save a plan by replacing the PlanDatabase with one built from the given
     * OrchestrationPlan object. Also flushes immediately.
     */
    static savePlan(plan: OrchestrationPlan): void {
        setPlanDb(new PlanDatabase(plan));
        this.flushPlan();
    }

    /** Remove all orchestration files (plans/, tasks/, archive/, agent-logs/, summaries/, validations/). */
    static clearPlan(): void {
        cachedImplementationPlan = undefined; // invalidate implementation plan cache
        cachedPlanReview = undefined; // invalidate plan review cache
        setPlanDb(null);
        const unlinkIfExists = (p: string) => {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        };
        const rmDirIfExists = (p: string) => {
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        };

        // Directory paths - remove recursively (includes plan files now under plans/)
        for (const getter of [
            getPlansDir,
            getTasksDir,
            getArchiveDir,
            getAgentLogsDir,
            getSummariesDir,
            getValidationsDir
        ]) {
            rmDirIfExists(getter());
        }

        // Also clean up any legacy root-level plan files that might remain
        for (const getter of [legacyPlanJsonPath, legacyImplementationPlanPath, legacyPlanMdPath]) {
            unlinkIfExists(getter());
            unlinkIfExists(getter() + ".old");
            unlinkIfExists(getter() + ".new");
        }

        emitPlanChange();
    }

    /** Clear plan.json and plan.md but preserve implementation-plan.md. */
    static clearPlanJsonOnly(): void {
        setPlanDb(null);
        const unlinkIfExists = (p: string) => {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        };
        for (const getter of [getPlanJsonPath, getPlanMdPath]) {
            unlinkIfExists(getter());
        }
        emitPlanChange();
    }

    /** Persist the task prompt to `tasks/<taskId>.prompt.md` for debugging.
     * Task ID is sanitized via `path.basename()` (see module-level comment). */
    static persistTaskPrompt(taskId: string, prompt: string): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(path.join(getTasksDir(), `${cleanId}.prompt.md`), prompt);
    }

    /** Persist the summary sub-agent prompt to `summaries/<taskId>.prompt.md` for debugging. */
    static persistSummaryPrompt(taskId: string, prompt: string): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(path.join(getSummariesDir(), `${cleanId}.prompt.md`), prompt);
    }

    /** Persist the summary sub-agent response to `summaries/<taskId>.response.md` for debugging.
     *  On failure, writes an error file instead (`<taskId>.error.md`). */
    static persistSummaryResponse(taskId: string, content: string): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(path.join(getSummariesDir(), `${cleanId}.response.md`), content);
    }

    static persistSummaryError(taskId: string, error: string): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(path.join(getSummariesDir(), `${cleanId}.error.md`), `Summary generation failed:\n\n${error}`);
    }

    /** Persist the validator prompt to `validations/<taskId>.prompt.md` for debugging. */
    static persistValidationPrompt(taskId: string, prompt: string): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(path.join(getValidationsDir(), `${cleanId}.prompt.md`), prompt);
    }

    /** Persist the validator response to `validations/<taskId>.response.json` for debugging.
     *  Contains {pass, feedback, validatedAt} - mirrors the summary persistence pattern. */
    static persistValidationResponse(taskId: string, result: { pass: boolean; feedback?: string }): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(
            path.join(getValidationsDir(), `${cleanId}.response.json`),
            JSON.stringify({ ...result, validatedAt: new Date().toISOString() }, null, 2)
        );
    }

    /** Archive a task's result JSON to `archive/<taskId>.result.json` with an `archivedAt` timestamp. */
    static archiveTaskResult(taskId: string, result: { status: string; summary?: string; feedback?: string }): void {
        this.initDirs();
        const cleanId = path.basename(taskId);
        safeWriteFile(
            path.join(getArchiveDir(), `${cleanId}.result.json`),
            JSON.stringify({ ...result, archivedAt: new Date().toISOString() }, null, 2)
        );
    }

    /** Move the task prompt from `tasks/` to `archive/` for post-completion debugging. */
    static archiveTaskPrompt(taskId: string): void {
        // Move the task prompt file from tasks/ to archive/ for debugging/audit
        const cleanId = path.basename(taskId);
        const src = path.join(getTasksDir(), `${cleanId}.prompt.md`);
        const dst = path.join(getArchiveDir(), `${cleanId}.prompt.md`);
        if (fs.existsSync(src)) {
            this.initDirs();
            fs.renameSync(src, dst);
        }
    }

    /** Remove a single task prompt file from `tasks/`. */
    static clearTaskPrompt(taskId: string): void {
        const cleanId = path.basename(taskId);
        const p = path.join(getTasksDir(), `${cleanId}.prompt.md`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    /** @internal Returns the IDs of all archived tasks derived from `.result.json` filenames in archive/. Kept for a future "view history" feature - currently unused. */
    static getArchivedTasks(): string[] {
        this.initDirs();
        const archiveDir = getArchiveDir();
        if (!fs.existsSync(archiveDir)) return [];
        return fs
            .readdirSync(archiveDir)
            .filter((f) => f.endsWith(".result.json"))
            .map((f) => f.replace(".result.json", ""));
    }

    /** Escape Markdown/HTML in short inline metadata fields (goal, task id).
     *  Does NOT escape # - use for single-line values where accidental headings
     *  could be problematic; callers should strip leading # if needed. */
    static escapeMdInline(text: string): string {
        return text
            .replace(/\\/g, "\\\\") // backslash first
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    /** Escape for multi-line content (task summaries) - preserves markdown structure.
     *  Only escapes HTML angle brackets outside of fenced code blocks (```...```).
     *  Inside code blocks, `<` and `>` are left intact so comparisons like
     *  `arr[i] > arr[i+1]` remain readable. */
    static escapeMdContent(text: string): string {
        return text
            .replace(/\\/g, "\\\\") // backslash first
            .replace(/(```[\s\S]*?```)/g, (match) => match) // preserve code blocks as-is
            .replace(/^((?!```).*)$/gm, (line) => line.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }

    /** Render the plan markdown by delegating to PlanDatabase.toMarkdown(). */
    static renderMarkdown(): void {
        const planDb = getPlanDb();
        if (!planDb) return;
        const md = planDb.toMarkdown(OrchestratorState.currentState);
        safeWriteFile(getPlanMdPath(), md);
    }

    static getMarkdownPlan(): string | null {
        const planMd = getPlanMdPath();
        if (fs.existsSync(planMd)) {
            return fs.readFileSync(planMd, "utf-8");
        }
        return null;
    }

    /** Load the implementation plan (high-level narrative) if it exists. Uses in-memory cache when available. */
    static loadImplementationPlan(): string | null {
        // Return cached value if available - avoids repeated sync disk reads.
        if (cachedImplementationPlan !== undefined) return cachedImplementationPlan;

        const filePath = getImplementationPlanPath();
        if (fs.existsSync(filePath)) {
            cachedImplementationPlan = fs.readFileSync(filePath, "utf-8");
            return cachedImplementationPlan;
        }
        cachedImplementationPlan = null;
        return null;
    }

    /** Save (overwrite) the implementation plan file. Updates in-memory cache so subsequent loads don't re-read disk. */
    static saveImplementationPlan(content: string): void {
        this.initDirs();
        const filePath = getImplementationPlanPath();
        safeWriteFile(filePath, content);
        cachedImplementationPlan = content; // update in-memory cache
    }

    /** Edit the implementation plan - find and replace a single region. Updates in-memory cache so subsequent loads don't re-read disk. */
    static editImplementationPlan(oldText: string, newText: string): string {
        this.initDirs();
        const filePath = getImplementationPlanPath();

        // Use cached content if available; otherwise read from disk (and populate cache)
        let data: string | null;
        if (cachedImplementationPlan !== undefined) {
            data = cachedImplementationPlan;
        } else {
            if (!fs.existsSync(filePath)) {
                throw new Error("Implementation plan does not exist yet. Write it first.");
            }
            data = fs.readFileSync(filePath, "utf-8");
            cachedImplementationPlan = data;
        }

        if (data === null) {
            throw new Error("Implementation plan does not exist yet. Write it first.");
        }

        const idx = data.indexOf(oldText);
        if (idx === -1) {
            // Give the model a hint so it can retry with correct text
            const snippetLen = Math.min(200, oldText.length);
            throw new Error(
                `Could not find the target text in implementation-plan.md. ` +
                    `Searched for: ${oldText.substring(0, snippetLen)}... ` +
                    `Ensure the text matches exactly (including whitespace).`
            );
        }
        const updated = data.substring(0, idx) + newText + data.substring(idx + oldText.length);
        safeWriteFile(filePath, updated);
        cachedImplementationPlan = updated; // update in-memory cache
        return "Implementation plan edited successfully.";
    }

    /** Load the plan review if it exists. Uses in-memory cache when available. */
    static loadPlanReview(): string | null {
        // Return cached value if available - avoids repeated sync disk reads.
        if (cachedPlanReview !== undefined) return cachedPlanReview;

        const filePath = getPlanReviewPath();
        if (fs.existsSync(filePath)) {
            cachedPlanReview = fs.readFileSync(filePath, "utf-8");
            return cachedPlanReview;
        }
        cachedPlanReview = null;
        return null;
    }

    /** Save (overwrite) the plan review file. Updates in-memory cache so subsequent loads don't re-read disk. */
    static savePlanReview(content: string): void {
        this.initDirs();
        const filePath = getPlanReviewPath();
        safeWriteFile(filePath, content);
        cachedPlanReview = content; // update in-memory cache
    }

    /** Path to code-review.md */
    static getCodeReviewPath(): string {
        return getOrchestrationPath("plans", "code-review.md");
    }

    /** Load code-review.md if it exists. */
    static loadCodeReview(): string | null {
        const filePath = this.getCodeReviewPath();
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, "utf-8");
        }
        return null;
    }

    /** Save (overwrite) code-review.md */
    static saveCodeReview(content: string): void {
        this.initDirs();
        const filePath = this.getCodeReviewPath();
        safeWriteFile(filePath, content);
    }

    /** Delete code-review.md */
    static deleteCodeReview(): void {
        const filePath = this.getCodeReviewPath();
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (err) {
                coreNotifyTui(`Failed to delete code-review.md: ${String(err)}`);
            }
        }
    }
}
