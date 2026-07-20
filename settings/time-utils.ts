/**
 * Parse a human-readable time string into milliseconds.
 *
 * Accepted formats: "30s", "1m", "1m20s", "15m", "0", "0s", "0m"
 * A value of 0 means "no timeout".
 */
export function parseTimeout(input: string): number {
    const trimmed = input.trim().toLowerCase();
    if (trimmed === "" || trimmed === "0" || trimmed === "0s" || trimmed === "0m") return 0;

    let totalMs = 0;
    let matched = false;

    // Match minutes: "15m" or "1m20s"
    const minMatch = trimmed.match(/(\d+)m/);
    if (minMatch) {
        totalMs += parseInt(minMatch[1], 10) * 60_000;
        matched = true;
    }

    // Match seconds: "30s" or the "20s" in "1m20s"
    const secMatch = trimmed.match(/(\d+)s/);
    if (secMatch) {
        totalMs += parseInt(secMatch[1], 10) * 1_000;
        matched = true;
    }

    // Bare number treated as seconds: "30" → 30s
    const bareMatch = trimmed.match(/^(\d+)$/);
    if (bareMatch && !matched) {
        totalMs += parseInt(bareMatch[1], 10) * 1_000;
        matched = true;
    }

    if (!matched || isNaN(totalMs))
        throw new Error(`Invalid timeout format: "${input}". Use formats like "30s", "1m20s", or "15m".`);
    return totalMs;
}

/** Format milliseconds back to a human-readable string. */
export function formatTimeout(ms: number): string {
    if (ms === 0) return "no timeout";
    const totalSeconds = Math.floor(ms / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

/** Format milliseconds to a compact string suitable for input field defaults.
 *  Returns "0" for no timeout (unlike formatTimeout which returns "no timeout"). */
export function formatTimeoutCompact(ms: number): string {
    if (ms === 0) return "0";
    const totalSeconds = Math.floor(ms / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}
