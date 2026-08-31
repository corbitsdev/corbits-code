/**
 * Bridge-level wiring for the progress label, quota auto-retry and stall
 * watchdog. The monitor clock is injected, so nothing here waits on wall time.
 */

import { describe, expect, test } from "bun:test";

import { attachSessionBridge, createRecordingPort } from "./runtime-bridge.js";
import { createAppShell, noticeText } from "./shell.js";
import { withTestRenderer } from "./harness.js";
import { RUNTIME_FLASH_MS } from "./runtime-notices.js";
import { STALL_NOTICE_MESSAGE, STALL_RECOVERY_MESSAGE } from "./stall-watchdog.js";

type Harness = Awaited<ReturnType<typeof setup>>;

async function setup(h: { renderer: Parameters<typeof createAppShell>[0] }) {
  const shell = createAppShell(h.renderer, {
    terminal: { columns: 80, rows: 24 },
    wireKeys: false,
    run: "idle",
  });
  const port = createRecordingPort();
  let nowMs = 0;
  let tick: (() => void) | undefined;
  const bridge = attachSessionBridge(shell, port, {
    now: () => nowMs,
    stallTimeoutMs: 1_000,
    stallNoticeMs: 400,
    schedule: (fn) => {
      tick = fn;
      return () => {
        tick = undefined;
      };
    },
  });
  return {
    shell,
    port,
    bridge,
    advance: (ms: number) => {
      nowMs += ms;
    },
    tick: () => tick?.(),
  };
}

const quotaEvent = (retryAfterMs: number) => ({
  type: "inference.error",
  data: { error: { category: "quota_exhausted", retryAfterMs } },
});

describe("turn progress label", () => {
  test("tracks the live phase and clears when the run settles", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        expect(t.shell.lockupPhase).toBeNull();

        t.bridge.handle({ type: "inference.start", data: {} });
        // What the slot paints from this phase is asserted against the
        // rendered border row in the ramp paint tests; here it is only that
        // the phase itself tracks the run.
        expect(t.shell.lockupRampPhase).toBe("working");
        expect(t.shell.lockupPhase).toBe("working");

        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "hm" },
        });
        expect(t.shell.lockupPhase).toBe("thinking");

        t.bridge.handle({ type: "inference.text.delta", data: { token: "hi" } });
        expect(t.shell.lockupPhase).toBe("working");

        t.bridge.handle({ type: "inference.text.delta", data: { token: " there" } });
        expect(t.shell.lockupPhase).toBe("working");

        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "mcp__glitchtip__resolve_issue", callId: "c1" },
        });
        // Unmapped tool identifiers — including MCP tools — fall back to the
        // generic working state rather than leaking the raw name.
        expect(t.shell.lockupPhase).toBe("working");

        t.bridge.handle({ type: "reactor.done", data: {} });
        expect(t.shell.lockupPhase).toBeNull();
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("the bottom-left slot carries the phase and fades on each change", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        expect(t.shell.lockupPhase).toBeNull();

        t.bridge.handle({ type: "inference.start", data: {} });
        expect(t.shell.lockupPhase).toBe("working");
        const started = t.shell.lockupChangedMs;

        t.advance(500);
        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "hm" },
        });
        expect(t.shell.lockupPhase).toBe("thinking");
        // A new phase restamps the fade so the crossfade starts over.
        expect(t.shell.lockupChangedMs).toBeGreaterThan(started);

        t.bridge.handle({ type: "reactor.done", data: {} });
        expect(t.shell.lockupPhase).toBeNull();
      } finally {
        t.bridge.dispose();
      }
    });
  });

  /**
   * The shape a real chat turn actually has. A chat session emits no
   * `reactor.done` until it closes, so `connector.reply` is the only terminal
   * event the shell ever sees — the regression this covers left the phase line
   * counting for the rest of the session.
   */
  test("a full turn with a tool clears the phase on connector.reply", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.handle({
          type: "message.received",
          data: { message: { content: "list the root" } },
        });
        t.bridge.handle({ type: "inference.start", data: {} });
        t.bridge.handle({ type: "inference.text.delta", data: { token: "I'll " } });
        t.bridge.handle({ type: "inference.text.delta", data: { token: "look." } });
        t.bridge.handle({
          type: "inference.tool_call.start",
          data: { name: "bash", callId: "c1" },
        });
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1", arguments: "ls" },
        });
        t.bridge.handle({ type: "inference.done", data: {} });

        // The cycle's reply lands while bash is still out: the turn continues.
        t.bridge.handle({ type: "connector.reply", data: { content: "" } });
        expect(t.shell.lockupPhase).not.toBeNull();

        t.bridge.handle({
          type: "tool.start",
          data: { call: { id: "c1", name: "bash" } },
        });
        t.bridge.handle({
          type: "tool.done",
          data: { result: { callId: "c1", name: "bash", content: "AGENTS.md" } },
        });

        t.bridge.handle({ type: "inference.start", data: {} });
        t.bridge.handle({ type: "inference.text.delta", data: { token: "done." } });
        t.bridge.handle({ type: "inference.done", data: {} });
        t.bridge.handle({ type: "connector.reply", data: { content: "done." } });

        expect(t.shell.lockupPhase).toBeNull();
        expect(t.bridge.turn.isProcessing).toBe(false);
        expect(noticeText(t.shell)).not.toContain("working");
        // The session is handed back and the transient row empties with it.
        expect(t.shell.session.run).toBe("idle");
        expect(noticeText(t.shell)).toBe("");

        // A later tick must not resurrect it.
        t.advance(250);
        t.tick();
        expect(t.shell.lockupPhase).toBeNull();
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("an interrupted turn clears the phase", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.handle({ type: "inference.start", data: {} });
        t.bridge.handle({ type: "inference.text.delta", data: { token: "hi" } });
        expect(t.shell.lockupPhase).not.toBeNull();

        t.bridge.interrupt();
        expect(t.shell.lockupPhase).toBeNull();
        t.advance(250);
        t.tick();
        expect(t.shell.lockupPhase).toBeNull();
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("a reactor error clears the phase", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.handle({ type: "inference.start", data: {} });
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        });
        expect(t.shell.lockupPhase).not.toBeNull();

        t.bridge.handle({
          type: "reactor.error",
          data: { fatal: true, error: "boom" },
        });
        expect(t.shell.lockupPhase).toBeNull();
        expect(t.bridge.turn.isProcessing).toBe(false);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("an open permission overlay freezes the ramp and reads waiting", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.handle({ type: "inference.start", data: {} });
        t.shell.overlayKind = "permissions";
        t.bridge.gateOpened();
        t.tick();
        expect(t.shell.lockupPhase).toBe("waiting");

        // Frozen is the signal: the ramp must not move while a human is asked.
        const frozen = t.shell.lockupPhase;
        t.advance(1_000);
        expect(t.shell.lockupPhase).toBe(frozen);

        // The running state lives in the border, not the transient row: the
        // row would be a second indicator one line above the first.
        expect(noticeText(t.shell)).not.toContain("blocked");
        expect(noticeText(t.shell)).not.toMatch(/[░▒▓█]/u);
      } finally {
        t.bridge.dispose();
      }
    });
  });
});

describe("quota auto-retry", () => {
  test("counts down then resubmits the last prompt once", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("run the build", "immediate");
        t.port.clear();
        t.bridge.handle(quotaEvent(60_000));

        t.advance(10_000);
        t.tick();
        // The durable error is already in the transcript; the notice row must
        // not park a sticky countdown that outlives every other flash.
        expect(t.shell.statusFlash).toBeNull();
        expect(t.port.calls).toEqual([]);

        t.advance(60_000);
        t.tick();
        expect(t.port.calls).toEqual([{ op: "sendImmediate", text: "run the build" }]);
        expect(t.shell.statusFlash).toBe("rate limit cleared — resubmitting");

        // Window is closed — a later tick must not replay the prompt again.
        t.advance(60_000);
        t.tick();
        expect(t.port.calls.filter((c) => c.op === "sendImmediate")).toHaveLength(1);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("the clear-and-resubmit flash expires on its own", async () => {
    await withTestRenderer(async (h) => {
      const lapse: (() => void)[] = [];
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
        flashSchedule: (fn, ms) => {
          expect(ms).toBe(RUNTIME_FLASH_MS);
          lapse.push(fn);
          return () => {};
        },
      });
      const port = createRecordingPort();
      let nowMs = 0;
      let tick: (() => void) | undefined;
      const bridge = attachSessionBridge(shell, port, {
        now: () => nowMs,
        stallTimeoutMs: 1_000,
        stallNoticeMs: 400,
        schedule: (fn) => {
          tick = fn;
          return () => {
            tick = undefined;
          };
        },
      });
      try {
        bridge.submit("run the build", "immediate");
        port.clear();
        bridge.handle(quotaEvent(1_000));
        nowMs += 10_000;
        tick?.();
        expect(shell.statusFlash).toBe("rate limit cleared — resubmitting");
        expect(lapse).toHaveLength(1);
        lapse[0]?.();
        expect(shell.statusFlash).toBeNull();
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    });
  });

  test("an interrupted turn is never replayed", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("run the build", "immediate");
        t.bridge.handle(quotaEvent(1_000));
        t.bridge.interrupt();
        t.port.clear();

        t.advance(10_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
      } finally {
        t.bridge.dispose();
      }
    });
  });
});

describe("stall watchdog", () => {
  test("says the run looks stuck long before it aborts anything", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();

        t.advance(300);
        t.tick();
        expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);

        t.advance(200);
        t.tick();
        expect(t.shell.statusFlash).toBe(STALL_NOTICE_MESSAGE);
        // A notice, not a timeout: the run is still going.
        expect(t.port.calls).toEqual([]);
        expect(t.shell.lockupPhase).not.toBeNull();
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("clears the notice once activity resumes, rather than leaving it up", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();

        t.advance(500);
        t.tick();
        expect(t.shell.statusFlash).toBe(STALL_NOTICE_MESSAGE);

        // The model starts producing again — the notice must not linger past
        // the silence it was reporting. handle() itself has to take it down;
        // waiting for the next tick leaves a window where the turn can settle
        // and cancel the cadence, which would strand the banner forever.
        t.bridge.handle({ type: "inference.text.delta", data: { token: "ok" } });
        expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("clears the notice when the turn settles before the next tick", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();

        t.advance(500);
        t.tick();
        expect(t.shell.statusFlash).toBe(STALL_NOTICE_MESSAGE);

        t.bridge.handle({ type: "inference.done", data: {} });
        // Cadence is cancelled on settle. The notice has to already be gone.
        expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("aborts and flashes once a mid-stream hang crosses the stall timeout", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        // Tokens actually started flowing, then everything went silent —
        // the one shape auto-abort still acts on.
        t.bridge.handle({ type: "inference.text.delta", data: { token: "ok" } });
        t.port.clear();

        t.advance(500);
        t.tick();
        expect(t.port.calls).toEqual([]);

        t.advance(1_000);
        t.tick();
        expect(t.port.calls).toEqual([{ op: "interrupt" }]);
        expect(t.shell.statusFlash).toBe(STALL_RECOVERY_MESSAGE);

        // The aborted turn is settled, so the watchdog does not re-fire.
        t.advance(10_000);
        t.tick();
        expect(t.port.calls).toHaveLength(1);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  // CL-5640: a healthy wait for the model to start its next reply — right
  // after submit, or right after the last outstanding tool call resolves —
  // must never be auto-aborted just because the parent stream is quiet. Only
  // a stream that had already started producing tokens and then went dead
  // (covered above) earns the abort; this shape gets the notice at most.
  test("a long-but-healthy wait right after submit is never auto-aborted, only noticed", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();

        // No delta ever arrives — the model is just slow to start — held
        // far past the stall timeout.
        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
        expect(t.shell.statusFlash).toBe(STALL_NOTICE_MESSAGE);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("a long-but-healthy wait right after a tool batch resolves is never auto-aborted", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        });
        t.bridge.handle({
          type: "tool.done",
          data: { result: { callId: "c1" } },
        });
        t.port.clear();

        // The last outstanding call resolved; the model just takes a long
        // while to start its next reply. Held far past the stall timeout.
        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
        expect(t.shell.statusFlash).toBe(STALL_NOTICE_MESSAGE);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  // CL-5640: live sub-agent progress must keep the parent stream's silence
  // exempt from abort even though the parent's own `task` call is the only
  // thing in `activeToolCalls` — a future change to task-lifecycle handling
  // must not silently drop this exemption.
  test("live sub-agent progress under an outstanding task call is never auto-aborted", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "spawn_agent", callId: "c1" },
        });
        t.port.clear();

        // The parent stream stays quiet while the sub-agent works — far past
        // the stall timeout.
        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("an open gate is exempt no matter how long the operator takes", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();
        t.bridge.gateOpened();

        // Far past the stall timeout — an operator reading an approval must
        // never have the run torn down underneath them.
        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
        expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("a gate queued but not yet displayed gets the same exemption", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();
        // The gate is raised but nothing else has changed `shell.overlayKind`
        // — this is the "queued behind another overlay" shape from
        // gate-wire.ts, where the gate is not nominally displayed yet.
        t.bridge.gateOpened();
        expect(t.shell.overlayKind).toBeNull();

        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
        expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("a live tool run is not treated as a stall", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.bridge.handle({ type: "inference.text.delta", data: { token: "ok" } });
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        });
        t.port.clear();

        t.advance(10_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  // The gate exemption (this fix) and the parallel-tool-call exemption
  // (CL-5641) are independent guards feeding the same stall check — a run
  // with both outstanding must stay exempt, and closing the gate while the
  // tool call is still out must not re-expose it to the clock.
  test("a gate open alongside a live sibling tool call stays exempt", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "spawn_agent", callId: "c1" },
        });
        t.bridge.gateOpened();
        t.port.clear();

        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);

        t.bridge.gateClosed();
        t.advance(20 * 60_000);
        t.tick();
        expect(t.port.calls).toEqual([]);
      } finally {
        t.bridge.dispose();
      }
    });
  });
});

describe("repetition guard", () => {
  test("a slow but progressing turn is never killed", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.submit("build it", "immediate");
        t.port.clear();

        for (let i = 0; i < 5; i++) {
          t.bridge.handle({
            type: "inference.text.delta",
            data: { token: `distinct progress update number ${i}\n` },
          });
          t.advance(500);
          t.tick();
        }

        expect(t.port.calls).toEqual([]);
      } finally {
        t.bridge.dispose();
      }
    });
  });
});

describe("reasoning settles to a summary", () => {
  test("a closed thinking row carries its elapsed time", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        for (const burst of [12_000, 12_000]) {
          t.bridge.handle({ type: "inference.start", data: {} });
          t.bridge.handle({
            type: "inference.thinking.delta",
            data: { token: "weighing the call sites" },
          });
          t.advance(burst);
          t.bridge.handle({ type: "inference.text.delta", data: { token: "done" } });
        }

        // Both bursts belong to one turn, so they share one row — and its
        // elapsed time is the turn's thinking, not the last burst's.
        const thoughts = t.shell.streamLog
          .filter((row) => row.meta === "thinking")
          .map((row) => row.thought);
        expect(thoughts).toHaveLength(1);
        expect(thoughts[0]?.ms).toBe(24_000);
      } finally {
        t.bridge.dispose();
      }
    });
  });

  test("a live thinking row stays open and unsettled", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h);
      try {
        t.bridge.handle({ type: "inference.start", data: {} });
        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "still going" },
        });
        const live = t.shell.streamLog.find((row) => row.meta === "thinking");
        expect(live?.streaming).toBe(true);
        expect(live?.thought).toBeUndefined();
      } finally {
        t.bridge.dispose();
      }
    });
  });
});
