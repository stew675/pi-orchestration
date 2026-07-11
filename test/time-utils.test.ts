import { describe, it, expect } from "vitest";
import { parseTimeout, formatTimeout } from "../settings/time-utils";

// ---------------------------------------------------------------------------
// parseTimeout
// ---------------------------------------------------------------------------

describe("parseTimeout", () => {
    it("parses seconds", () => {
        expect(parseTimeout("30s")).toBe(30_000);
        expect(parseTimeout("120s")).toBe(120_000);
    });

    it("parses minutes", () => {
        expect(parseTimeout("5m")).toBe(300_000);
        expect(parseTimeout("15m")).toBe(900_000);
    });

    it("parses combined minutes and seconds", () => {
        expect(parseTimeout("1m20s")).toBe(80_000);
        expect(parseTimeout("2m30s")).toBe(150_000);
    });

    it("parses bare numbers as seconds", () => {
        expect(parseTimeout("45")).toBe(45_000);
        expect(parseTimeout("0")).toBe(0);
    });

    it("handles zero values", () => {
        expect(parseTimeout("0")).toBe(0);
        expect(parseTimeout("0s")).toBe(0);
        expect(parseTimeout("0m")).toBe(0);
        expect(parseTimeout("")).toBe(0);
    });

    it("is case-insensitive", () => {
        expect(parseTimeout("30S")).toBe(30_000);
        expect(parseTimeout("5M")).toBe(300_000);
        expect(parseTimeout("1M20S")).toBe(80_000);
    });

    it("trims whitespace", () => {
        expect(parseTimeout("  30s  ")).toBe(30_000);
        expect(parseTimeout("  5m  ")).toBe(300_000);
    });

    it("throws on unrecognised input (no digits before a unit)", () => {
        expect(() => parseTimeout("abc")).toThrow(/Invalid timeout format/);
        expect(() => parseTimeout("fast")).toThrow(/Invalid timeout format/);
    });

    // The regex /(\d+)m/ and /(\d+)s/ match anywhere in the string.
    // "1.5m" → (\d+)m matches "5m" (digit 5 immediately before 'm'), so totalMs = 300_000
    it("matches digits adjacent to unit suffix even within larger strings", () => {
        expect(parseTimeout("1.5m")).toBe(300_000); // "5m" matches → 5 minutes
    });
});

// ---------------------------------------------------------------------------
// formatTimeout
// ---------------------------------------------------------------------------

describe("formatTimeout", () => {
    it("formats zero as 'no timeout'", () => {
        expect(formatTimeout(0)).toBe("no timeout");
    });

    it("formats seconds only (< 60s)", () => {
        expect(formatTimeout(30_000)).toBe("30s");
        expect(formatTimeout(59_000)).toBe("59s");
    });

    it("formats minutes with remainder as combined string", () => {
        // 90s → "1m30s" (function prefers combined format over raw seconds)
        expect(formatTimeout(90_000)).toBe("1m30s");
    });

    it("formats exact minutes without trailing zero seconds", () => {
        expect(formatTimeout(120_000)).toBe("2m");
        expect(formatTimeout(480_000)).toBe("8m");
        expect(formatTimeout(900_000)).toBe("15m");
    });

    it("rounds down fractional milliseconds", () => {
        expect(formatTimeout(90_500)).toBe("1m30s"); // floor(90.5) = 90 → 1m30s
    });
});

// ---------------------------------------------------------------------------
// Round-trip consistency (non-zero values only — 0 maps to "no timeout" string, not back to 0)
// ---------------------------------------------------------------------------

describe("parseTimeout ↔ formatTimeout round-trip", () => {
    const testValues = [30_000, 60_000, 90_000, 120_000, 720_000, 80_000];

    it.each(testValues)("formats then parses back to same ms: %d", (ms) => {
        const formatted = formatTimeout(ms);
        expect(parseTimeout(formatted)).toBe(ms);
    });
});
