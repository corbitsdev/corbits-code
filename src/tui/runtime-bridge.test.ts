import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mailboxMailWakeLine } from "../subagent/mailbox-mail-drive.js";
import type { PermissionRequest } from "../permission/types.js";
import { defined } from "../../testkit/defined.js";
import { OPERATOR_ORIGINATED_FLAG } from "../agent/message-provenance.js";
import { buildShellBackgroundMessage } from "../session/runtime-assembly.js";
import {
  attachSessionBridge,
  createRecordingPort,
  mapReactorLike,
  type TaskProgressSession,
  type TurnMonitorOptions,
  PARKED_CALL_NOT_RUN,
} from "./runtime-bridge";
import { DEFAULT_STALL_MS } from "../subagent/agent-progress.js";
import { appendStreamRow, paintChrome } from "./shell/chrome";
import {
  getShellBridgeHooks,
  type AppShell,
  type AppShellOptions,
} from "./shell/internals";
import { streamRowCount } from "./shell/transcript";
import { STEER_WAIT_NOTICE_MS } from "./notice-line";
import type { Harness } from "./harness";
import { withAppShell } from "./test-helpers";
import { operatorCancelResult, wireGates } from "./gate-wire.js";
import { acceptOverlaySelection } from "./shell/overlay-host.js";
import { moveOverlaySelection } from "./shell/overlay-list.js";
import {
  badgeCount,
  isPaused,
  SESSION_IDENTITY_ABORT_REASON,
} from "./delivery-queue";
import { LIVE_ACTIVITY_WORDS } from "./chrome-state";

type RecordingPort = ReturnType<typeof createRecordingPort>;

type BridgeCtx = {
  readonly h: Harness;
  readonly shell: AppShell;
  readonly port: RecordingPort;
  readonly bridge: ReturnType<typeof attachSessionBridge>;
  readonly emitter: EventEmitter;
};

type BridgeOpts = {
  readonly run?: NonNullable<AppShellOptions["run"]>;
  readonly wireKeys?: boolean;
  readonly port?: Parameters<typeof createRecordingPort>[0];
  readonly monitor?: TurnMonitorOptions;
  readonly gates?: boolean;
};

async function withBridge(
  opts: BridgeOpts,
  fn: (ctx: BridgeCtx) => Promise<void> | void,
): Promise<void> {
  await withAppShell(
    async (shell, h) => {
      const emitter = new EventEmitter();
      const disposeGates =
        opts.gates === true ? wireGates(emitter, shell) : undefined;
      const port = createRecordingPort(opts.port);
      const bridge = attachSessionBridge(shell, port, opts.monitor);
      try {
        await fn({ h, shell, emitter, port, bridge });
      } finally {
        bridge.dispose();
        disposeGates?.();
      }
    },
    {
      shell: { wireKeys: opts.wireKeys ?? false, run: opts.run ?? "idle" },
    },
  );
}

type BridgeClock = {
  nowMs: number;
  readonly tick: (() => void) | undefined;
};

async function clockedBridge(
  opts: Omit<BridgeOpts, "monitor"> & {
    readonly monitor?: Omit<TurnMonitorOptions, "now" | "schedule">;
  },
  fn: (
    ctx: BridgeCtx & { readonly clock: BridgeClock },
  ) => Promise<void> | void,
): Promise<void> {
  let nowMs = 0;
  let tick: (() => void) | undefined;
  const clock: BridgeClock = {
    get nowMs() {
      return nowMs;
    },
    set nowMs(next: number) {
      nowMs = next;
    },
    get tick() {
      return tick;
    },
  };
  await withBridge(
    {
      ...opts,
      monitor: {
        ...opts.monitor,
        now: () => nowMs,
        schedule: (nextTick) => {
          tick = nextTick;
          return () => {
            tick = undefined;
          };
        },
      },
    },
    (ctx) => fn({ ...ctx, clock }),
  );
}

/** A tool-less turn settles on inference.done — the spawn_agent shape. */
function settleToollessTurn(
  bridge: ReturnType<typeof attachSessionBridge>,
): void {
  bridge.handle({ type: "inference.start", data: {} });
  bridge.handle({ type: "inference.done", data: {} });
}

const DRY_OPEN_TASK_PROMPT =
  "The fleet has gone dry. Remaining open tasks:\n- t1: keep going (todo)\n";

/** Install a counting fleet-dry driver; returns the live drive count. */
function installDryDriver(
  bridge: ReturnType<typeof attachSessionBridge>,
): () => number {
  let drives = 0;
  bridge.setDryOpenTaskDriver(() => {
    drives += 1;
    bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
    return true;
  });
  return () => drives;
}

describe("mapReactorLike", () => {
  test("operator-originated message.received → user", () => {
    expect(
      mapReactorLike({
        type: "message.received",
        data: {
          message: { content: "hi", flags: [OPERATOR_ORIGINATED_FLAG] },
        },
      }),
    ).toEqual([{ type: "user", text: "hi" }]);
  });

  test("system-originated message.received → system", () => {
    expect(
      mapReactorLike({
        type: "message.received",
        data: { message: { content: "hi" } },
      }),
    ).toEqual([{ type: "system", text: "hi" }]);
  });

  test("mapReactorLike tool.done types", () => {
    const mapped = mapReactorLike({
      type: "tool.done",
      data: {
        result: {
          callId: "c1",
          name: "bash",
          content: "ok",
          isError: false,
        },
      },
    });
    expect(mapped.map((e) => e.type)).toEqual(["tool_result", "tool.boundary"]);
  });

  test("unknown types map to empty", () => {
    expect(mapReactorLike({ type: "inference.usage", data: {} })).toEqual([]);
  });
});

describe("attachSessionBridge", () => {
  test("background shell exit paints as a system row", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const message = buildShellBackgroundMessage({
        id: "sh_1",
        command: "sleep 0.1",
        exitCode: 0,
        timedOut: false,
        output: "done",
      });
      bridge.handle({
        type: "message.received",
        data: { message },
      });
      expect(shell.streamLog.filter((r) => r.role === "user")).toHaveLength(0);
      expect(
        shell.streamLog.filter(
          (r) => r.role === "system" && r.text === message.content,
        ),
      ).toHaveLength(1);
    });
  });

  test("Enter mid-run hits port.enqueue; badge tracks depth", async () => {
    await withBridge(
      { run: "busy", wireKeys: true },
      async ({ h, shell, port }) => {
        shell.prompt.value = "queued please";
        shell.prompt.submit();
        await h.renderOnce();
        expect(port.calls.some((c) => c.op === "enqueue")).toBe(true);
        const enq = port.calls.find((c) => c.op === "enqueue");
        // Plain Enter mid-run soft-steers. Follow-up is Alt+Enter.
        expect(enq).toEqual({
          op: "enqueue",
          text: "queued please",
          kind: "steer",
        });
        expect(badgeCount(shell.session)).toBe(1);
        expect(shell.pendingQueue).toBe(1);
        const frame = h.captureCharFrame();
        expect(frame).toContain("queued please");
      },
    );
  });

  test("Alt+Enter mid-run enqueues follow-up (queue), never interrupts", async () => {
    await withBridge({ run: "busy" }, async ({ h, shell, port, bridge }) => {
      // Direct bridge path (Alt+Enter chord is terminal-dependent in mock).
      bridge.submit("follow up later", "queue");
      await h.renderOnce();
      expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
      expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(false);
      expect(port.calls.some((c) => c.op === "enqueue")).toBe(true);
      const enq = port.calls.find((c) => c.op === "enqueue");
      expect(enq).toEqual({
        op: "enqueue",
        text: "follow up later",
        kind: "queue",
      });
      expect(shell.session.run).toBe("busy");
      expect(badgeCount(shell.session)).toBe(1);
      const frame = h.captureCharFrame();
      expect(frame).toContain("follow up later");
    });
  });

  test("Ctrl+C hits port.interrupt, pauses (CL-10149) and holds the queue", async () => {
    await withBridge(
      { run: "busy", wireKeys: true },
      async ({ h, shell, port, bridge }) => {
        bridge.submit("a", "queue");
        bridge.submit("b", "steer");
        expect(badgeCount(shell.session)).toBe(2);
        port.clear();
        // Operator first-press Ctrl+C routes through the pause gesture.
        h.pressKey("c", { ctrl: true });
        await h.renderOnce();
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);
        expect(shell.session.interruptFlash).toBe(true);
        expect(shell.session.run).toBe("idle");
        // First Ctrl+C is a PAUSE (CL-10149): the queue stays held, nothing
        // auto-drains onto a rebuilt agent. Delivered only on an explicit send.
        expect(isPaused(shell.session)).toBe(true);
        expect(badgeCount(shell.session)).toBe(2);
        expect(
          port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : [])),
        ).toEqual([]);
        // An explicit new send clears the pause and the boundary drains the
        // held items onto the fresh turn.
        bridge.submit("fresh", "immediate");
        bridge.handle({ type: "run", state: "idle" });
        expect(
          port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : [])),
        ).toEqual(["b", "a"]);
        expect(badgeCount(shell.session)).toBe(0);
      },
    );
  });

  test("local classify keeps idle submits off the busy path", async () => {
    await withBridge(
      {
        run: "idle",
        port: {
          classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
        },
      },
      async ({ h, shell, port, bridge }) => {
        bridge.submit("/feedback quick test", "immediate");
        await h.renderOnce();
        expect(port.calls).toEqual([
          { op: "sendImmediate", text: "/feedback quick test" },
        ]);
        expect(shell.session.run).toBe("idle");
        expect(badgeCount(shell.session)).toBe(0);
      },
    );
  });

  test("local classify mid-run does not enqueue or interrupt the agent turn", async () => {
    await withBridge(
      {
        run: "busy",
        port: {
          classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
        },
      },
      async ({ h, shell, port, bridge }) => {
        bridge.submit("/feedback note", "queue");
        await h.renderOnce();
        expect(port.calls).toEqual([
          { op: "sendImmediate", text: "/feedback note" },
        ]);
        expect(port.calls.some((c) => c.op === "enqueue")).toBe(false);
        expect(shell.session.run).toBe("busy");
        expect(badgeCount(shell.session)).toBe(0);
      },
    );
  });

  test("steer delivers at tool.boundary; follow-up does not", async () => {
    await withBridge({ run: "busy" }, async ({ h, shell, port, bridge }) => {
      bridge.submit("steer now", "steer");
      bridge.submit("follow up", "queue");
      expect(badgeCount(shell.session)).toBe(2);
      port.clear();
      bridge.handle({
        type: "tool.done",
        data: {
          result: {
            callId: "c9",
            name: "bash",
            content: "ok",
            isError: false,
          },
        },
      });
      // Soft steer drained; follow-up still pending.
      expect(badgeCount(shell.session)).toBe(1);
      expect(defined(shell.session.items[0], "queued item").kind).toBe("queue");
      const deliver = port.calls.find((c) => c.op === "deliver");
      expect(deliver).toEqual({
        op: "deliver",
        item: expect.objectContaining({
          text: "steer now",
          kind: "steer",
        }),
      });
      await h.renderOnce();
      const frame = h.captureCharFrame();
      expect(frame).toContain("steer now");
      expect(frame).toContain("follow up");
    });
  });

  test("onForceDeliver removes the item and delivers it now", async () => {
    await withBridge({ run: "busy" }, async ({ h, shell, port, bridge }) => {
      bridge.submit("steer now", "steer");
      bridge.submit("follow up", "queue");
      port.clear();
      const held = defined(shell.session.items[0], "queued item");
      getShellBridgeHooks(shell)?.onForceDeliver?.(held.id);
      expect(shell.session.items.map((i) => i.text)).toEqual(["follow up"]);
      expect(port.calls).toEqual([
        {
          op: "deliver",
          item: expect.objectContaining({ text: "steer now" }),
        },
      ]);
      await h.renderOnce();
      const frame = h.captureCharFrame();
      expect(frame).toContain("steer now");
    });
  });

  test("steer is not delivered while a parent tool is in flight", async () => {
    await withBridge({ run: "busy" }, async ({ shell, port, bridge }) => {
      bridge.handle({
        type: "tool.start",
        data: { call: { id: "c1", name: "run_shell" } },
      });
      bridge.submit("steer now", "steer");
      expect(port.calls.some((c) => c.op === "deliver")).toBe(false);
      expect(badgeCount(shell.session)).toBe(1);
    });
  });

  test("notice names the in-flight command after STEER_WAIT_NOTICE_MS", async () => {
    await clockedBridge(
      { run: "busy" },
      async ({ h, shell, bridge, clock }) => {
        bridge.handle({
          type: "tool.start",
          data: { call: { id: "c1", name: "run_shell" } },
        });
        bridge.submit("steer now", "steer");

        clock.nowMs = STEER_WAIT_NOTICE_MS - 1;
        shell.lockupNowMs = clock.nowMs;
        paintChrome(shell);
        await h.renderOnce();
        expect(h.captureCharFrame()).not.toContain("waiting on");

        clock.nowMs = STEER_WAIT_NOTICE_MS;
        shell.lockupNowMs = clock.nowMs;
        paintChrome(shell);
        await h.renderOnce();
        expect(h.captureCharFrame()).toContain("waiting on");

        bridge.handle({ type: "tool.boundary" });
        bridge.submit("follow up", "queue");
        clock.nowMs = 5000;
        shell.lockupNowMs = clock.nowMs;
        paintChrome(shell);
        await h.renderOnce();
        expect(h.captureCharFrame()).not.toContain("waiting on");
      },
    );
  });

  test("follow-up drains on idle, after any remaining steers", async () => {
    await withBridge({ run: "busy" }, async ({ h, shell, port, bridge }) => {
      bridge.submit("follow up", "queue");
      bridge.submit("late steer", "steer");
      expect(badgeCount(shell.session)).toBe(2);
      port.clear();
      bridge.handle({ type: "run", state: "idle" });
      expect(badgeCount(shell.session)).toBe(0);
      expect(
        port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : [])),
      ).toEqual(["late steer", "follow up"]);
      await h.renderOnce();
      const frame = h.captureCharFrame();
      expect(frame).toContain("follow up");
      expect(frame).toContain("late steer");
    });
  });

  test("queued item delivers on a tool-less turn (inference.done, no tool calls)", async () => {
    // Regression: reactor.done fires only once, at agent shutdown, never
    // between turns — a plain-text reply with no tool calls must still drain
    // the queue, or a queued message sits forever.
    await withBridge({ run: "busy" }, async ({ shell, port, bridge }) => {
      bridge.submit("follow up", "queue");
      expect(badgeCount(shell.session)).toBe(1);
      port.clear();
      bridge.handle({ type: "inference.start" });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "hi" },
      });
      bridge.handle({ type: "inference.done" });
      expect(badgeCount(shell.session)).toBe(0);
      const deliver = port.calls.find((c) => c.op === "deliver");
      expect(deliver).toEqual({
        op: "deliver",
        item: expect.objectContaining({
          text: "follow up",
          kind: "queue",
        }),
      });
    });
  });

  test("run and the phase ramp both return to idle after a tool-less inference.done, with no connector.reply", async () => {
    // Regression: a self-continuing workflow may never emit connector.reply,
    // the only other event that clears `run` and `isProcessing`. Without this,
    // every future Enter resolves to "queue" (busy is sticky), the queued
    // message is never drained, and the ramp can say "working" forever.
    await withBridge({ run: "busy" }, async ({ shell, port, bridge }) => {
      bridge.handle({ type: "inference.start" });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "hi" },
      });
      bridge.handle({ type: "inference.done" });
      expect(shell.session.run).toBe("idle");
      expect(shell.lockupPhase).toBeNull();

      port.clear();
      bridge.submit("are you still there", "queue");
      expect(port.calls).toEqual([
        { op: "sendImmediate", text: "are you still there" },
      ]);
    });
  });

  test("run stays busy after inference.done while a tool call is still outstanding", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      bridge.handle({ type: "inference.start" });
      bridge.handle({
        type: "inference.tool_call.start",
        data: { call: { id: "c1", name: "bash" } },
      });
      bridge.handle({ type: "inference.done" });
      expect(shell.session.run).toBe("busy");
    });
  });

  test("token-by-token deltas grow one assistant row", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const tokens = "Hello there, this is one streamed reply.".split(" ");
      bridge.handle({ type: "inference.start", data: {} });
      for (const token of tokens) {
        bridge.handle({
          type: "inference.text.delta",
          data: { token: `${token} ` },
        });
      }
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "reactor.done", data: {} });

      const assistant = shell.streamLog.filter((r) => r.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.text.trim()).toBe(
        "Hello there, this is one streamed reply.",
      );
      expect(assistant[0]?.streaming).toBe(false);
    });
  });

  test("inference.text.delta opens a live assistant streaming row mid-turn", async () => {
    await withBridge({ run: "idle" }, async ({ h, shell, bridge }) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.thinking.delta",
        data: { token: "planning the reply" },
      });
      bridge.handle({
        type: "inference.tool_call.end",
        data: { name: "run_shell", callId: "c1", arguments: "{}" },
      });
      bridge.handle({
        type: "tool.done",
        data: { result: { callId: "c1", content: "ok", isError: false } },
      });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "Here is " },
      });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "the answer." },
      });
      // Deltas coalesce: the accumulated text lands at the next renderer
      // frame, not per token.
      await h.renderOnce();

      const assistant = shell.streamLog.filter((r) => r.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0]?.streaming).toBe(true);
      expect(assistant[0]?.text).toBe("Here is the answer.");
      // Still one thinking row for the turn — no third mid-turn stream lane.
      expect(shell.streamLog.filter((r) => r.meta === "thinking")).toHaveLength(
        1,
      );
    });
  });

  test("thinking deltas coalesce and never become plain system rows", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.handle({ type: "inference.start", data: {} });
      for (const token of ["The ", "user ", "said ", "hi."]) {
        bridge.handle({
          type: "inference.thinking.delta",
          data: { token },
        });
      }
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "Hi!" },
      });
      bridge.handle({ type: "reactor.done", data: {} });

      const system = shell.streamLog.filter((r) => r.role === "system");
      expect(system.every((r) => r.meta === "thinking")).toBe(true);
      const thinking = system.filter((r) => r.meta === "thinking");
      expect(thinking).toHaveLength(1);
      expect(thinking[0]?.text).toBe("The user said hi.");
      expect(
        shell.streamLog.filter((r) => r.role === "assistant"),
      ).toHaveLength(1);
    });
  });

  test("a submitted prompt echoes exactly once", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.submit("hi", "immediate");
      // The runtime replays the accepted prompt back onto the event stream.
      bridge.handle({
        type: "message.received",
        data: { message: { content: "hi" } },
      });
      expect(
        shell.streamLog.filter((r) => r.role === "user" && r.text === "hi"),
      ).toHaveLength(1);
    });
  });
});

describe("failed sends", () => {
  test("a resolved terminal provider failure is render-only and resets", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      const rawDiagnostic =
        "\u001b[31mupstream 401:\n secret response body\u001b[0m";
      const normalReply = "The next request worked.";
      bridge.setInferenceProviderId("codex/default", "Codex");
      bridge.handle({ type: "inference.start", data: { model: "gpt" } });
      bridge.handle({
        type: "inference.error",
        data: {
          error: { category: "credential_failure", message: rawDiagnostic },
        },
      });
      bridge.handle({
        type: "connector.reply",
        data: { content: rawDiagnostic },
      });
      bridge.handle({ type: "inference.start", data: { model: "gpt" } });
      bridge.handle({
        type: "connector.reply",
        data: { content: normalReply },
      });

      expect(
        shell.streamLog.filter((row) =>
          row.text.includes("credential_failure"),
        ),
      ).toHaveLength(1);
      expect(
        shell.streamLog.filter((row) => row.text === normalReply),
      ).toHaveLength(1);
      expect(shell.streamLog.map((row) => row.text).join("\n")).not.toContain(
        "\u001b",
      );
      expect(port.calls).toEqual([]);
    });
  });
});

describe("committed inference retry", () => {
  /** The reactor re-streams a committed attempt after a same-source quota
   * retry, so the transcript must retract the failed attempt rather than
   * append the replay underneath it. */
  const COMMITTED_RETRY_EVENTS = [
    { type: "inference.start", data: {} },
    { type: "inference.text.delta", data: { token: "partial answer" } },
    {
      type: "inference.tool_call.end",
      data: { name: "bash", callId: "c1", arguments: { command: "ls" } },
    },
    {
      type: "inference.error",
      data: { error: { category: "quota_exhausted", message: "rate limited" } },
    },
    { type: "inference.retry", data: { attempt: 1, delayMs: 0 } },
    { type: "inference.start", data: {} },
    { type: "inference.text.delta", data: { token: "final answer" } },
    { type: "inference.done", data: {} },
    { type: "reactor.done", data: {} },
  ] as const;

  test("does not duplicate the failed attempt's text or strand its tool row", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      for (const event of COMMITTED_RETRY_EVENTS) bridge.handle(event);

      const text = shell.streamLog.map((r) => r.text).join("\n");
      expect(text).toContain("final answer");
      expect(text).not.toContain("partial answer");
      expect(shell.streamLog.filter((r) => r.pending)).toEqual([]);
    });
  });
});

describe("same-turn retry after inference.error", () => {
  const errorRows = (shell: {
    streamLog: readonly { role: string; meta?: string; text: string }[];
  }) => shell.streamLog.filter((r) => r.meta === "error").map((r) => r.text);

  test("a recovered quota error does not stay in the transcript", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      for (const event of [
        { type: "inference.start", data: {} },
        {
          type: "inference.error",
          data: {
            error: {
              category: "quota_exhausted",
              message: "The usage limit has been reached",
              statusCode: 429,
            },
          },
        },
        { type: "inference.start", data: {} },
        { type: "inference.text.delta", data: { token: "recovered" } },
        { type: "inference.done", data: {} },
        { type: "reactor.done", data: {} },
      ] as const) {
        bridge.handle(event);
      }

      expect(errorRows(shell)).toEqual([]);
      expect(shell.streamLog.map((r) => r.text).join("\n")).toContain(
        "recovered",
      );
    });
  });

  test("an echoed auto-retry prompt does not expire recovery", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      bridge.submit("retry this", "immediate");
      bridge.handle({
        type: "message.received",
        data: { message: { content: "retry this" } },
      });
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.error",
        data: {
          error: {
            category: "quota_exhausted",
            message: "The usage limit has been reached",
            statusCode: 429,
          },
        },
      });
      bridge.submit("retry this", "immediate");
      bridge.handle({
        type: "message.received",
        data: { message: { content: "retry this" } },
      });
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "recovered" },
      });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "reactor.done", data: {} });

      expect(errorRows(shell)).toEqual([]);
      expect(shell.streamLog.map((r) => r.text).join("\n")).toContain(
        "recovered",
      );
      // The replay duplicates the operator's prompt; rollback drops the copy.
      expect(
        shell.streamLog.filter((r) => r.role === "user").map((r) => r.text),
      ).toEqual(["retry this"]);
      // Same-turn retry, not an operator stop — must not borrow interrupt.
      expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
      expect(shell.streamLog.some((r) => r.meta === "stop")).toBe(false);
    });
  });

  test("a steer echo at a tool boundary opens a new thinking row", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.submit("first prompt", "immediate");
      bridge.handle({
        type: "message.received",
        data: { message: { content: "first prompt" } },
      });
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.thinking.delta",
        data: { token: "planning" },
      });
      bridge.handle({
        type: "inference.tool_call.end",
        data: { name: "run_shell", callId: "c1", arguments: "{}" },
      });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.submit("steer this", "steer");
      bridge.handle({
        type: "tool.done",
        data: { result: { callId: "c1", content: "ok", isError: false } },
      });
      bridge.handle({
        type: "message.received",
        data: { message: { content: "steer this" } },
      });
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.thinking.delta",
        data: { token: "after steer" },
      });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "done" },
      });

      const rows = shell.streamLog.map((r) => `${r.meta ?? r.role}:${r.text}`);
      expect(rows.indexOf("thinking:planning")).toBeGreaterThan(-1);
      expect(rows.indexOf("user:steer this")).toBeGreaterThan(
        rows.indexOf("thinking:planning"),
      );
      expect(rows.indexOf("thinking:after steer")).toBeGreaterThan(
        rows.indexOf("user:steer this"),
      );
      expect(shell.streamLog.filter((r) => r.meta === "thinking")).toHaveLength(
        2,
      );
    });
  });

  test("interrupt then a new prompt keeps the prompt and the classified error", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.error",
        data: {
          error: {
            category: "credential_failure",
            message: "Forbidden",
            statusCode: 403,
          },
        },
      });
      bridge.interrupt();
      bridge.submit("next prompt", "immediate");
      bridge.handle({
        type: "message.received",
        data: { message: { content: "next prompt" } },
      });
      bridge.handle({ type: "inference.start", data: {} });

      const text = shell.streamLog.map((r) => r.text).join("\n");
      expect(text).toContain("next prompt");
      expect(errorRows(shell)).toEqual([]);
    });
  });

  test("a queued steer row survives retry rollback", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.error",
        data: {
          error: {
            category: "credential_failure",
            message: "Forbidden",
            statusCode: 403,
          },
        },
      });
      bridge.submit("steer this", "steer");
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "recovered" },
      });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "reactor.done", data: {} });

      const text = shell.streamLog.map((r) => r.text).join("\n");
      expect(errorRows(shell)).toEqual([]);
      expect(text).toContain("recovered");
      expect(text).toContain("steer this");
    });
  });

  test("a boundary-delivered steer row survives retry rollback", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      bridge.submit("start work", "immediate");
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "tool.start",
        data: { call: { id: "c1", name: "run_shell" } },
      });
      bridge.submit("steer now", "steer");
      // The parent tool finishes: the steer delivers at the boundary,
      // painting its transcript row after the armed attempt mark.
      bridge.handle({ type: "tool.boundary" });
      expect(port.calls.some((c) => c.op === "deliver")).toBe(true);
      // Same-attempt failure: the retry rolls back to the attempt mark. The
      // delivered row must survive — retracting it would show a transcript
      // the runtime never saw.
      bridge.handle({
        type: "inference.error",
        data: {
          error: {
            category: "credential_failure",
            message: "Forbidden",
            statusCode: 403,
          },
        },
      });
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "recovered" },
      });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "reactor.done", data: {} });

      const text = shell.streamLog.map((r) => r.text).join("\n");
      expect(errorRows(shell)).toEqual([]);
      expect(text).toContain("recovered");
      expect(text).toContain("steer now");
    });
  });

  test("reinject interrupt keeps the prompt and the classified error", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.error",
        data: {
          error: {
            category: "credential_failure",
            message: "Forbidden",
            statusCode: 403,
          },
        },
      });
      bridge.submit("restart from here", "reinject");
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.text.delta",
        data: { token: "recovered" },
      });
      bridge.handle({ type: "inference.done", data: {} });
      bridge.handle({ type: "reactor.done", data: {} });

      const text = shell.streamLog.map((r) => r.text).join("\n");
      expect(text).toContain("restart from here");
      // Reinject interrupts are pause-oriented (CL-10149): the stop note reuses
      // the pause wording ("pending kept"/"stopped" + the arming flash) and
      // never says "restart from your message" anymore.
      expect(text).toMatch(
        /(pending kept|stopped).*press ctrl\+c again to exit/,
      );
      expect(text).not.toContain("restarting from your message");
      expect(errorRows(shell)).toEqual([]);
    });
  });

  test("reactor.error still surfaces after a terminal inference.error", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      for (const event of [
        { type: "inference.start", data: {} },
        {
          type: "inference.error",
          data: {
            error: {
              category: "credential_failure",
              message: "Forbidden",
              statusCode: 403,
            },
          },
        },
        { type: "reactor.error", data: { error: "failed" } },
      ] as const) {
        bridge.handle(event);
      }

      expect(errorRows(shell)).toEqual(["failed"]);
    });
  });
});

describe("parallel sub-agent dispatch on the live session bridge", () => {
  // The live main-session path tracks a call's row by callId
  // (applyToolCall/applyToolResult), independent of tool-rows.ts's name-based
  // pendingCallIndex — pinned so a change to either path cannot silently
  // reintroduce misattribution on the parent transcript.
  test("three parallel spawn_agent calls resolve to three rows, each with its own result", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const events = [
        { type: "inference.start", data: {} },
        {
          type: "inference.tool_call.end",
          data: {
            name: "spawn_agent",
            callId: "c1",
            arguments: { description: "Fix CL-5559" },
          },
        },
        {
          type: "inference.tool_call.end",
          data: {
            name: "spawn_agent",
            callId: "c2",
            arguments: { description: "Fix CL-5560" },
          },
        },
        {
          type: "inference.tool_call.end",
          data: {
            name: "spawn_agent",
            callId: "c3",
            arguments: { description: "Fix CL-5561" },
          },
        },
        { type: "inference.done", data: {} },
        {
          type: "tool.start",
          data: { call: { id: "c1", name: "spawn_agent" } },
        },
        {
          type: "tool.start",
          data: { call: { id: "c2", name: "spawn_agent" } },
        },
        {
          type: "tool.start",
          data: { call: { id: "c3", name: "spawn_agent" } },
        },
        // Completion order does not follow dispatch order.
        {
          type: "tool.done",
          data: {
            result: {
              callId: "c2",
              name: "spawn_agent",
              content: "done c2",
            },
          },
        },
        {
          type: "tool.done",
          data: {
            result: {
              callId: "c1",
              name: "spawn_agent",
              content: "done c1",
            },
          },
        },
        {
          type: "tool.done",
          data: {
            result: {
              callId: "c3",
              name: "spawn_agent",
              content: "done c3",
            },
          },
        },
        { type: "reactor.done", data: {} },
      ] as const;
      for (const event of events) bridge.handle(event);

      const toolRows = shell.streamLog.filter((r) => r.role === "tool");
      expect(toolRows.length).toBe(3);
      expect(toolRows.every((r) => r.pending !== true)).toBe(true);
      expect(toolRows.every((r) => r.failed !== true)).toBe(true);
      expect(toolRows.map((r) => r.text)).toEqual([
        "done c1",
        "done c2",
        "done c3",
      ]);
    });
  });
});

describe("Ctrl+C on a decision gate", () => {
  const shellRequest = (subject: string): PermissionRequest => ({
    tool: "run_shell",
    action: "Run shell command",
    subject,
    scopes: [],
  });

  function emitPermissionGate(
    emitter: EventEmitter,
    id: string,
    signal?: AbortSignal,
  ) {
    let outcome: unknown;
    emitter.emit("permission.gate", {
      id,
      request: shellRequest(`touch ${id}`),
      resolve: (value: unknown) => {
        outcome = value;
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    return () => outcome;
  }

  test("declines the open permission gate and interrupts the turn", async () => {
    await withBridge(
      { run: "busy", wireKeys: true, gates: true },
      async ({ h, shell, port, emitter }) => {
        const outcome = emitPermissionGate(emitter, "req-1");
        expect(shell.overlayKind).toBe("permissions");
        port.clear();

        h.pressKey("c", { ctrl: true });
        await h.renderOnce();

        expect(outcome()).toEqual({ allow: false });
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);
        expect(shell.overlayList).toBeNull();
      },
    );
  });

  test("interrupts even when the shell does not read as busy", async () => {
    // A turn started by a delivered message (a background shell exit, a
    // worker wake) can park on a gate without a composer send marking busy.
    await withBridge(
      { run: "idle", wireKeys: true, gates: true },
      async ({ h, port, emitter }) => {
        const outcome = emitPermissionGate(emitter, "req-1");
        port.clear();

        h.pressKey("c", { ctrl: true });
        await h.renderOnce();

        expect(outcome()).toEqual({ allow: false });
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);
      },
    );
  });

  test("queued gates drop with the interrupt instead of taking over the prompt", async () => {
    await withBridge(
      { run: "busy", wireKeys: true, gates: true },
      async ({ h, shell, port, emitter }) => {
        // Production gates share the session identity signal, which the
        // interrupt's delivery-generation bump aborts.
        const identity = new AbortController();
        const first = emitPermissionGate(emitter, "req-1", identity.signal);
        const queued = emitPermissionGate(emitter, "req-2", identity.signal);
        port.clear();

        h.pressKey("c", { ctrl: true });
        await h.renderOnce();
        expect(first()).toEqual({ allow: false });
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);

        identity.abort(SESSION_IDENTITY_ABORT_REASON);
        await h.renderOnce();
        expect(queued()).toEqual({
          allow: false,
          message: SESSION_IDENTITY_ABORT_REASON,
        });
        expect(shell.overlayList).toBeNull();
      },
    );
  });

  test("declines an open operator question and interrupts the turn", async () => {
    await withBridge(
      { run: "busy", wireKeys: true, gates: true },
      async ({ h, port, emitter }) => {
        let outcome: unknown;
        emitter.emit("operator.gate", {
          id: "ask-1",
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: (value: unknown) => {
            outcome = value;
          },
        });
        port.clear();

        h.pressKey("c", { ctrl: true });
        await h.renderOnce();

        expect(outcome).toEqual(operatorCancelResult());
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);
      },
    );
  });

  test("Esc still declines only the open gate and leaves the turn running", async () => {
    await withBridge(
      { run: "busy", wireKeys: true, gates: true },
      async ({ h, port, emitter }) => {
        const outcome = emitPermissionGate(emitter, "req-1");
        port.clear();

        // ESC needs a disambiguation delay on the mock stdin path.
        h.pressKey("Escape");
        await new Promise((r) => setTimeout(r, 60));
        await h.renderOnce();

        expect(outcome()).toEqual({ allow: false });
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
      },
    );
  });
});

describe("calls parked on an approval gate", () => {
  type Event = { type: string; data?: unknown };

  const toolCall = (id: string): Event[] => [
    {
      type: "inference.tool_call.start",
      data: { callId: id, name: "run_shell" },
    },
    {
      type: "inference.tool_call.end",
      data: {
        name: "run_shell",
        callId: id,
        arguments: JSON.stringify({ command: `touch ${id}` }),
      },
    },
  ];
  const gateBlocked = (reason = "approval"): Event => ({
    type: "reactor.gate.blocked",
    data: { reason, gateId: "gate-1", correlationId: "corr-1" },
  });
  // The reactor re-infers once the parked call is answered.
  const followUpReply: Event[] = [
    { type: "inference.start", data: {} },
    { type: "inference.text.delta", data: { token: "It was not run." } },
    { type: "inference.done", data: {} },
    { type: "connector.reply", data: { content: "It was not run." } },
  ];
  const toolRow = (shell: { streamLog: readonly { role: string }[] }) =>
    shell.streamLog.filter((r) => r.role === "tool") as unknown as {
      text: string;
      pending?: boolean;
      failed?: boolean;
    }[];

  test("a call answered without running is closed as not run and the turn settles", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      const events: Event[] = [
        { type: "inference.start", data: {} },
        ...toolCall("c1"),
        { type: "inference.done", data: {} },
        gateBlocked(),
      ];
      for (const event of events) bridge.handle(event);
      expect(shell.session.run).toBe("busy");

      // Rejected, timed out or dropped: no tool.done, just the re-inference.
      for (const event of followUpReply) bridge.handle(event);

      expect(bridge.turn.activeToolCalls).toEqual([]);
      expect(shell.session.run).toBe("idle");
      expect(shell.lockupPhase).toBeNull();
      const rows = toolRow(shell);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.pending).not.toBe(true);
      expect(rows[0]?.failed).toBe(true);
      expect(rows[0]?.text).toBe(PARKED_CALL_NOT_RUN);
    });
  });

  test("an approved call reports through its own events and is never closed early", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      const events: Event[] = [
        { type: "inference.start", data: {} },
        ...toolCall("c1"),
        { type: "inference.done", data: {} },
        gateBlocked(),
        // Approved: the reactor re-dispatches the exact parked call.
        { type: "tool.start", data: { call: { id: "c1", name: "run_shell" } } },
        {
          type: "tool.done",
          data: { result: { callId: "c1", name: "run_shell", content: "ok" } },
        },
        ...followUpReply,
      ];
      for (const event of events) bridge.handle(event);

      expect(shell.session.run).toBe("idle");
      const rows = toolRow(shell);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.failed).not.toBe(true);
      expect(rows[0]?.text).toBe("ok");
    });
  });

  test("a sibling already executing when the gate blocked stays open", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      const events: Event[] = [
        { type: "inference.start", data: {} },
        ...toolCall("c1"),
        ...toolCall("c2"),
        { type: "inference.done", data: {} },
        // c1 was auto-allowed and is running; c2 parked on the gate.
        { type: "tool.start", data: { call: { id: "c1", name: "run_shell" } } },
        gateBlocked(),
        { type: "inference.start", data: {} },
      ];
      for (const event of events) bridge.handle(event);

      expect(bridge.turn.activeToolCalls).toEqual(["c1"]);
      expect(shell.session.run).toBe("busy");
    });
  });

  test("a gate that is not an approval does not close anything", async () => {
    await withBridge({ run: "busy" }, async ({ bridge }) => {
      const events: Event[] = [
        { type: "inference.start", data: {} },
        ...toolCall("c1"),
        { type: "inference.done", data: {} },
        gateBlocked("input"),
        { type: "inference.start", data: {} },
      ];
      for (const event of events) bridge.handle(event);

      expect(bridge.turn.activeToolCalls).toEqual(["c1"]);
    });
  });
});

describe("idle-with-fleet (CL-7057)", () => {
  test("parent settles while fleet is live: run holds busy, follow-up keeps waiting", async () => {
    await withBridge({ run: "idle" }, async ({ h, shell, port, bridge }) => {
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 2 });
      bridge.submit("follow up later", "queue");
      port.clear();
      settleToollessTurn(bridge);
      // The parent turn settled but the fleet is live: the run stays busy
      // and the follow-up does not drain at mere parent-idle.
      expect(shell.session.run).toBe("busy");
      expect(shell.lockupPhase).not.toBeNull();
      expect(
        (LIVE_ACTIVITY_WORDS as readonly string[]).includes(
          shell.lockupPhase ?? "",
        ),
      ).toBe(true);
      expect(badgeCount(shell.session)).toBe(1);
      expect(port.calls).toEqual([]);
      await h.renderOnce();
    });
  });

  test("Enter mid-hold starts a new primary turn instead of queueing a steer", async () => {
    await withBridge(
      { run: "busy", wireKeys: true },
      async ({ h, shell, port, bridge }) => {
        // Hold state: live fleet + settled parent turn.
        bridge.handle({ type: "fleet", running: 2 });
        settleToollessTurn(bridge);
        expect(shell.session.run).toBe("busy");
        port.clear();

        shell.prompt.value = "also update the docs";
        shell.prompt.submit();
        // A new turn, not a queued steer waiting on a tool that no longer
        // exists.
        expect(port.calls.some((c) => c.op === "enqueue")).toBe(false);
        expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(true);
        expect(badgeCount(shell.session)).toBe(0);
        expect(shell.session.run).toBe("busy");
        await h.renderOnce();
      },
    );
  });

  test("Alt+Enter mid-hold queues the follow-up; last lane terminalizing drains it at session-idle", async () => {
    await withBridge({ run: "busy" }, async ({ shell, port, bridge }) => {
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      expect(shell.session.run).toBe("busy");

      bridge.submit("when it finishes, summarize", "queue");
      expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(false);
      expect(badgeCount(shell.session)).toBe(1);
      port.clear();

      // The last lane terminalizes: the hold releases, the run idles,
      // and only now does the queued follow-up deliver.
      bridge.handle({ type: "fleet", running: 0 });
      expect(shell.session.run).toBe("idle");
      expect(badgeCount(shell.session)).toBe(0);
      const deliver = port.calls.find((c) => c.op === "deliver");
      expect(deliver).toEqual({
        op: "deliver",
        item: expect.objectContaining({
          text: "when it finishes, summarize",
          kind: "queue",
        }),
      });
    });
  });

  test("a steer left pending at hold engagement delivers immediately; the hold stays on", async () => {
    await withBridge({ run: "busy" }, async ({ shell, port, bridge }) => {
      bridge.submit("dispatch workers", "immediate");
      // Parent busy (turn in flight): this steer queues for the boundary.
      bridge.submit("one more worker", "steer");
      bridge.handle({ type: "fleet", running: 1 });
      port.clear();
      settleToollessTurn(bridge);
      // The parent the steer was addressing has stopped, so it delivers
      // as its own turn right away instead of sitting out the hold — the run
      // stays held by the live fleet.
      expect(shell.session.run).toBe("busy");
      expect(badgeCount(shell.session)).toBe(0);
      const deliver = port.calls.find((c) => c.op === "deliver");
      expect(deliver).toEqual({
        op: "deliver",
        item: expect.objectContaining({
          text: "one more worker",
          kind: "steer",
        }),
      });
    });
  });

  test("fleet count reaching zero mid-turn does not idle a working parent", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      // The lone worker fails while the parent is still streaming its reply:
      // no release, no premature idle.
      bridge.handle({ type: "fleet", running: 0 });
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(shell.session.run).toBe("idle");
    });
  });
});

describe("fleet-dry open-task drive (CL-7540)", () => {
  test("dry+open: fleet-0 settle drives once and keeps the run busy without painting the prompt", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      const drives = installDryDriver(bridge);
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      expect(shell.session.run).toBe("busy");
      port.clear();
      const userRowsBefore = shell.streamLog.filter(
        (r) => r.role === "user",
      ).length;
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("busy");
      expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(false);
      bridge.handle({
        type: "message.received",
        data: { message: { content: DRY_OPEN_TASK_PROMPT } },
      });
      expect(shell.streamLog.filter((r) => r.role === "user").length).toBe(
        userRowsBefore,
      );
      // The continuation is runtime→agent traffic — the fleet board owns
      // worker status, so its prompt paints no transcript row.
      expect(
        shell.streamLog.filter(
          (r) => r.role === "system" && r.text === DRY_OPEN_TASK_PROMPT,
        ),
      ).toHaveLength(0);
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
    });
  });

  test("wentDry during processing then settle drives after settle, not idle", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      const drives = installDryDriver(bridge);
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      expect(shell.session.run).toBe("busy");
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives()).toBe(0);
      expect(shell.session.run).toBe("busy");
      expect(shell.lockupPhase).not.toBeNull();
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("busy");
      expect(shell.lockupPhase).not.toBeNull();
      bridge.submit("when it finishes, summarize", "queue");
      expect(badgeCount(shell.session)).toBe(1);
      port.clear();
      bridge.handle({ type: "connector.reply", data: { content: "" } });
      expect(shell.session.run).toBe("busy");
      expect(badgeCount(shell.session)).toBe(1);
      expect(port.calls.some((c) => c.op === "deliver")).toBe(false);
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("idle");
      expect(badgeCount(shell.session)).toBe(0);
    });
  });

  test("already-dry settle drives once even without a live 1→0 fleet event", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const drives = installDryDriver(bridge);
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives()).toBe(0);
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
    });
  });

  test("a no-op dry settle does not eat the shot for a later missed 1→0 with open tasks", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      let openTasks = false;
      let drives = 0;
      bridge.setDryOpenTaskDriver(() => {
        if (!openTasks) return false;
        drives += 1;
        bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
        return true;
      });
      bridge.submit("first turn, no todos", "immediate");
      bridge.handle({ type: "fleet", running: 0 });
      settleToollessTurn(bridge);
      expect(drives).toBe(0);
      expect(shell.session.run).toBe("idle");

      openTasks = true;
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives).toBe(0);
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(drives).toBe(1);
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(drives).toBe(1);
    });
  });

  test("a new live lane resets the dry-episode latch for one more occupancy shot", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const drives = installDryDriver(bridge);
      bridge.submit("dispatch workers", "immediate");
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("idle");

      bridge.submit("dispatch more workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      expect(drives()).toBe(1);
      expect(shell.session.run).toBe("busy");
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives()).toBe(2);
      expect(shell.session.run).toBe("busy");
    });
  });

  test("parent still processing does not take the occupancy shot", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      let drives = 0;
      bridge.setDryOpenTaskDriver(() => {
        drives += 1;
        return true;
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives).toBe(0);
      expect(shell.session.run).toBe("busy");
      expect(bridge.turn.isProcessing).toBe(true);
    });
  });

  test("occupancy send failure re-arms, clears continuation hold, and drains follow-ups", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      let drives = 0;
      bridge.setDryOpenTaskDriver(() => {
        drives += 1;
        bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
        if (drives === 1) {
          void Promise.resolve().then(() => {
            bridge.abortSystemContinuation();
          });
        }
        return true;
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      expect(shell.session.run).toBe("busy");
      bridge.handle({ type: "fleet", running: 0 });
      expect(drives).toBe(1);
      expect(shell.session.run).toBe("busy");
      bridge.submit("when it finishes, summarize", "queue");
      expect(badgeCount(shell.session)).toBe(1);
      port.clear();
      await Promise.resolve();
      expect(shell.session.run).toBe("idle");
      expect(badgeCount(shell.session)).toBe(0);
      const deliver = port.calls.find((c) => c.op === "deliver");
      expect(deliver).toEqual({
        op: "deliver",
        item: expect.objectContaining({
          text: "when it finishes, summarize",
          kind: "queue",
        }),
      });
      bridge.handle({ type: "connector.reply", data: { content: "" } });
      expect(shell.session.run).toBe("idle");
      bridge.submit("continue the remaining work", "immediate");
      expect(shell.session.run).toBe("busy");
      settleToollessTurn(bridge);
      expect(drives).toBe(2);
      expect(shell.session.run).toBe("busy");
    });
  });

  test("pending occupancy Promise is not a continuation; failed send idles", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      let resolveDrive: ((ok: boolean) => void) | undefined;
      bridge.setDryOpenTaskDriver(() => {
        bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
        return new Promise((resolve) => {
          resolveDrive = resolve;
        });
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      expect(shell.session.run).toBe("busy");
      bridge.handle({ type: "fleet", running: 0 });
      expect(shell.session.run).toBe("busy");
      expect(resolveDrive).toBeDefined();
      resolveDrive?.(false);
      await Promise.resolve();
      expect(shell.session.run).toBe("idle");
      port.clear();
      bridge.submit("operator turn", "immediate");
      expect(shell.session.run).toBe("busy");
      expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(true);
    });
  });

  test("pending occupancy abort after dispose does not idle or drain", async () => {
    await withBridge({ run: "idle" }, async ({ shell, port, bridge }) => {
      let resolveDrive: ((ok: boolean) => void) | undefined;
      bridge.setDryOpenTaskDriver(() => {
        bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
        return new Promise((resolve) => {
          resolveDrive = resolve;
        });
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      bridge.handle({ type: "fleet", running: 0 });
      expect(shell.session.run).toBe("busy");
      bridge.submit("when it finishes, summarize", "queue");
      expect(badgeCount(shell.session)).toBe(1);
      port.clear();
      bridge.dispose();
      const runAfterDispose = shell.session.run;
      expect(runAfterDispose).toBe("busy");
      resolveDrive?.(false);
      await Promise.resolve();
      expect(shell.session.run).toBe(runAfterDispose);
      expect(badgeCount(shell.session)).toBe(1);
      expect(port.calls.some((c) => c.op === "deliver")).toBe(false);
    });
  });

  test("occupancy send abort does not swallow a later matching inbound", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const operator = "dispatch workers";
      bridge.submit(operator, "immediate");
      const userRowsAfterSubmit = shell.streamLog.filter(
        (r) => r.role === "user",
      ).length;
      bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
      bridge.abortSystemContinuation();
      expect(shell.session.run).toBe("idle");

      bridge.handle({
        type: "message.received",
        data: { message: { content: operator } },
      });
      expect(shell.streamLog.filter((r) => r.role === "user").length).toBe(
        userRowsAfterSubmit,
      );

      bridge.handle({
        type: "message.received",
        data: { message: { content: DRY_OPEN_TASK_PROMPT } },
      });
      expect(shell.streamLog.filter((r) => r.role === "user").length).toBe(
        userRowsAfterSubmit,
      );
      // Fleet-dry continuations are internal runtime→agent traffic and
      // paint no row; the abort must not have swallowed the inbound.
      expect(
        shell.streamLog.filter(
          (r) => r.role === "system" && r.text === DRY_OPEN_TASK_PROMPT,
        ),
      ).toHaveLength(0);
    });
  });

  test("occupancy send abort resets the turn without a following reply", async () => {
    await clockedBridge(
      { run: "idle", monitor: { stallNoticeMs: 400, stallTimeoutMs: 1_000 } },
      async ({ shell, bridge, clock }) => {
        bridge.setDryOpenTaskDriver(() => {
          bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
          void Promise.resolve().then(() => {
            bridge.abortSystemContinuation();
          });
          return true;
        });
        bridge.submit("dispatch workers", "immediate");
        bridge.handle({ type: "fleet", running: 1 });
        settleToollessTurn(bridge);
        bridge.handle({ type: "fleet", running: 0 });
        expect(bridge.turn.isProcessing).toBe(true);
        expect(clock.tick).toBeDefined();
        await Promise.resolve();
        expect(bridge.turn.isProcessing).toBe(false);
        expect(bridge.turn.awaitingResponse).toBe(false);
        expect(bridge.turn.status).not.toBe("running");
        expect(shell.lockupPhase).toBeNull();
        expect(clock.tick).toBeUndefined();
      },
    );
  });

  test("occupancy continuation is what quota auto-retry resubmits", async () => {
    await clockedBridge({ run: "idle" }, async ({ port, bridge, clock }) => {
      bridge.setDryOpenTaskDriver(() => {
        bridge.beginSystemContinuation(DRY_OPEN_TASK_PROMPT);
        return true;
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      bridge.handle({ type: "fleet", running: 0 });
      port.clear();
      bridge.handle({
        type: "inference.error",
        data: {
          error: { category: "quota_exhausted", retryAfterMs: 1_000 },
        },
      });
      clock.nowMs += 10_000;
      clock.tick?.();
      expect(port.calls).toEqual([
        { op: "sendImmediate", text: DRY_OPEN_TASK_PROMPT.trim() },
      ]);
    });
  });
});

describe("mailbox mail occupancy (CL-7518)", () => {
  test("idle-with-fleet child-done while siblings run flushes mailbox mail", async () => {
    await withBridge({ run: "idle" }, async ({ shell, bridge }) => {
      const prompt = `${mailboxMailWakeLine()}\n[]`;
      let terminals = 0;
      let drives = 0;
      bridge.setMailboxMailDriver(() => {
        if (terminals === 0) return false;
        drives += 1;
        bridge.beginSystemContinuation(prompt);
        return true;
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 2 });
      settleToollessTurn(bridge);
      expect(drives).toBe(0);
      terminals = 1;
      bridge.handle({ type: "fleet", running: 1 });
      expect(drives).toBe(1);
      expect(shell.session.run).toBe("busy");
    });
  });

  test("fail wake is the same idle-with-fleet flush", async () => {
    await withBridge({ run: "busy" }, async ({ bridge }) => {
      let drives = 0;
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      bridge.setMailboxMailDriver(() => {
        drives += 1;
        return true;
      });
      expect(drives).toBe(0);
      bridge.flushMailboxMail();
      expect(drives).toBe(1);
    });
  });

  test("does not flush while the parent is processing", async () => {
    await withBridge({ run: "idle" }, async ({ bridge }) => {
      let drives = 0;
      bridge.setMailboxMailDriver(() => {
        drives += 1;
        return true;
      });
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      bridge.flushMailboxMail();
      expect(drives).toBe(0);
    });
  });

  test("skips mailbox mail when a fleet-dry open-task shot is latched", async () => {
    await withBridge({ run: "idle" }, async ({ bridge }) => {
      let mail = 0;
      let allowMail = false;
      bridge.setMailboxMailDriver(() => {
        if (!allowMail) return false;
        mail += 1;
        return true;
      });
      const dry = installDryDriver(bridge);
      bridge.submit("dispatch workers", "immediate");
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      allowMail = true;
      bridge.handle({ type: "fleet", running: 0 });
      expect(dry()).toBe(1);
      expect(mail).toBe(0);
    });
  });

  test("no double-deliver: second flush is a no-op after the driver takes", async () => {
    await withBridge({ run: "busy" }, async ({ bridge }) => {
      let remaining = 1;
      let drives = 0;
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      bridge.setMailboxMailDriver(() => {
        if (remaining === 0) return false;
        remaining = 0;
        drives += 1;
        return true;
      });
      bridge.flushMailboxMail();
      bridge.flushMailboxMail();
      expect(drives).toBe(1);
    });
  });

  test("queued steer while wait is in-flight wakes occupancy yield", async () => {
    await withBridge({ run: "idle" }, async ({ bridge }) => {
      let wakes = 0;
      bridge.setWaitYieldWake(() => {
        wakes += 1;
      });
      bridge.submit("waiting on workers", "immediate");
      bridge.submit("steer now", "steer");
      expect(wakes).toBe(1);
    });
  });

  test("mailbox mail send abort does not latch the fleet-dry skip", async () => {
    await withBridge({ run: "busy" }, async ({ bridge }) => {
      let drives = 0;
      bridge.handle({ type: "fleet", running: 1 });
      settleToollessTurn(bridge);
      bridge.beginSystemContinuation(`${mailboxMailWakeLine()}\n[]`);
      bridge.abortSystemContinuation({ rearmDry: false });
      bridge.setMailboxMailDriver(() => {
        drives += 1;
        return true;
      });
      bridge.flushMailboxMail();
      expect(drives).toBe(1);
    });
  });
});

describe("syncAgentProgress", () => {
  function taskSession(
    over: Partial<TaskProgressSession>,
  ): TaskProgressSession {
    return {
      id: "task-1",
      status: "running",
      currentToolName: "grep",
      currentToolPreview: null,
      currentToolStartedAt: null,
      startedAt: 0,
      lastActivityAt: 0,
      ...over,
    };
  }

  test("updates the dispatch row in place without appending or removing rows", async () => {
    let nowMs = 0;
    await withBridge(
      { run: "busy", monitor: { now: () => nowMs } },
      async ({ h, shell, bridge }) => {
        for (let i = 0; i < 40; i++)
          appendStreamRow(shell, { role: "assistant", text: `filler ${i}` });
        bridge.handle({
          type: "inference.tool_call.end",
          data: {
            name: "spawn_agent",
            callId: "task-1",
            arguments: { description: "Review permission gate" },
          },
        });
        await h.renderOnce();
        const rowCountBefore = streamRowCount(shell);
        const removeSpy = spyOn(shell.transcript, "remove");

        nowMs = 42_000;
        bridge.syncAgentProgress([taskSession({ lastActivityAt: nowMs })]);
        bridge.syncAgentProgress([
          taskSession({ currentToolName: "grep", lastActivityAt: nowMs }),
        ]);
        await h.renderOnce();

        expect(streamRowCount(shell)).toBe(rowCountBefore);
        expect(removeSpy.mock.calls.length).toBeLessThanOrEqual(2);

        const row = defined(
          shell.streamLog[rowCountBefore - 1],
          "progress row",
        );
        expect(row.pending).toBe(true);
        expect(row.agentWorking).toBe(true);
        expect(row.stat).toContain("grep");

        nowMs = 42_000 + DEFAULT_STALL_MS;
        bridge.syncAgentProgress([
          taskSession({ currentToolName: "grep", lastActivityAt: 42_000 }),
        ]);
        await h.renderOnce();
        const stalledRow = defined(
          shell.streamLog[rowCountBefore - 1],
          "stalled row",
        );
        expect(stalledRow.agentWorking).toBe(false);

        removeSpy.mockRestore();
      },
    );
  });

  test("a finished session's row is left to the tool-result path", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      bridge.handle({
        type: "inference.tool_call.end",
        data: {
          name: "spawn_agent",
          callId: "task-1",
          arguments: { description: "Review mouse/paste" },
        },
      });
      bridge.handle({
        type: "tool.done",
        data: {
          result: {
            callId: "task-1",
            name: "spawn_agent",
            content: "done",
            isError: false,
          },
        },
      });
      const index = shell.streamLog.length - 1;
      bridge.syncAgentProgress([taskSession({ status: "done" })]);
      expect(defined(shell.streamLog[index], "finished row").pending).not.toBe(
        true,
      );
      expect(
        defined(shell.streamLog[index], "finished row").agentWorking,
      ).toBeUndefined();
    });
  });

  test("live progress continues after spawn_agent's immediate running result", async () => {
    let nowMs = 0;
    await withBridge(
      { run: "busy", monitor: { now: () => nowMs } },
      async ({ h, shell, bridge }) => {
        bridge.handle({
          type: "inference.tool_call.end",
          data: {
            name: "spawn_agent",
            callId: "task-1",
            arguments: { description: "Review permission gate" },
          },
        });
        bridge.handle({
          type: "tool.done",
          data: {
            result: {
              callId: "task-1",
              name: "spawn_agent",
              content: JSON.stringify({
                agent_id: "task-1",
                status: "running",
              }),
              isError: false,
            },
          },
        });
        const index = shell.streamLog.length - 1;
        nowMs = 42_000;
        bridge.syncAgentProgress([taskSession({ lastActivityAt: nowMs })]);
        await h.renderOnce();
        const row = defined(shell.streamLog[index], "live progress row");
        expect(row.agentWorking).toBe(true);
        expect(row.stat).toContain("grep");
      },
    );
  });
});

describe("in-flight tool row elapsed time", () => {
  test("an ordinary pending call's row grows a live clock, then loses it to the answer", async () => {
    await clockedBridge(
      { run: "busy" },
      async ({ h, shell, bridge, clock }) => {
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "run_shell", callId: "c1", arguments: "sleep 30" },
        });
        const index = streamRowCount(shell) - 1;
        expect(
          defined(shell.streamLog[index], "tool row").stat,
        ).toBeUndefined();

        clock.nowMs = 65_000;
        clock.tick?.();
        await h.renderOnce();
        expect(defined(shell.streamLog[index], "tool row").stat).toBe("1:05");

        bridge.handle({
          type: "tool.done",
          data: {
            result: {
              callId: "c1",
              name: "run_shell",
              content: "ok",
              isError: false,
            },
          },
        });
        // The elapsed clock was scaffolding for the wait, not a fact worth
        // keeping — the answer's own addendum takes the row over.
        expect(defined(shell.streamLog[index], "tool row").stat).not.toBe(
          "1:05",
        );
      },
    );
  });

  test("a diff call keeps its own +/- stat instead of an elapsed clock", async () => {
    await clockedBridge({ run: "busy" }, async ({ shell, bridge, clock }) => {
      bridge.handle({ type: "inference.start", data: {} });
      bridge.handle({
        type: "inference.tool_call.end",
        data: {
          name: "write_file",
          callId: "c1",
          arguments: JSON.stringify({ path: "a.txt", content: "hi\n" }),
        },
      });
      const index = streamRowCount(shell) - 1;
      const before = defined(shell.streamLog[index], "diff row").stat;
      expect(before).toContain("+");

      clock.nowMs = 65_000;
      clock.tick?.();
      expect(defined(shell.streamLog[index], "diff row").stat).toBe(before);
    });
  });
});

describe("CL-7802 gated tool elapsed starts at grant", () => {
  function acceptOnce(shell: AppShell): void {
    moveOverlaySelection(shell, 1);
    acceptOverlaySelection(shell);
  }

  function destructiveRequest(subject: string): PermissionRequest {
    return {
      tool: "run_shell",
      action: "Run shell command",
      subject,
      scopes: [],
    };
  }

  test("R1 hidden-gate grant: post-grant stat reads time-since-grant, not time-since-announce", async () => {
    await clockedBridge(
      { run: "busy" },
      async ({ h, shell, bridge, clock }) => {
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "run_shell", callId: "c1", arguments: "sleep 30" },
        });
        const index = streamRowCount(shell) - 1;
        const stat = () => defined(shell.streamLog[index], "tool row").stat;

        bridge.gateOpened();
        clock.nowMs = 120_000;
        clock.tick?.();
        await h.renderOnce();
        expect(stat()).toBeUndefined();

        bridge.gateClosed();
        await h.renderOnce();
        expect(stat()).toBe("0:00");

        clock.nowMs = 125_000;
        clock.tick?.();
        await h.renderOnce();
        expect(stat()).toBe("0:05");
      },
    );
  });

  test("R2 gated deny: final row carries the answer stat, no m:ss leftover", async () => {
    await clockedBridge(
      { run: "busy" },
      async ({ h, shell, bridge, clock }) => {
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "run_shell", callId: "c1", arguments: "sleep 30" },
        });
        const index = streamRowCount(shell) - 1;

        bridge.gateOpened();
        clock.nowMs = 120_000;
        clock.tick?.();
        await h.renderOnce();
        bridge.gateClosed();
        bridge.handle({
          type: "tool.done",
          data: {
            result: {
              callId: "c1",
              name: "run_shell",
              content: "Denied by operator",
              isError: true,
            },
          },
        });
        await h.renderOnce();
        expect(
          defined(shell.streamLog[index], "tool row").stat ?? "",
        ).not.toMatch(/^\d+:\d\d$/);
      },
    );
  });

  test("R3 shown-gate grant: the wait clock rebases to time-since-grant", async () => {
    await clockedBridge(
      { run: "busy", gates: true },
      async ({ h, shell, emitter, bridge, clock }) => {
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({
          type: "inference.tool_call.end",
          data: {
            name: "run_shell",
            callId: "c1",
            arguments: "rm -rf /tmp/cl7802",
          },
        });
        const index = streamRowCount(shell) - 1;
        const stat = () => defined(shell.streamLog[index], "tool row").stat;

        bridge.gateOpened();
        let resolved: unknown;
        emitter.emit("permission.gate", {
          id: "req-g",
          request: destructiveRequest("rm -rf /tmp/cl7802"),
          resolve: (outcome: unknown) => {
            resolved = outcome;
          },
        });
        expect(shell.overlayKind).toBe("permissions");

        clock.nowMs = 120_000;
        clock.tick?.();
        await h.renderOnce();
        expect(stat()).toBe("2:00");

        acceptOnce(shell);
        expect(resolved).toEqual({ allow: true });
        bridge.gateClosed();
        await h.renderOnce();
        expect(stat()).toBe("0:00");

        clock.nowMs = 125_000;
        clock.tick?.();
        await h.renderOnce();
        expect(stat()).toBe("0:05");
      },
    );
  });

  test("ungated in-flight sibling does not rebase when a later gate settles", async () => {
    await clockedBridge(
      { run: "busy" },
      async ({ h, shell, bridge, clock }) => {
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "grep", callId: "sibling", arguments: "needle" },
        });
        const siblingIndex = streamRowCount(shell) - 1;
        const siblingStat = () =>
          defined(shell.streamLog[siblingIndex], "sibling row").stat;

        clock.nowMs = 60_000;
        clock.tick?.();
        await h.renderOnce();
        expect(siblingStat()).toBe("1:00");

        bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "run_shell", callId: "gated", arguments: "sleep 30" },
        });
        const gatedIndex = streamRowCount(shell) - 1;
        const gatedStat = () =>
          defined(shell.streamLog[gatedIndex], "gated row").stat;

        bridge.gateOpened();
        bridge.gateClosed();
        await h.renderOnce();
        expect(siblingStat()).toBe("1:00");
        expect(gatedStat()).toBe("0:00");

        clock.nowMs = 65_000;
        clock.tick?.();
        await h.renderOnce();
        expect(siblingStat()).toBe("1:05");
        expect(gatedStat()).toBe("0:05");
      },
    );
  });

  test("spawn_agent rows keep their session clock through a gate cycle", async () => {
    let nowMs = 0;
    await withBridge(
      { run: "busy", monitor: { now: () => nowMs } },
      async ({ h, shell, bridge }) => {
        bridge.handle({ type: "inference.start", data: {} });
        bridge.handle({
          type: "inference.tool_call.end",
          data: {
            name: "spawn_agent",
            callId: "task-1",
            arguments: { description: "Review permission gate" },
          },
        });
        const index = streamRowCount(shell) - 1;
        nowMs = 120_000;
        bridge.syncAgentProgress([
          {
            id: "task-1",
            status: "running",
            currentToolName: "grep",
            currentToolPreview: null,
            currentToolStartedAt: null,
            startedAt: 0,
            lastActivityAt: nowMs,
          },
        ]);
        await h.renderOnce();
        const before = defined(shell.streamLog[index], "progress row").stat;

        bridge.gateOpened();
        bridge.gateClosed();
        await h.renderOnce();
        expect(defined(shell.streamLog[index], "progress row").stat).toBe(
          before,
        );
      },
    );
  });
});

describe("task checklist calls stay out of the transcript", () => {
  test("a manage_tasks call and its result paint no rows", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      appendStreamRow(shell, {
        role: "assistant",
        text: "planning the sweep",
      });
      const before = streamRowCount(shell);

      bridge.handle({
        type: "inference.tool_call.end",
        data: {
          name: "manage_tasks",
          callId: "mt-1",
          arguments: {
            action: "create",
            tasks: [{ title: "audit", status: "todo" }],
          },
        },
      });
      bridge.handle({
        type: "tool.done",
        data: {
          result: {
            callId: "mt-1",
            name: "manage_tasks",
            content: "ok",
            isError: false,
          },
        },
      });

      // The list lives in the task panel; scrollback must not carry a
      // second copy of it.
      expect(streamRowCount(shell)).toBe(before);
    });
  });

  test("an errored manage_tasks result is dropped rather than left unpaired", async () => {
    await withBridge({ run: "busy" }, async ({ shell, bridge }) => {
      const before = streamRowCount(shell);
      bridge.handle({
        type: "inference.tool_call.end",
        data: {
          name: "manage_tasks",
          callId: "mt-2",
          arguments: { action: "update" },
        },
      });
      bridge.handle({
        type: "tool.done",
        data: {
          result: {
            callId: "mt-2",
            name: "manage_tasks",
            content: "boom",
            isError: true,
          },
        },
      });
      expect(streamRowCount(shell)).toBe(before);
    });
  });
});
