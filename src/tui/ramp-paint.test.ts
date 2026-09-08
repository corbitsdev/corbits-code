/**
 * The density ramp is the activity primitive. Every assertion here reads the
 * rendered frame and is pinned to the prompt box's bottom border — the one row
 * the status slot rides. Shell fields are not evidence: the bug this indicator
 * exists to fix was a slot whose internal state was perfectly correct and whose
 * painted row never changed.
 */

import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness";
import { RAMP_CYCLE_MS } from "./ramp";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge";
import { createAppShell } from "./shell/index";

const BRAILLE = /[⠀-⣿]/;
const DENSITY = /[░▒▓█]/;

/** Drives the bridge monitor tick by hand so the ramp animates deterministically. */
function fakeMonitor(stall?: { readonly noticeMs: number; readonly timeoutMs: number }): {
  readonly monitor: {
    now: () => number;
    tickMs: number;
    schedule: (tick: () => void, intervalMs: number) => () => void;
    stallNoticeMs?: number;
    stallTimeoutMs?: number;
  };
  advance: (ms: number) => void;
} {
  let clock = 0;
  let ticker: (() => void) | null = null;
  return {
    monitor: {
      now: () => clock,
      tickMs: 250,
      schedule: (tick) => {
        ticker = tick;
        return () => {
          ticker = null;
        };
      },
      ...(stall === undefined
        ? {}
        : { stallNoticeMs: stall.noticeMs, stallTimeoutMs: stall.timeoutMs }),
    },
    advance: (ms) => {
      clock += ms;
      ticker?.();
    },
  };
}

/** The prompt box's bottom border — the row the status slot rides. */
function statusRow(frame: string): string {
  const row = frame.split("\n").find((line) => line.includes("╰"));
  if (row === undefined) throw new Error("no prompt-box bottom border in frame");
  return row;
}

/**
 * The status slot's single state cell: the first glyph after the border's
 * opening corner and rule. Pinning to it is what keeps these assertions honest
 * — a bang or a block elsewhere in the frame must not satisfy them.
 */
function slotGlyph(frame: string): string {
  const match = /╰─ (\S)/.exec(statusRow(frame));
  if (match?.[1] === undefined) throw new Error("no status slot in border row");
  return match[1];
}

describe("turn ramp paint", () => {
  test("a running turn names its phase in the border, never a braille spinner", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { monitor } = fakeMonitor();
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor);
        try {
          bridge.handle({ type: "run", state: "busy" });
          await h.renderOnce();

          const frame = h.captureCharFrame();
          expect(statusRow(frame)).toContain("working");
          expect(slotGlyph(frame)).toMatch(DENSITY);
          expect(frame).not.toMatch(BRAILLE);
        } finally {
          bridge.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("the working slot moves off the monitor tick, with no timer of its own", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { monitor, advance } = fakeMonitor();
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor);
        try {
          bridge.handle({ type: "run", state: "busy" });
          await h.renderOnce();
          const first = statusRow(h.captureCharFrame());
          advance(RAMP_CYCLE_MS / 4);
          await h.renderOnce();
          const second = statusRow(h.captureCharFrame());
          // The whole point of the indicator: a live run does not look hung.
          expect(second).not.toBe(first);
          expect(slotGlyph(second)).toMatch(DENSITY);
        } finally {
          bridge.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("an idle turn clears the slot back to the wordmark", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { monitor } = fakeMonitor();
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor);
        try {
          bridge.handle({ type: "run", state: "busy" });
          bridge.handle({ type: "run", state: "idle" });
          await h.renderOnce();
          const row = statusRow(h.captureCharFrame());
          expect(row).not.toContain("working");
          expect(row).not.toMatch(DENSITY);
        } finally {
          bridge.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("idle costs zero animation frames — the tick does not re-arm", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        let scheduleCalls = 0;
        const { monitor, advance } = fakeMonitor();
        const countingMonitor = {
          ...monitor,
          schedule: (tick: () => void, ms: number) => {
            scheduleCalls++;
            return monitor.schedule(tick, ms);
          },
        };
        const bridge = attachSessionBridge(shell, createRecordingPort(), countingMonitor);
        try {
          bridge.handle({ type: "run", state: "busy" });
          bridge.handle({ type: "run", state: "idle" });
          const callsAtIdle = scheduleCalls;
          advance(10_000);
          expect(scheduleCalls).toBe(callsAtIdle);
        } finally {
          bridge.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("working and blocked read apart in the border with no colour at all", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { monitor, advance } = fakeMonitor();
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor);
        try {
          bridge.handle({ type: "run", state: "busy" });
          await h.renderOnce();
          const workingGlyphs = new Set<string>();
          for (let i = 0; i < 4; i++) {
            workingGlyphs.add(slotGlyph(h.captureCharFrame()));
            advance(RAMP_CYCLE_MS / 4);
            await h.renderOnce();
          }
          // Moving: the cell is not the same glyph frame to frame.
          expect(workingGlyphs.size).toBeGreaterThan(1);

          bridge.gateOpened();
          await h.renderOnce();
          const blockedGlyph = slotGlyph(h.captureCharFrame());
          // Waiting: a glyph the moving state never paints, held still.
          expect(workingGlyphs.has(blockedGlyph)).toBe(false);
          const blockedRow = statusRow(h.captureCharFrame());
          advance(4_000);
          await h.renderOnce();
          expect(statusRow(h.captureCharFrame())).toBe(blockedRow);
        } finally {
          bridge.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("silence past the stall notice still paints working, not a bang", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { monitor, advance } = fakeMonitor({
          noticeMs: 1_000,
          timeoutMs: 600_000,
        });
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor);
        try {
          bridge.handle({ type: "run", state: "busy" });
          await h.renderOnce();
          expect(slotGlyph(h.captureCharFrame())).toMatch(DENSITY);

          // Past the notice threshold the watchdog may flash, but operator
          // chrome keeps the working ramp — recovery is silent under the hood.
          advance(1_500);
          await h.renderOnce();
          expect(statusRow(h.captureCharFrame())).toContain("working");
          expect(slotGlyph(h.captureCharFrame())).toMatch(DENSITY);
          expect(slotGlyph(h.captureCharFrame())).not.toBe("!");

          // The slot keeps moving: still a live working pulse, not a settled bang.
          const first = slotGlyph(h.captureCharFrame());
          advance(RAMP_CYCLE_MS / 4);
          await h.renderOnce();
          expect(slotGlyph(h.captureCharFrame())).not.toBe(first);
          expect(slotGlyph(h.captureCharFrame())).toMatch(DENSITY);
        } finally {
          bridge.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
