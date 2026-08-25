import { describe, expect, spyOn, test } from "bun:test";
import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
  mapReactorLike,
  type TaskProgressSession,
} from "./runtime-bridge";
import { DEFAULT_STALL_MS } from "./agent-progress";
import { appendStreamRow, createAppShell, paintChrome, streamRowCount } from "./shell";
import { STEER_WAIT_NOTICE_MS } from "./notice-line";
import { withTestRenderer } from "./harness";
import { badgeCount } from "./session-queue";

describe("mapReactorLike", () => {
  test("message.received → user", () => {
    expect(
      mapReactorLike({
        type: "message.received",
        data: { message: { content: "hi" } },
      }),
    ).toEqual([{ type: "user", text: "hi" }]);
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
  test("fixture paints user / assistant / tool through shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.play(FIXTURE_BUSY_SESSION);
          // Assistant rows are markdown; their blocks highlight asynchronously.
          await new Promise((resolve) => setTimeout(resolve, 250));
          await h.renderOnce();
          const frame = h.captureCharFrame();
          // Sticky follows the tail; early user line may scroll off.
          expect(shell.lineCount).toBeGreaterThanOrEqual(3);
          expect(frame).toContain("I'll list the directory.");
          // The call and its output are one row: the command stays the subject
          // and the listing sits behind the expand arrow.
          expect(frame).toContain("Bash ls -la");
          expect(frame).not.toContain("AGENTS.md");
          expect(frame).toContain("Done");
          expect(shell.session.run).toBe("idle");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Enter mid-run hits port.enqueue; badge tracks depth", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          shell.prompt.value = "queued please";
          shell.prompt.submit();
          await h.renderOnce();
          expect(port.calls.some((c) => c.op === "enqueue")).toBe(true);
          const enq = port.calls.find((c) => c.op === "enqueue");
          // Plain Enter mid-run soft-steers (CL-6290). Follow-up is Alt+Enter.
          expect(enq).toEqual({
            op: "enqueue",
            text: "queued please",
            kind: "steer",
          });
          expect(badgeCount(shell.session)).toBe(1);
          expect(shell.pendingQueue).toBe(1);
          const frame = h.captureCharFrame();
          expect(frame).toMatch(/steer\s+1/);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Alt+Enter mid-run enqueues follow-up (queue), never interrupts", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
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
          expect(frame).toMatch(/follow-up\s+1/);
          expect(frame).toContain("will follow up");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+C hits port.interrupt and keeps pending for the next turn", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("a", "queue");
          bridge.submit("b", "steer");
          expect(badgeCount(shell.session)).toBe(2);
          port.clear();
          h.pressKey("c", { ctrl: true });
          await h.renderOnce();
          expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);
          expect(shell.session.interruptFlash).toBe(true);
          expect(shell.session.run).toBe("idle");
          // Handed over, not thrown away — and handed over here rather than
          // left waiting on an idle event the stop may never produce.
          expect(port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : []))).toEqual([
            "b",
            "a",
          ]);
          expect(badgeCount(shell.session)).toBe(0);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("local classify keeps idle submits off the busy path", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort({
          classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
        });
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("/feedback quick test", "immediate");
          await h.renderOnce();
          expect(port.calls).toEqual([{ op: "sendImmediate", text: "/feedback quick test" }]);
          expect(shell.session.run).toBe("idle");
          expect(badgeCount(shell.session)).toBe(0);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("local classify mid-run does not enqueue or interrupt the agent turn", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort({
          classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
        });
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("/feedback note", "queue");
          await h.renderOnce();
          expect(port.calls).toEqual([{ op: "sendImmediate", text: "/feedback note" }]);
          expect(port.calls.some((c) => c.op === "enqueue")).toBe(false);
          expect(shell.session.run).toBe("busy");
          expect(badgeCount(shell.session)).toBe(0);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("steer delivers at tool.boundary; follow-up does not", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
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
          expect(shell.session.items[0]!.kind).toBe("queue");
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
          expect(frame).toMatch(/follow-up\s+1/);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("steer is not delivered while a parent tool is in flight", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({
            type: "tool.start",
            data: { call: { id: "c1", name: "run_shell" } },
          });
          bridge.submit("steer now", "steer");
          expect(port.calls.some((c) => c.op === "deliver")).toBe(false);
          expect(badgeCount(shell.session)).toBe(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("notice names the in-flight command after STEER_WAIT_NOTICE_MS", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        let clock = 0;
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port, {
          now: () => clock,
          schedule: () => () => {},
        });
        try {
          bridge.handle({
            type: "tool.start",
            data: { call: { id: "c1", name: "run_shell" } },
          });
          bridge.submit("steer now", "steer");

          clock = STEER_WAIT_NOTICE_MS - 1;
          shell.lockupNowMs = clock;
          paintChrome(shell);
          await h.renderOnce();
          expect(h.captureCharFrame()).not.toContain("waiting on");

          clock = STEER_WAIT_NOTICE_MS;
          shell.lockupNowMs = clock;
          paintChrome(shell);
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("waiting on run_shell");

          bridge.handle({ type: "tool.boundary" });
          bridge.submit("follow up", "queue");
          clock = 5000;
          shell.lockupNowMs = clock;
          paintChrome(shell);
          await h.renderOnce();
          expect(h.captureCharFrame()).not.toContain("waiting on");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("follow-up drains on idle, after any remaining steers", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("follow up", "queue");
          bridge.submit("late steer", "steer");
          expect(badgeCount(shell.session)).toBe(2);
          port.clear();
          bridge.handle({ type: "run", state: "idle" });
          expect(badgeCount(shell.session)).toBe(0);
          expect(port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : []))).toEqual([
            "late steer",
            "follow up",
          ]);
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("following up");
          expect(frame).toContain("steering");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("queued item delivers on a tool-less turn (inference.done, no tool calls)", async () => {
    // Regression for CL-5563: reactor.done only fires once, at agent
    // shutdown, never between turns — a plain-text reply with no tool calls
    // must still drain the queue, or a queued message sits forever.
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
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
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("run and the phase ramp both return to idle after a tool-less inference.done, with no connector.reply", async () => {
    // Regression: a self-continuing workflow cycle
    // may never emit connector.reply, the only other event that clears
    // `run` and the turn's `isProcessing`. Without this, every future Enter
    // resolves to "queue" (busy is sticky) and, once the workflow stops
    // producing cycles, that queued message is never drained — CL-5563's
    // bug moved one layer over. The ramp indicator has the same failure
    // mode: it reads `isProcessing`, not `run`, so it can say "working"
    // forever even once dispatch itself is fixed.
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
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
          expect(port.calls).toEqual([{ op: "sendImmediate", text: "are you still there" }]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("run returns to idle between two consecutive turns, not only at reactor shutdown", async () => {
    // CL-5570: `run` must flip back to idle at every turn boundary
    // (`inference.done`), so a second Enter after the first reply sends
    // immediately instead of routing through the queue. reactor.done is
    // shutdown, not a turn boundary, and never fires between turns.
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("first turn", "immediate");
          expect(shell.session.run).toBe("busy");
          bridge.handle({ type: "inference.start" });
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi" },
          });
          bridge.handle({ type: "inference.done" });
          expect(shell.session.run).toBe("idle");

          bridge.submit("second turn", "immediate");
          expect(shell.session.run).toBe("busy");
          bridge.handle({ type: "inference.start" });
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi again" },
          });
          bridge.handle({ type: "inference.done" });
          expect(shell.session.run).toBe("idle");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("run stays busy after inference.done while a tool call is still outstanding", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.handle({ type: "inference.start" });
          bridge.handle({
            type: "inference.tool_call.start",
            data: { call: { id: "c1", name: "bash" } },
          });
          bridge.handle({ type: "inference.done" });
          expect(shell.session.run).toBe("busy");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("token-by-token deltas grow one assistant row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
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
          expect(assistant[0]?.text.trim()).toBe("Hello there, this is one streamed reply.");
          expect(assistant[0]?.streaming).toBe(false);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("inference.text.delta opens a live assistant streaming row mid-turn", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
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

          const assistant = shell.streamLog.filter((r) => r.role === "assistant");
          expect(assistant).toHaveLength(1);
          expect(assistant[0]?.streaming).toBe(true);
          expect(assistant[0]?.text).toBe("Here is the answer.");
          // Still one thinking row for the turn — no third mid-turn stream lane.
          expect(shell.streamLog.filter((r) => r.meta === "thinking")).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("thinking deltas coalesce and never become plain system rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          bridge.handle({ type: "inference.start", data: {} });
          for (const token of ["The ", "user ", "said ", "hi."]) {
            bridge.handle({
              type: "inference.thinking.delta",
              data: { token },
            });
          }
          bridge.handle({ type: "inference.text.delta", data: { token: "Hi!" } });
          bridge.handle({ type: "reactor.done", data: {} });

          const system = shell.streamLog.filter((r) => r.role === "system");
          expect(system.every((r) => r.meta === "thinking")).toBe(true);
          const thinking = system.filter((r) => r.meta === "thinking");
          expect(thinking).toHaveLength(1);
          expect(thinking[0]?.text).toBe("The user said hi.");
          expect(shell.streamLog.filter((r) => r.role === "assistant")).toHaveLength(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a submitted prompt echoes exactly once", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          bridge.submit("hi", "immediate");
          // The runtime replays the accepted prompt back onto the event stream.
          bridge.handle({
            type: "message.received",
            data: { message: { content: "hi" } },
          });
          expect(shell.streamLog.filter((r) => r.role === "user" && r.text === "hi")).toHaveLength(
            1,
          );
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("idle submit hits sendImmediate", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("hello", "immediate");
          expect(port.calls[0]).toEqual({
            op: "sendImmediate",
            text: "hello",
          });
          expect(shell.session.run).toBe("busy");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("failed sends", () => {
  const errorRows = (shell: {
    streamLog: readonly { role: string; meta?: string; text: string }[];
  }) => shell.streamLog.filter((r) => r.meta === "error").map((r) => r.text);

  test("a recognised auth expiry says what to press; anything else keeps its message", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          bridge.handle({
            type: "inference.error",
            data: {
              error: {
                message: 'Codex profile "default" is not authorized. Log in again.',
              },
            },
          });
          bridge.handle({
            type: "inference.error",
            data: { error: { message: "socket hang up" } },
          });

          const rows = errorRows(shell);
          expect(rows[0]).toContain("sign-in expired");
          expect(rows[0]).toContain("/model");
          expect(rows[1]).toBe("socket hang up");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("committed inference retry", () => {
  /**
   * The reactor re-streams a committed attempt from a fresh inference.start
   * after a same-source quota retry, so the transcript must retract the failed
   * attempt rather than append the replay underneath it.
   */
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
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          for (const event of COMMITTED_RETRY_EVENTS) bridge.handle(event);

          const text = shell.streamLog.map((r) => r.text).join("\n");
          expect(text).toContain("final answer");
          expect(text).not.toContain("partial answer");
          expect(shell.streamLog.filter((r) => r.pending)).toEqual([]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("parallel sub-agent dispatch on the live session bridge", () => {
  // The live main-session path tracks a call's row by callId in its own map
  // (applyToolCall/applyToolResult), independent of tool-rows.ts's name-based
  // pendingCallIndex — this pins that down so a future change to either path
  // cannot silently reintroduce CL-5562's misattribution on the parent
  // transcript specifically (the observe overlay and resumed history are
  // covered separately in tool-rows.test.ts / history-hydrate.test.ts).
  test("three parallel task calls resolve to three rows, each with its own result", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          const events = [
            { type: "inference.start", data: {} },
            {
              type: "inference.tool_call.end",
              data: { name: "task", callId: "c1", arguments: { description: "Fix CL-5559" } },
            },
            {
              type: "inference.tool_call.end",
              data: { name: "task", callId: "c2", arguments: { description: "Fix CL-5560" } },
            },
            {
              type: "inference.tool_call.end",
              data: { name: "task", callId: "c3", arguments: { description: "Fix CL-5561" } },
            },
            { type: "inference.done", data: {} },
            { type: "tool.start", data: { call: { id: "c1", name: "task" } } },
            { type: "tool.start", data: { call: { id: "c2", name: "task" } } },
            { type: "tool.start", data: { call: { id: "c3", name: "task" } } },
            // Completion order does not follow dispatch order.
            {
              type: "tool.done",
              data: { result: { callId: "c2", name: "task", content: "done c2" } },
            },
            {
              type: "tool.done",
              data: { result: { callId: "c1", name: "task", content: "done c1" } },
            },
            {
              type: "tool.done",
              data: { result: { callId: "c3", name: "task", content: "done c3" } },
            },
            { type: "reactor.done", data: {} },
          ] as const;
          for (const event of events) bridge.handle(event);

          const toolRows = shell.streamLog.filter((r) => r.role === "tool");
          expect(toolRows.length).toBe(3);
          expect(toolRows.every((r) => r.pending !== true)).toBe(true);
          expect(toolRows.every((r) => r.failed !== true)).toBe(true);
          expect(toolRows.map((r) => r.text)).toEqual(["done c1", "done c2", "done c3"]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("idle-with-fleet (CL-7057)", () => {
  /** A tool-less turn settles on inference.done — the spawn_agent dispatch shape. */
  function settleToollessTurn(bridge: ReturnType<typeof attachSessionBridge>): void {
    bridge.handle({ type: "inference.start", data: {} });
    bridge.handle({ type: "inference.done", data: {} });
  }

  test("parent settles while fleet is live: run holds busy, follow-up keeps waiting", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("dispatch workers", "immediate");
          bridge.handle({ type: "fleet", running: 2 });
          bridge.submit("follow up later", "queue");
          port.clear();
          settleToollessTurn(bridge);
          // The parent turn settled but the fleet is live: the run stays
          // busy and the follow-up does not drain at mere parent-idle.
          expect(shell.session.run).toBe("busy");
          expect(badgeCount(shell.session)).toBe(1);
          expect(port.calls).toEqual([]);
          await h.renderOnce();
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Enter mid-hold starts a new primary turn instead of queueing a steer", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
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
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Alt+Enter mid-hold queues the follow-up; last lane terminalizing drains it at session-idle", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
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
            item: expect.objectContaining({ text: "when it finishes, summarize", kind: "queue" }),
          });
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a steer left pending at hold engagement delivers immediately; the hold stays on", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("dispatch workers", "immediate");
          // Parent busy (turn in flight): this steer queues for the boundary.
          bridge.submit("one more worker", "steer");
          bridge.handle({ type: "fleet", running: 1 });
          port.clear();
          settleToollessTurn(bridge);
          // The parent the steer was addressing has stopped, so it delivers
          // as its own turn right away instead of sitting out the hold — but
          // the run itself stays held by the live fleet.
          expect(shell.session.run).toBe("busy");
          expect(badgeCount(shell.session)).toBe(0);
          const deliver = port.calls.find((c) => c.op === "deliver");
          expect(deliver).toEqual({
            op: "deliver",
            item: expect.objectContaining({ text: "one more worker", kind: "steer" }),
          });
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("fleet count reaching zero mid-turn does not idle a working parent", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          bridge.submit("dispatch workers", "immediate");
          bridge.handle({ type: "fleet", running: 1 });
          // The lone worker fails immediately while the parent is still
          // streaming its reply: no release, no premature idle.
          bridge.handle({ type: "fleet", running: 0 });
          expect(shell.session.run).toBe("busy");
          settleToollessTurn(bridge);
          expect(shell.session.run).toBe("idle");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("syncAgentProgress", () => {
  function taskSession(over: Partial<TaskProgressSession>): TaskProgressSession {
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
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        // Padding rows ahead of the dispatch: proves churn stays bounded by
        // outstanding task calls, not by transcript length.
        for (let i = 0; i < 40; i++) {
          appendStreamRow(shell, { role: "assistant", text: `filler ${i}` });
        }
        let nowMs = 0;
        const bridge = attachSessionBridge(shell, createRecordingPort(), {
          now: () => nowMs,
        });
        try {
          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "task",
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

          expect(streamRowCount(shell)).toBe(rowCountBefore);
          // One rewrite per changed tick, never proportional to the 40 padding rows.
          expect(removeSpy.mock.calls.length).toBeLessThanOrEqual(2);

          const row = shell.streamLog[rowCountBefore - 1]!;
          expect(row.pending).toBe(true);
          expect(row.agentWorking).toBe(true);
          expect(row.stat).toContain("grep");

          nowMs = 42_000 + DEFAULT_STALL_MS;
          bridge.syncAgentProgress([
            taskSession({ currentToolName: "grep", lastActivityAt: 42_000 }),
          ]);
          const stalledRow = shell.streamLog[rowCountBefore - 1]!;
          expect(stalledRow.agentWorking).toBe(false);

          removeSpy.mockRestore();
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a finished session's row is left to the tool-result path", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "task",
              callId: "task-1",
              arguments: { description: "Review mouse/paste" },
            },
          });
          bridge.handle({
            type: "tool.done",
            data: { result: { callId: "task-1", name: "task", content: "done", isError: false } },
          });
          const index = shell.streamLog.length - 1;
          bridge.syncAgentProgress([taskSession({ status: "done" })]);
          expect(shell.streamLog[index]!.pending).not.toBe(true);
          expect(shell.streamLog[index]!.agentWorking).toBeUndefined();
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("in-flight tool row elapsed time", () => {
  test("an ordinary pending call's row grows a live clock, then loses it to the answer", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        let nowMs = 0;
        let tick: (() => void) | undefined;
        const bridge = attachSessionBridge(shell, createRecordingPort(), {
          now: () => nowMs,
          schedule: (fn) => {
            tick = fn;
            return () => {
              tick = undefined;
            };
          },
        });
        try {
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({
            type: "inference.tool_call.end",
            data: { name: "run_shell", callId: "c1", arguments: "sleep 30" },
          });
          const index = streamRowCount(shell) - 1;
          expect(shell.streamLog[index]!.stat).toBeUndefined();

          nowMs = 65_000;
          tick?.();
          expect(shell.streamLog[index]!.stat).toBe("1:05");

          bridge.handle({
            type: "tool.done",
            data: { result: { callId: "c1", name: "run_shell", content: "ok", isError: false } },
          });
          // The elapsed clock was scaffolding for the wait, not a fact worth
          // keeping — the answer's own addendum takes the row over.
          expect(shell.streamLog[index]!.stat).not.toBe("1:05");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a diff call keeps its own +/- stat instead of an elapsed clock", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        let nowMs = 0;
        let tick: (() => void) | undefined;
        const bridge = attachSessionBridge(shell, createRecordingPort(), {
          now: () => nowMs,
          schedule: (fn) => {
            tick = fn;
            return () => {
              tick = undefined;
            };
          },
        });
        try {
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
          const before = shell.streamLog[index]!.stat;
          expect(before).toContain("+");

          nowMs = 65_000;
          tick?.();
          expect(shell.streamLog[index]!.stat).toBe(before);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("task checklist calls stay out of the transcript", () => {
  test("a manage_tasks call and its result paint no rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          appendStreamRow(shell, { role: "assistant", text: "planning the sweep" });
          const before = streamRowCount(shell);

          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "manage_tasks",
              callId: "mt-1",
              arguments: { action: "create", tasks: [{ title: "audit", status: "todo" }] },
            },
          });
          bridge.handle({
            type: "tool.done",
            data: {
              result: { callId: "mt-1", name: "manage_tasks", content: "ok", isError: false },
            },
          });

          // The list lives in the task panel; scrollback must not carry a
          // second copy of it.
          expect(streamRowCount(shell)).toBe(before);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("an errored manage_tasks result is dropped rather than left unpaired", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          const before = streamRowCount(shell);
          bridge.handle({
            type: "inference.tool_call.end",
            data: { name: "manage_tasks", callId: "mt-2", arguments: { action: "update" } },
          });
          bridge.handle({
            type: "tool.done",
            data: {
              result: { callId: "mt-2", name: "manage_tasks", content: "boom", isError: true },
            },
          });
          expect(streamRowCount(shell)).toBe(before);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("other tools still paint normally", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          const before = streamRowCount(shell);
          bridge.handle({
            type: "inference.tool_call.end",
            data: { name: "grep", callId: "g-1", arguments: { pattern: "zones" } },
          });
          expect(streamRowCount(shell)).toBeGreaterThan(before);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
