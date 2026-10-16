/**
 * Render-loop guard rails.
 *
 * The monitor is the only clock the TUI animates off: it must stop when
 * nothing is moving, and a plain appended transcript row must not rebuild the
 * rows already on screen.
 */

import { describe, expect, test } from "bun:test";
import { ManualClock } from "@opentui/core/testing";

import { withTestRenderer } from "./harness";
import { RAMP_CYCLE_MS, rampPulse } from "./ramp-glyphs";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge";
import { appendStreamRow } from "./shell/chrome";
import { createAppShell } from "./shell/index";

const SHELL_OPTS = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
  run: "idle",
} as const;

const WIDE = { width: 80, height: 24 } as const;

interface ScheduleCall {
  readonly intervalMs: number;
}

/** Records every (re)scheduling of the monitor and lets the test drive it. */
function recordingMonitor() {
  let clock = 0;
  let ticker: (() => void) | null = null;
  const schedules: ScheduleCall[] = [];
  return {
    monitor: {
      now: () => clock,
      schedule: (tick: () => void, intervalMs: number) => {
        schedules.push({ intervalMs });
        ticker = tick;
        return () => {
          ticker = null;
        };
      },
    },
    schedules,
    running: () => ticker !== null,
    intervalMs: () => schedules.at(-1)?.intervalMs ?? null,
    advance: (ms: number) => {
      clock += ms;
      ticker?.();
    },
  };
}

describe("monitor cadence", () => {
  test("stays quiet while the session is idle", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, SHELL_OPTS);
      const m = recordingMonitor();
      const bridge = attachSessionBridge(
        shell,
        createRecordingPort(),
        m.monitor,
      );
      try {
        // Attaching to an idle session must not start a repaint loop.
        expect(m.running()).toBe(false);
        expect(m.schedules).toEqual([]);

        bridge.handle({ type: "run", state: "busy" });
        expect(m.running()).toBe(true);

        bridge.handle({ type: "reactor.done", data: {} });
        expect(shell.lockupPhase).toBeNull();
        expect(m.running()).toBe(false);
      } finally {
        bridge.dispose();
      }
    }, WIDE);
  });

  test("animates fast enough for the ramp to read as motion", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, SHELL_OPTS);
      const m = recordingMonitor();
      const bridge = attachSessionBridge(
        shell,
        createRecordingPort(),
        m.monitor,
      );
      try {
        bridge.handle({ type: "run", state: "busy" });
        const tickMs = m.intervalMs();
        expect(tickMs).not.toBeNull();
        // Stall and quota stay on the slow cadence. The ramp is sampled by
        // Timeline frames (about a renderer frame), not by tightening this
        // interval. 16ms steps of the same clock must still show every density.
        expect(tickMs).toBeGreaterThanOrEqual(200);

        const glyphs = new Set<string>();
        for (let elapsed = 0; elapsed < RAMP_CYCLE_MS; elapsed += 16) {
          m.advance(16);
          glyphs.add(
            rampPulse({
              phase: "working",
              nowMs: shell.lockupNowMs,
              stalledForMs: null,
            }),
          );
        }
        expect(glyphs.size).toBeGreaterThanOrEqual(4);
      } finally {
        bridge.dispose();
      }
    }, WIDE);
  });

  test("timeline frames advance the ramp when the stall schedule does not tick", async () => {
    const clock = new ManualClock();
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, SHELL_OPTS);
        const bridge = attachSessionBridge(shell, createRecordingPort(), {
          now: () => clock.now(),
          tickMs: 250,
          schedule: () => () => undefined,
        });
        try {
          bridge.handle({ type: "run", state: "busy" });
          await h.renderOnce();
          const first = shell.lockupNowMs;
          clock.advance(RAMP_CYCLE_MS / 4);
          await h.renderOnce();
          expect(shell.lockupNowMs - first).toBeGreaterThanOrEqual(
            RAMP_CYCLE_MS / 4,
          );
        } finally {
          bridge.dispose();
        }
      },
      { ...WIDE, clock },
    );
  });
});

describe("transcript append", () => {
  test("a plain appended row keeps the rows already painted", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, SHELL_OPTS);
      for (const text of ["one", "two", "three"]) {
        appendStreamRow(shell, { role: "system", text });
      }
      // Index 0 is the transcript's bottom-anchor spacer, not a row.
      const before = shell.transcript.getChildren().slice(1);
      expect(before).toHaveLength(3);

      appendStreamRow(shell, { role: "system", text: "four" });

      const after = shell.transcript.getChildren().slice(1);
      expect(after).toHaveLength(4);
      // Same node objects: the append added one renderable rather than tearing
      // the window down and rebuilding every row.
      expect(after.slice(0, 3)).toEqual(before);
    }, WIDE);
  });
});
