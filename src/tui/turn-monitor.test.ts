/**
 * Bridge-level wiring for the progress label, quota auto-retry and stall
 * watchdog. The monitor clock is injected, so nothing here waits on wall time.
 */

import { describe, expect, test } from "bun:test";

import { attachSessionBridge, createRecordingPort } from "./runtime-bridge.js";
import { noticeText } from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import { withTestRenderer } from "./harness.js";
import { RUNTIME_FLASH_MS } from "./runtime-notices.js";
import { LIVE_WORD_MS } from "./chrome-state.js";
import {
  STALL_APPROVAL_RESUME_MESSAGE,
  STALL_NOTICE_MESSAGE,
  STALL_RECOVERY_MESSAGE,
} from "./stall-watchdog.js";

type Harness = Awaited<ReturnType<typeof setup>>;
type ShellOptions = Parameters<typeof createAppShell>[1];

async function setup(
  h: { renderer: Parameters<typeof createAppShell>[0] },
  shellOptions?: ShellOptions,
) {
  const shell = createAppShell(h.renderer, {
    terminal: { columns: 80, rows: 24 },
    wireKeys: false,
    run: "idle",
    ...shellOptions,
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

async function withHarness(
  run: (t: Harness) => void | Promise<void>,
  shellOptions?: ShellOptions,
) {
  await withTestRenderer(async (h) => {
    const t = await setup(h, shellOptions);
    try {
      await run(t);
    } finally {
      t.bridge.dispose();
    }
  });
}

function reachStallNotice(t: Harness) {
  t.bridge.submit("build it", "immediate");
  t.port.clear();
  t.advance(500);
  t.tick();
  expect(t.shell.statusFlash).toBe(STALL_NOTICE_MESSAGE);
}

function expectStallAbort(t: Harness, additionalMs: number) {
  t.advance(additionalMs);
  t.tick();
  expect(t.port.calls).toEqual([{ op: "interrupt" }]);
  expect(t.shell.statusFlash).toBe(STALL_RECOVERY_MESSAGE);
}

const quotaEvent = (retryAfterMs: number) => ({
  type: "inference.error",
  data: { error: { category: "quota_exhausted", retryAfterMs } },
});

describe("turn progress label", () => {
  test("tracks the live phase and clears when the run settles", async () => {
    await withHarness(async (t) => {
      expect(t.shell.lockupPhase).toBeNull();

      t.bridge.handle({ type: "inference.start", data: {} });
      // What the slot paints from this phase is asserted in the ramp paint
      // tests; here it is only that the phase itself tracks the run.
      expect(t.shell.lockupRampPhase).toBe("working");
      expect(t.shell.lockupPhase).toBe("working");

      t.bridge.handle({
        type: "inference.thinking.delta",
        data: { token: "hm" },
      });
      expect(t.shell.lockupPhase).toBe("working");

      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "hi" },
      });
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
    });
  });

  test("the bottom-left slot carries the phase and fades on each change", async () => {
    await withHarness(async (t) => {
      expect(t.shell.lockupPhase).toBeNull();

      t.bridge.handle({ type: "inference.start", data: {} });
      expect(t.shell.lockupPhase).toBe("working");
      const started = t.shell.lockupChangedMs;

      t.advance(LIVE_WORD_MS);
      t.bridge.handle({
        type: "inference.thinking.delta",
        data: { token: "hm" },
      });
      expect(t.shell.lockupPhase).toBe("warping");
      // A new word restamps the fade so the crossfade starts over.
      expect(t.shell.lockupChangedMs).toBeGreaterThan(started);

      t.bridge.handle({ type: "reactor.done", data: {} });
      expect(t.shell.lockupPhase).toBeNull();
    });
  });

  /** The shape a real chat turn actually has. A chat session emits no
   * `reactor.done` until it closes, so `connector.reply` is the only
   * terminal event the shell sees — the regression this covers left the
   * phase counting for the rest of the session. */
  test("a full turn with a tool clears the phase on connector.reply", async () => {
    await withHarness(async (t) => {
      t.bridge.handle({
        type: "message.received",
        data: { message: { content: "list the root" } },
      });
      t.bridge.handle({ type: "inference.start", data: {} });
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "I'll " },
      });
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "look." },
      });
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
        data: {
          result: { callId: "c1", name: "bash", content: "AGENTS.md" },
        },
      });

      t.bridge.handle({ type: "inference.start", data: {} });
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "done." },
      });
      t.bridge.handle({ type: "inference.done", data: {} });
      t.bridge.handle({
        type: "connector.reply",
        data: { content: "done." },
      });

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
    });
  });

  test("an interrupted turn clears the phase", async () => {
    await withHarness(async (t) => {
      t.bridge.handle({ type: "inference.start", data: {} });
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "hi" },
      });
      expect(t.shell.lockupPhase).not.toBeNull();

      t.bridge.interrupt();
      expect(t.shell.lockupPhase).toBeNull();
      t.advance(250);
      t.tick();
      expect(t.shell.lockupPhase).toBeNull();
    });
  });

  test("a reactor error clears the phase", async () => {
    await withHarness(async (t) => {
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
    });
  });

  test("an open permission overlay freezes the ramp and reads waiting", async () => {
    await withHarness(async (t) => {
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
    });
  });
});

describe("quota auto-retry", () => {
  test("counts down then resubmits the last prompt once", async () => {
    await withHarness(async (t) => {
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
      expect(t.port.calls).toEqual([
        { op: "sendImmediate", text: "run the build" },
      ]);
      expect(t.shell.statusFlash).toBe("rate limit cleared — resubmitting");

      // Window is closed — a later tick must not replay the prompt again.
      t.advance(60_000);
      t.tick();
      expect(t.port.calls.filter((c) => c.op === "sendImmediate")).toHaveLength(
        1,
      );
    });
  });

  test("the clear-and-resubmit flash expires on its own", async () => {
    const lapse: (() => void)[] = [];
    await withHarness(
      (t) => {
        t.bridge.submit("run the build", "immediate");
        t.port.clear();
        t.bridge.handle(quotaEvent(1_000));
        t.advance(10_000);
        t.tick();
        expect(t.shell.statusFlash).toBe("rate limit cleared — resubmitting");
        expect(lapse).toHaveLength(1);
        lapse[0]?.();
        expect(t.shell.statusFlash).toBeNull();
      },
      {
        flashSchedule: (fn, ms) => {
          expect(ms).toBe(RUNTIME_FLASH_MS);
          lapse.push(fn);
          return () => undefined;
        },
      },
    );
  });

  test("an interrupted turn is never replayed", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("run the build", "immediate");
      t.bridge.handle(quotaEvent(1_000));
      t.bridge.interrupt();
      t.port.clear();

      t.advance(10_000);
      t.tick();
      expect(t.port.calls).toEqual([]);
    });
  });
});

describe("stall watchdog", () => {
  test("says the run looks stuck long before it aborts anything", async () => {
    await withHarness(async (t) => {
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
    });
  });

  test("clears the notice once activity resumes, rather than leaving it up", async () => {
    await withHarness(async (t) => {
      reachStallNotice(t);

      // The model starts producing again — the notice must not linger past
      // the silence it was reporting. handle() itself has to take it down;
      // waiting for the next tick leaves a window where the turn can settle
      // and cancel the cadence, stranding the banner forever.
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "ok" },
      });
      expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
    });
  });

  test("clears the notice when the turn settles before the next tick", async () => {
    await withHarness(async (t) => {
      reachStallNotice(t);

      t.bridge.handle({ type: "inference.done", data: {} });
      // Cadence is cancelled on settle. The notice has to already be gone.
      expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
    });
  });

  test("aborts and flashes once a mid-stream hang crosses the stall timeout", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("build it", "immediate");
      // Tokens actually started flowing, then everything went silent —
      // the one shape auto-abort still acts on.
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "ok" },
      });
      t.port.clear();

      t.advance(500);
      t.tick();
      expect(t.port.calls).toEqual([]);

      expectStallAbort(t, 1_000);

      // The aborted turn is settled, so the watchdog does not re-fire.
      t.advance(10_000);
      t.tick();
      expect(t.port.calls).toHaveLength(1);
    });
  });

  // Awaiting the model's next token — after submit, after the last
  // outstanding tool call resolves, or after compact continuation re-entry —
  // still notices at the notice threshold, then auto-aborts at the stall
  // budget so a reply or continuation that never lands cannot freeze the turn.
  test("a wait right after submit auto-aborts once the stall budget elapses", async () => {
    await withHarness(async (t) => {
      reachStallNotice(t);
      expect(t.port.calls).toEqual([]);

      expectStallAbort(t, 1_000);
    });
  });

  test("post-tool-batch silence auto-aborts once the stall budget elapses", async () => {
    await withHarness(async (t) => {
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

      expectStallAbort(t, 1_500);
    });
  });

  test("post-compact continuation silence auto-aborts once the stall budget elapses", async () => {
    await withHarness(async (t) => {
      t.bridge.beginSystemContinuation("continue after compact");
      t.port.clear();

      expectStallAbort(t, 1_500);
    });
  });

  test("in-flight collect auto-aborts once the stall budget elapses", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("build it", "immediate");
      t.bridge.handle({
        type: "inference.tool_call.end",
        data: { name: "wait_agents", callId: "c1" },
      });
      t.port.clear();

      expectStallAbort(t, 1_500);
    });
  });

  test("an outstanding wait_agents call auto-aborts once the stall budget elapses", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("build it", "immediate");
      t.bridge.handle({
        type: "inference.tool_call.end",
        data: { name: "wait_agents", callId: "c1" },
      });
      t.port.clear();

      expectStallAbort(t, 1_500);
    });
  });

  test("an open gate is exempt no matter how long the operator takes", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("build it", "immediate");
      t.port.clear();
      t.bridge.gateOpened();

      // Far past the stall timeout — an operator reading an approval must
      // never have the run torn down underneath them.
      t.advance(20 * 60_000);
      t.tick();
      expect(t.port.calls).toEqual([]);
      expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
    });
  });

  test("a gate queued but not yet displayed gets the same exemption", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("build it", "immediate");
      t.port.clear();
      // The gate is raised but `shell.overlayKind` is unchanged — the
      // "queued behind another overlay" shape from gate-wire.ts, where the
      // gate is not nominally displayed yet.
      t.bridge.gateOpened();
      expect(t.shell.overlayKind).toBeNull();

      t.advance(20 * 60_000);
      t.tick();
      expect(t.port.calls).toEqual([]);
      expect(t.shell.statusFlash).not.toBe(STALL_NOTICE_MESSAGE);
    });
  });

  test("a live tool run is not treated as a stall", async () => {
    await withHarness(async (t) => {
      t.bridge.submit("build it", "immediate");
      t.bridge.handle({
        type: "inference.text.delta",
        data: { token: "ok" },
      });
      t.bridge.handle({
        type: "inference.tool_call.end",
        data: { name: "bash", callId: "c1" },
      });
      t.port.clear();

      t.advance(10_000);
      t.tick();
      expect(t.port.calls).toEqual([]);
    });
  });

  // The gate exemption and the parallel-tool-call exemption are independent
  // guards feeding the same stall check — a run with both outstanding must
  // stay exempt, and closing the gate while the tool call is still out must
  // not re-expose it to the clock.
  test("a gate open alongside a live sibling tool call stays exempt", async () => {
    await withHarness(async (t) => {
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
    });
  });
});

describe("stall recovery of a suspended approval", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  // A mid-stream hang past the stall budget: the one shape auto-abort acts on.
  function reachStallBudget(t: Harness) {
    t.bridge.submit("build it", "immediate");
    t.bridge.handle({ type: "inference.text.delta", data: { token: "ok" } });
    t.port.clear();
    t.advance(1_500);
  }

  function deferredRecovery(opts: { presents?: boolean } = {}) {
    const presents = opts.presents ?? true;
    let calls = 0;
    let settle!: (result: { handled: boolean; code: string }) => void;
    let fail!: (error: Error) => void;
    const recovery = (onPresenting: () => void) => {
      calls += 1;
      if (presents) onPresenting();
      return new Promise<{ handled: boolean; code: string }>(
        (resolve, reject) => {
          settle = resolve;
          fail = reject;
        },
      );
    };
    return {
      recovery,
      calls: () => calls,
      resolve: (handled: boolean, code = handled ? "resumed" : "refused") =>
        settle({ handled, code }),
      reject: (error: Error) => fail(error),
    };
  }

  test("a handled resume suppresses the interrupt and says what it is doing", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);

      t.tick();
      expect(d.calls()).toBe(1);
      expect(t.shell.statusFlash).toBe(STALL_APPROVAL_RESUME_MESSAGE);

      d.resolve(true);
      await flush();
      expect(t.port.calls).toEqual([]);
    });
  });

  test("a resume that cannot proceed falls back to the one interrupt", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);

      t.tick();
      d.resolve(false);
      await flush();
      expect(t.port.calls).toEqual([{ op: "interrupt" }]);
      expect(t.shell.statusFlash).toBe(STALL_RECOVERY_MESSAGE);
    });
  });

  test("a resume that throws falls back to the interrupt", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);

      t.tick();
      d.reject(new Error("boom"));
      await flush();
      expect(t.port.calls).toEqual([{ op: "interrupt" }]);
    });
  });

  test("duplicate ticks while a resume is out neither re-enter nor interrupt", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);

      t.tick();
      t.advance(250);
      t.tick();
      t.advance(250);
      t.tick();
      expect(d.calls()).toBe(1);
      expect(t.port.calls).toEqual([]);

      d.resolve(false);
      await flush();
      expect(t.port.calls).toEqual([{ op: "interrupt" }]);
    });
  });

  test("a wedged resume is bounded by one more stall budget", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);

      t.tick();
      t.advance(1_000);
      t.tick();
      expect(t.port.calls).toEqual([{ op: "interrupt" }]);

      // The late settle must not interrupt a second time.
      d.resolve(false);
      await flush();
      expect(t.port.calls).toHaveLength(1);
    });
  });

  test("an approval gate open past the resume budget is never aborted", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);
      t.tick();
      expect(d.calls()).toBe(1);

      // The re-presented approval is on screen and the operator takes their
      // time, well past the one-budget bound on an unanswered attempt.
      t.bridge.gateOpened();
      for (let i = 0; i < 5; i++) {
        t.advance(1_000);
        t.tick();
      }
      expect(t.port.calls).toEqual([]);
      expect(d.calls()).toBe(1);

      // They answer: the gate closes and the decision lands.
      t.bridge.gateClosed();
      d.resolve(true);
      await flush();
      t.tick();
      expect(t.port.calls).toEqual([]);
    });
  });

  // Warden regression: a gateOpened that flips the turn to "blocked" while the
  // watchdog's resume is still in-flight must make the stall-resume:timeout
  // firm abort unreachable. The resume is still out, so advancing past an
  // additional stall budget must neither record a stall-resume:timeout marker
  // nor interrupt the shown gate; the operator's late answer alone settles it.
  test("a gateOpened during a parked resume never falls through to the stall-resume:timeout firm abort", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);
      t.tick();
      expect(d.calls()).toBe(1);

      // The resumed approval is captured but not yet settled: the watchdog
      // attempt is in-flight when the gate is raised. gateOpened flips the
      // turn to "blocked" (turnStateGateOpened) so the stall clock stops.
      t.bridge.gateOpened();
      expect(t.bridge.turn.status).toBe("blocked");

      // A full additional stall budget passes while the operator reads the
      // still-shown gate. The in-flight resume must not hit the wedged-resume
      // firm abort: no stall-resume:timeout marker, and no interrupt.
      t.advance(1_500);
      t.tick();
      const paths = t.bridge.turnMarkers().map((marker) => marker.path);
      expect(paths).not.toContain("stall-resume:timeout");
      expect(t.port.calls).toEqual([]);
      expect(d.calls()).toBe(1);

      // The operator answers; the approval settles handled and the turn is
      // never interrupted.
      t.bridge.gateClosed();
      d.resolve(true);
      await flush();
      t.tick();
      expect(t.port.calls).toEqual([]);
    });
  });

  test("a late refusal after the operator answered does not interrupt", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);
      t.tick();

      t.bridge.gateOpened();
      t.advance(2_000);
      t.tick();
      t.bridge.gateClosed();
      // The answer restarted the stall clock, so the turn is live again.
      d.resolve(false);
      await flush();
      t.tick();
      expect(t.port.calls).toEqual([]);
    });
  });

  test("a refusal before presenting never flashes the resume status", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery({ presents: false });
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);

      t.tick();
      expect(t.shell.statusFlash).not.toBe(STALL_APPROVAL_RESUME_MESSAGE);
      d.resolve(false, "settlement-in-flight");
      await flush();
      expect(t.port.calls).toEqual([{ op: "interrupt" }]);
      expect(t.shell.statusFlash).toBe(STALL_RECOVERY_MESSAGE);
    });
  });

  test("a stall that ended does not make the next stall wait out a budget", async () => {
    await withHarness(async (t) => {
      const d = deferredRecovery();
      t.bridge.setSuspendedApprovalRecovery(d.recovery);
      reachStallBudget(t);
      t.tick();
      expect(d.calls()).toBe(1);

      // The turn makes progress, so the first stall is over.
      t.bridge.handle({ type: "inference.text.delta", data: { token: "go" } });
      t.tick();

      // The model falls silent again: this is a new stall with its own attempt.
      t.advance(1_500);
      t.tick();
      expect(d.calls()).toBe(2);
    });
  });

  test("no registered recovery keeps the plain abort", async () => {
    await withHarness(async (t) => {
      reachStallBudget(t);
      t.tick();
      expect(t.port.calls).toEqual([{ op: "interrupt" }]);
    });
  });
});

describe("repetition guard", () => {
  test("a slow but progressing turn is never killed", async () => {
    await withHarness(async (t) => {
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
    });
  });
});

describe("reasoning settles to a summary", () => {
  test("a closed thinking row carries its elapsed time", async () => {
    await withHarness(async (t) => {
      for (const burst of [12_000, 12_000]) {
        t.bridge.handle({ type: "inference.start", data: {} });
        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "weighing the call sites" },
        });
        t.advance(burst);
        t.bridge.handle({
          type: "inference.text.delta",
          data: { token: "done" },
        });
      }

      // Both bursts belong to one turn, so they share one row — its elapsed
      // time is the turn's thinking, not the last burst's.
      const thoughts = t.shell.streamLog
        .filter((row) => row.meta === "thinking")
        .map((row) => row.thought);
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0]?.ms).toBe(24_000);
    });
  });

  test("a live thinking row stays open and unsettled", async () => {
    await withHarness(async (t) => {
      t.bridge.handle({ type: "inference.start", data: {} });
      t.bridge.handle({
        type: "inference.thinking.delta",
        data: { token: "still going" },
      });
      const live = t.shell.streamLog.find((row) => row.meta === "thinking");
      expect(live?.streaming).toBe(true);
      expect(live?.thought).toBeUndefined();
    });
  });
});
