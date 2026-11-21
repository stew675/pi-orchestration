#!/usr/bin/env node
/**
 * Point ./.pi-host at the node_modules of the Pi installation that is actually running,
 * so `tsc` typechecks against the exact host packages Pi provides.
 *
 * Why: the host packages (@earendil-works/pi-*, typebox) are not dependencies of this
 * extension, and since Pi 1.6 the managed install lives per release under
 * ~/.pi/agent/install/releases/<current-version>/node_modules. A hardcoded path goes
 * stale on every `pi update`, which silently turned typechecking into "everything is
 * any". This script re-points the link from ~/.pi/agent/install/current-version, so
 * `npm run check` keeps working across Pi updates.
 *
 * Usage:
 *   node scripts/link-pi-host.mjs             # resolve the managed install
 *   PI_INSTALL_DIR=/path/to/pi-npm-dir ...    # use another layout (npm-global, tarball)
 */

import { readFileSync, existsSync, lstatSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REQUIRED = [
    "@earendil-works/pi-coding-agent/dist/index.d.ts",
    "@earendil-works/pi-tui/dist/index.d.ts",
    "@earendil-works/pi-ai/dist/index.d.ts",
    "typebox/build/index.d.mts"
];

const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function candidateNodeModules() {
    if (process.env.PI_INSTALL_DIR) return [resolve(process.env.PI_INSTALL_DIR, "node_modules")];

    // Managed install (releases-v1): the version lives in current-version.
    const versionFile = join(agentDir, "install", "current-version");
    if (existsSync(versionFile)) {
        const version = readFileSync(versionFile, "utf8").trim();
        if (version) return [join(agentDir, "install", "releases", version, "node_modules")];
    }

    // Fallbacks: a standalone/npm-global Pi layout.
    return [
        join(homedir(), ".local", "share", "pi-node", "current", "lib", "node_modules"),
        join(homedir(), ".local", "share", "pi-node", "current", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules")
    ];
}

const root = resolve(import.meta.dirname, "..");
const link = join(root, ".pi-host");

const source = candidateNodeModules().find((dir) => existsSync(join(dir, REQUIRED[0])));

if (!source) {
    console.error("link-pi-host: could not find a Pi installation with @earendil-works/pi-coding-agent.");
    console.error("link-pi-host: tried:");
    for (const dir of candidateNodeModules()) console.error(`  ${dir}`);
    console.error("link-pi-host: set PI_INSTALL_DIR to the directory that contains node_modules.");
    process.exit(1);
}

const missing = REQUIRED.filter((rel) => !existsSync(join(source, rel)));
if (missing.length) {
    console.error(`link-pi-host: ${source} is incomplete, missing:`);
    for (const rel of missing) console.error(`  ${rel}`);
    process.exit(1);
}

// Only ever replace a symlink (ours). Never delete a real directory someone put there.
if (existsSync(link) || isSymlink(link)) {
    if (!isSymlink(link)) {
        console.error(`link-pi-host: ${link} exists and is not a symlink, refusing to touch it.`);
        process.exit(1);
    }
    rmSync(link, { force: true });
}

symlinkSync(source, link, "dir");
mkdirSync(link, { recursive: true });

console.log(`link-pi-host: .pi-host -> ${source}`);

function isSymlink(path) {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}
