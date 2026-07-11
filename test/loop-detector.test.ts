import { describe, it, expect, beforeEach } from "vitest";
import type { SubAgentEvent } from "../core/types";
import { LoopDetector, type LoopDetectorOptions } from "../process/loop-detector";
import * as orchLoop from "../process/loop-detector";

// ---------------------------------------------------------------------------
// Constants (must match loop-detector.ts)
// REQUIRED_CYCLES = 5, MAX_CYCLE_DEPTH = 3, MIN_BUFFER_SIZE = 15
// Detection only runs after buffer has ≥15 signature entries.
// ---------------------------------------------------------------------------

const MIN_BUFFER_SIZE = 15; // REQUIRED_CYCLES × MAX_CYCLE_DEPTH

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(tool: string, params?: Record<string, unknown>): SubAgentEvent {
    return { type: "tool_call", tool, name: tool, params: params || {} };
}

function makeMessageEnd(role: string = "assistant"): SubAgentEvent {
    return { type: "message_end", message: { role } };
}

// ---------------------------------------------------------------------------
// LoopDetector — basic behavior
// ---------------------------------------------------------------------------

describe("LoopDetector", () => {
    it("fires callback after enough repetitions of a single tool_call (cycleLen=1)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(1);
            }
        };
        const detector = new LoopDetector(opts);

        // Need ≥ MIN_BUFFER_SIZE identical events for cycleLen=1 detection to even start
        for (let i = 0; i < MIN_BUFFER_SIZE - 1; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(fired).toBe(false);

        // This 15th event triggers detection (buffer now has 15 entries)
        detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        expect(fired).toBe(true);
    });

    it("fires for a cycle of length 2 (alternating events)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(2);
            }
        };
        const detector = new LoopDetector(opts);

        // Need ≥ 15 entries → 8 pairs = 16 entries, floor(16/2)=8 segments ≥ 5 required
        for (let i = 0; i < 8; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeMessageEnd());
        }
        expect(fired).toBe(true);
    });

    it("does not fire when buffer is below MIN_BUFFER_SIZE (cycleLen=1, only 4 reps)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        for (let i = 0; i < 4; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(fired).toBe(false);
    });

    it("does not fire for non-repeating events even with a large buffer", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // Different paths → different signatures (raw, no normalization)
        for (let i = 0; i < 50; i++) {
            detector.ingest(makeToolCall("read", { path: `file_${i}.ts` }));
        }
        expect(fired).toBe(false);
    });

    it("ignores tool_result events (they produce no signature)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // 15 cycles of [tool_call, tool_result] — tool_result produces no signature
        // So only 15 tool_call signatures accumulate → cycleLen=1 fires after buffer reaches 15
        for (let i = 0; i < MIN_BUFFER_SIZE; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
            detector.ingest({ type: "tool_result", success: true });
        }
        expect(fired).toBe(true); // tool_calls alone form a cycle of length 1 with 15 reps ≥ 5 required
    });

    it("fires only once even when more events follow", () => {
        let fireCount = 0;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fireCount++;
            }
        };
        const detector = new LoopDetector(opts);

        // Feed well beyond the threshold
        for (let i = 0; i < 50; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(fireCount).toBe(1);
    });

    it("detects a cycle of length 3 (exactly at MIN_BUFFER_SIZE)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(3);
            }
        };
        const detector = new LoopDetector(opts);

        // 5 repetitions of [read, write, message_end] = 15 entries = MIN_BUFFER_SIZE
        for (let i = 0; i < 5; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeToolCall("write", { path: "b.ts" }));
            detector.ingest(makeMessageEnd());
        }
        expect(fired).toBe(true);
    });

    it("does not fire for a cycle of length 4 (exceeds MAX_CYCLE_DEPTH=3)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // 6 repetitions of a 4-event cycle (exceeds max depth, should not be detected)
        for (let i = 0; i < 6; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeMessageEnd());
            detector.ingest(makeToolCall("write", { path: "b.ts" }));
            detector.ingest(makeToolCall("edit", { path: "c.ts" }));
        }
        expect(fired).toBe(false);
    });

    it("handles unknown event types gracefully (no crash)", () => {
        const opts: LoopDetectorOptions = { onLoopDetected: () => {} };
        const detector = new LoopDetector(opts);
        // No crash — produces empty signature, silently skipped
        for (let i = 0; i < 50; i++) {
            detector.ingest({ type: "unknown_event" });
        }
    });

    it("distinguishes different tool parameters as distinct signatures", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(2);
            }
        };
        const detector = new LoopDetector(opts);

        // Alternate between two paths — forms a cycle of length 2
        // Need ≥ MIN_BUFFER_SIZE entries → 16 individual events (8 pairs), cycles=8 ≥ 5 required
        for (let i = 0; i < 16; i++) {
            detector.ingest(makeToolCall("read", { path: i % 2 === 0 ? "a.ts" : "b.ts" }));
        }
        expect(fired).toBe(true); // cycleLen=2, 8 reps ≥ 5 required
    });

    it("captures the correct pattern in loop info", () => {
        let capturedPattern: string[] | null = null;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                capturedPattern = info.pattern;
            }
        };
        const detector = new LoopDetector(opts);

        for (let i = 0; i < MIN_BUFFER_SIZE; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(capturedPattern).not.toBeNull();
        expect(capturedPattern!.length).toBe(1);
        expect(capturedPattern![0]).toContain("call:read");
    });

    it("reports correct cycle count in loop info", () => {
        let capturedCycles = 0;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                capturedCycles = info.cycles;
            }
        };
        const detector = new LoopDetector(opts);

        // Feed 15 identical events → buffer=15, cycleLen=1, cycles=floor(15/1)=15 ≥ 5
        for (let i = 0; i < MIN_BUFFER_SIZE; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(capturedCycles).toBeGreaterThanOrEqual(5);
    });

    it("breaks on a mismatched event in the cycle then recovers with enough repeats", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // 14 identical events (below MIN_BUFFER_SIZE) → no fire
        for (let i = 0; i < 14; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(fired).toBe(false);

        // One different event breaks the streak
        detector.ingest(makeToolCall("read", { path: "bar.ts" }));

        // 15 more identical events — buffer now has enough consecutive identical entries after trim
        for (let i = 0; i < MIN_BUFFER_SIZE; i++) {
            detector.ingest(makeToolCall("read", { path: "foo.ts" }));
        }
        expect(fired).toBe(true);
    });

    it("handles message_end with different roles as distinct signatures (cycleLen=2)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(2);
            }
        };
        const detector = new LoopDetector(opts);

        // Alternate between assistant and user messages — cycle of length 2 with many reps → fires
        for (let i = 0; i < 16; i++) {
            // 16 entries ≥ MIN_BUFFER_SIZE, floor(16/2)=8 ≥ 5 required
            detector.ingest(makeMessageEnd(i % 2 === 0 ? "assistant" : "user"));
        }
        expect(fired).toBe(true); // cycleLen=2, 8 reps ≥ 5 required
    });

    it("ignores events with no signature (tool_execution_end only)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // Only tool_result and tool_execution_end → no signatures at all → never fires regardless of count
        for (let i = 0; i < 100; i++) {
            detector.ingest({ type: "tool_execution_end" });
            detector.ingest({ type: "tool_result", success: true });
        }
        expect(fired).toBe(false);
    });

    it("handles tool_execution_start as equivalent to tool_call for signatures", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(1);
            }
        };
        const detector = new LoopDetector(opts);

        // 15 tool_execution_start events with same params → cycle of length 1
        for (let i = 0; i < MIN_BUFFER_SIZE; i++) {
            detector.ingest({ type: "tool_execution_start", tool: "read", name: "read", params: { path: "x.ts" } });
        }
        expect(fired).toBe(true);
    });

    it("does not fire for 5 repetitions of a cycleLen=2 pattern (only 10 entries < MIN_BUFFER_SIZE)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // Exactly 5 repetitions of [read, message_end] = 10 entries < MIN_BUFFER_SIZE=15 → no detection yet
        for (let i = 0; i < 5; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeMessageEnd());
        }
        expect(fired).toBe(false);
    });

    it("fires for 6 repetitions of a cycleLen=2 pattern (12 entries still < MIN_BUFFER_SIZE)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: () => {
                fired = true;
            }
        };
        const detector = new LoopDetector(opts);

        // 6 reps × 2 = 12 entries < 15 → still no detection
        for (let i = 0; i < 6; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeMessageEnd());
        }
        expect(fired).toBe(false);
    });

    it("fires for 8 repetitions of a cycleLen=2 pattern (16 entries ≥ MIN_BUFFER_SIZE)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycleLen).toBe(2);
            }
        };
        const detector = new LoopDetector(opts);

        // 8 reps × 2 = 16 entries ≥ MIN_BUFFER_SIZE=15, floor(16/2)=8 ≥ REQUIRED_CYCLES=5 → fires!
        for (let i = 0; i < 8; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeMessageEnd());
        }
        expect(fired).toBe(true);
    });

    it("detects cycleLen=3 at exactly MIN_BUFFER_SIZE (5 triplets = 15 entries)", () => {
        let fired = false;
        const opts: LoopDetectorOptions = {
            onLoopDetected: (info) => {
                fired = true;
                expect(info.cycles).toBe(5);
            }
        };
        const detector = new LoopDetector(opts);

        for (let i = 0; i < 5; i++) {
            detector.ingest(makeToolCall("read", { path: "a.ts" }));
            detector.ingest(makeToolCall("write", { path: "b.ts" }));
            detector.ingest(makeMessageEnd());
        }
        expect(fired).toBe(true); // 15 entries, cycleLen=3, cycles=5 = REQUIRED_CYCLES exactly
    });
});

// ---------------------------------------------------------------------------
// Orchestrator-level loop detection (singleton functions)
// Because they use a singleton, we reset state between tests.
// ---------------------------------------------------------------------------

describe("OrchestratorLoopDetector", () => {
    beforeEach(() => {
        orchLoop.resetLoopState();
    });

    it("builds a signature from recorded tool executions", () => {
        orchLoop.recordToolExecution("tc1", "read", { path: "a.ts" });
        const sig = orchLoop.buildTurnSignature();
        expect(sig).toContain("call:read");
        expect(sig).toContain("path=a.ts");
    });

    it("returns 'turn:none' when no tools recorded", () => {
        const sig = orchLoop.buildTurnSignature();
        expect(sig).toBe("turn:none");
    });

    it("produces different signatures for different tool calls", () => {
        orchLoop.recordToolExecution("tc1", "read", { path: "a.ts" });
        const sigA = orchLoop.buildTurnSignature();

        orchLoop.resetLoopState();
        orchLoop.recordToolExecution("tc1", "write", { path: "b.ts" });
        const sigB = orchLoop.buildTurnSignature();

        expect(sigA).not.toBe(sigB);
    });
});
