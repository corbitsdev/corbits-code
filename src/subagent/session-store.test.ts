import { describe, expect, test } from "bun:test";

import { createSubAgentSessionStore } from "./session-store.js";

import type { ReactorEmittedEvent } from "@intx/inference";

function startCall(seq: number, callId: string, name: string) {
  return {
    type: "inference.tool_call.start" as const,
    seq,
    data: { name, callId, partial: { text: "" } },
  };
}

const textDelta = (token: string): ReactorEmittedEvent => ({
  type: "inference.text.delta",
  seq: 1,
  data: { token, partial: { text: token } },
});

test("appendEvent dedups repeated tool_call.start names in toolNames", () => {
  const store = createSubAgentSessionStore();
  const session = store.start({ description: "d", agentId: "a", brief: "b" });

  store.appendEvent(session.id, startCall(1, "call-1", "grep"));
  store.appendEvent(session.id, startCall(2, "call-2", "grep"));
  store.appendEvent(session.id, startCall(3, "call-3", "grep"));

  const stored = store.get(session.id);
  expect(stored?.toolNames).toEqual(["grep"]);
});

describe("session-store snapshot caching", () => {
  test("list() reuses the cached snapshot for a session unaffected by another session's notify", () => {
    const store = createSubAgentSessionStore();
    const a = store.start({ description: "a", agentId: "agent", brief: "brief-a" });
    const b = store.start({ description: "b", agentId: "agent", brief: "brief-b" });

    const before = store.list();
    const bBefore = before.find((s) => s.id === b.id);
    const aBefore = before.find((s) => s.id === a.id);

    store.appendEvent(a.id, textDelta("hello"));

    const after = store.list();
    const bAfter = after.find((s) => s.id === b.id);
    const aAfter = after.find((s) => s.id === a.id);

    expect(bAfter).toBe(bBefore);
    expect(aAfter).not.toBe(aBefore);
    expect(aAfter?.entries).toEqual([{ kind: "text", content: "hello" }]);
  });

  test("list() returns a stable reference across repeated calls when nothing changed", () => {
    const store = createSubAgentSessionStore();
    const a = store.start({ description: "a", agentId: "agent", brief: "brief" });

    const first = store.list().find((s) => s.id === a.id);
    const second = store.list().find((s) => s.id === a.id);

    expect(second).toBe(first);
  });

  test("get() reuses the cached snapshot until the session mutates again", () => {
    const store = createSubAgentSessionStore();
    const a = store.start({ description: "a", agentId: "agent", brief: "brief" });

    const first = store.get(a.id);
    const second = store.get(a.id);
    expect(second).toBe(first);

    store.appendEvent(a.id, textDelta("x"));

    const third = store.get(a.id);
    expect(third).not.toBe(second);
  });

  test("listForStrip reuses cached snapshots for sessions that did not change", () => {
    const store = createSubAgentSessionStore();
    const a = store.start({ description: "a", agentId: "agent", brief: "brief-a" });
    const b = store.start({ description: "b", agentId: "agent", brief: "brief-b" });

    const before = store.listForStrip();
    const bBefore = before.find((s) => s.id === b.id);

    store.appendEvent(a.id, textDelta("hello"));

    const after = store.listForStrip();
    const bAfter = after.find((s) => s.id === b.id);

    expect(bAfter).toBe(bBefore);
  });

  test("a reused session id (start replaces an existing entry) invalidates the stale cached snapshot", () => {
    const store = createSubAgentSessionStore();
    const first = store.start({ description: "a", agentId: "agent", brief: "first", id: "fixed" });
    store.list();

    store.start({ description: "a", agentId: "agent", brief: "second", id: "fixed" });
    const snapshot = store.get("fixed");

    expect(snapshot).not.toBe(first);
    expect(snapshot?.brief).toBe("second");
    expect(snapshot?.entries).toEqual([]);
  });
});

describe("outstanding tool clock", () => {
  // A worker inside one long tool call emits nothing until the result lands.
  // Without a start clock for that call, silence is indistinguishable from a
  // wedged reactor, and a whole fleet running shell commands reads as stalled.
  test("tool.start stamps the clock and tool.done clears it", () => {
    let clock = 1_000;
    const store = createSubAgentSessionStore({ now: () => clock });
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    expect(store.get(session.id)?.currentToolStartedAt).toBeNull();

    clock = 5_000;
    store.appendEvent(session.id, {
      type: "tool.start",
      seq: 1,
      data: {
        call: {
          id: "call-1",
          name: "run_shell",
          arguments: { command: "bun test" },
        },
      },
    } as unknown as ReactorEmittedEvent);
    expect(store.get(session.id)?.currentToolName).toBe("run_shell");
    expect(store.get(session.id)?.currentToolPreview).toBe("bun test");
    expect(store.get(session.id)?.currentToolStartedAt).toBe(5_000);

    clock = 95_000;
    store.appendEvent(session.id, {
      type: "tool.done",
      seq: 2,
      data: { result: { callId: "call-1", content: "ok", isError: false } },
    } as unknown as ReactorEmittedEvent);
    expect(store.get(session.id)?.currentToolName).toBeNull();
    expect(store.get(session.id)?.currentToolPreview).toBeNull();
    expect(store.get(session.id)?.currentToolStartedAt).toBeNull();
  });

  test("a terminal transition never leaves a tool clock outstanding", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.appendEvent(session.id, startCall(1, "call-1", "grep"));
    expect(store.get(session.id)?.currentToolStartedAt).not.toBeNull();

    store.complete(session.id, "report");
    expect(store.get(session.id)?.currentToolStartedAt).toBeNull();
    expect(store.get(session.id)?.currentToolPreview).toBeNull();
  });

  // CL-5765: argument streaming must refresh the preview so a partial command
  // does not stick on the lane after the rest of the args arrive.
  test("streaming arguments refresh the lane preview from the same payload the transcript holds", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });

    store.appendEvent(session.id, {
      type: "inference.tool_call.start",
      seq: 1,
      data: { name: "run_shell", callId: "call-1" },
    } as unknown as ReactorEmittedEvent);
    store.appendEvent(session.id, {
      type: "inference.tool_call.delta",
      seq: 2,
      data: { callId: "call-1", argumentFragment: '{"command":"bun te' },
    } as unknown as ReactorEmittedEvent);
    // Incomplete JSON — no preview yet.
    expect(store.get(session.id)?.currentToolPreview).toBeNull();

    store.appendEvent(session.id, {
      type: "inference.tool_call.delta",
      seq: 3,
      data: { callId: "call-1", argumentFragment: 'st"}' },
    } as unknown as ReactorEmittedEvent);
    expect(store.get(session.id)?.currentToolPreview).toBe("bun test");
    expect(store.get(session.id)?.entries[0]).toMatchObject({
      kind: "tool",
      arguments: '{"command":"bun test"}',
    });
  });
});

describe("parallel tool calls", () => {
  const toolStart = (callId: string, name: string) =>
    ({
      type: "tool.start",
      seq: 1,
      data: { call: { id: callId, name, arguments: {} } },
    }) as unknown as ReactorEmittedEvent;
  const toolDone = (callId: string) =>
    ({
      type: "tool.done",
      seq: 2,
      data: { result: { callId, content: "ok", isError: false } },
    }) as unknown as ReactorEmittedEvent;

  // The reactor runs parallel calls concurrently. A fast sibling finishing must
  // not retire the clock of a long call still executing, or the lane reads as
  // silent-for-no-reason thirty seconds later while it is working perfectly.
  test("a fast sibling completing leaves a long call's clock outstanding", () => {
    let clock = 1_000;
    const store = createSubAgentSessionStore({ now: () => clock });
    const session = store.start({ description: "d", agentId: "a", brief: "b" });

    store.appendEvent(session.id, toolStart("slow", "run_shell"));
    clock = 2_000;
    store.appendEvent(session.id, toolStart("fast", "grep"));
    clock = 3_000;
    store.appendEvent(session.id, toolDone("fast"));

    const stored = store.get(session.id);
    expect(stored?.currentToolName).toBe("run_shell");
    expect(stored?.currentToolStartedAt).toBe(1_000);
  });

  test("a completion bearing an unknown call id retires nothing", () => {
    let clock = 1_000;
    const store = createSubAgentSessionStore({ now: () => clock });
    const session = store.start({ description: "d", agentId: "a", brief: "b" });

    store.appendEvent(session.id, toolStart("slow", "run_shell"));
    clock = 4_000;
    store.appendEvent(session.id, toolDone("never-started"));

    expect(store.get(session.id)?.currentToolStartedAt).toBe(1_000);
  });

  // The oldest live call is the one that explains the longest silence, so it is
  // the one the lane reports.
  test("the reported call is the oldest still outstanding", () => {
    let clock = 1_000;
    const store = createSubAgentSessionStore({ now: () => clock });
    const session = store.start({ description: "d", agentId: "a", brief: "b" });

    store.appendEvent(session.id, toolStart("first", "run_shell"));
    clock = 2_000;
    store.appendEvent(session.id, toolStart("second", "grep"));
    expect(store.get(session.id)?.currentToolName).toBe("run_shell");

    clock = 3_000;
    store.appendEvent(session.id, toolDone("first"));
    const stored = store.get(session.id);
    expect(stored?.currentToolName).toBe("grep");
    expect(stored?.currentToolStartedAt).toBe(2_000);
  });

  test("the last completion retires the clock entirely", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.appendEvent(session.id, toolStart("only", "run_shell"));
    store.appendEvent(session.id, toolDone("only"));

    expect(store.get(session.id)?.currentToolName).toBeNull();
    expect(store.get(session.id)?.currentToolStartedAt).toBeNull();
  });
});

describe("terminal stop reasons", () => {
  test("complete() records the report's Stopped line as stopReason", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.complete(
      session.id,
      'Stopped: repetition — window "Groaning. " × 1363\n\n## Summary\nStopped: degenerate repetition in streamed output (same window looping mid-turn).',
    );
    const stored = store.get(session.id);
    expect(stored?.status).toBe("done");
    expect(stored?.stopReason).toBe('repetition — window "Groaning. " × 1363');
  });

  test("a clean complete has no stopReason", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.complete(session.id, "## Summary\nDone.\n\n## Findings\nx");
    expect(store.get(session.id)?.stopReason).toBeUndefined();
  });

  test("cancel() records the cancel reason as stopReason", () => {
    const store = createSubAgentSessionStore();
    const withReason = store.start({ description: "d", agentId: "a", brief: "b" });
    store.cancel(withReason.id, "Session closed");
    expect(store.get(withReason.id)?.stopReason).toBe("cancelled — Session closed");

    const bare = store.start({ description: "d2", agentId: "a", brief: "b" });
    store.cancel(bare.id);
    expect(store.get(bare.id)?.stopReason).toBe("cancelled");
  });
});

describe("CL-6943 reusable worker sessions", () => {
  test("a completed retained session stays open and reusable; resume_agent reopens it", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    expect(store.get(session.id)?.lifecycleStatus).toBe("running");

    store.complete(session.id, "## Summary\nDone.");
    expect(store.get(session.id)?.lifecycleStatus).toBe("completed");
    expect(store.get(session.id)?.retained).toBe(true);

    const outcome = store.resumeOne(session.id);
    expect(outcome).toEqual({ ok: true });
    expect(store.get(session.id)?.lifecycleStatus).toBe("running");
  });

  test("resume_agent fails on a session that was never retained", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.complete(session.id, "## Summary\nDone.");
    expect(store.resumeOne(session.id)).toEqual({ ok: false, status: "completed" });
  });

  test("resume_agent fails on an unknown id with not_found", () => {
    const store = createSubAgentSessionStore();
    expect(store.resumeOne("missing")).toEqual({ ok: false, status: "not_found" });
  });

  test("closeOne is bounded by its deadline when the registered close hangs forever", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.registerClose(session.id, () => new Promise<void>(() => {})); // never resolves

    const started = Date.now();
    const status = await store.closeOne(session.id, 25);
    expect(Date.now() - started).toBeLessThan(500);
    expect(status).toBe("shutdown");
    expect(store.get(session.id)?.lifecycleStatus).toBe("shutdown");
    expect(store.get(session.id)?.retained).toBe(false);
  });

  test("closeOne is idempotent and returns not_found for an unknown id", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    let closeCalls = 0;
    store.registerClose(session.id, async () => {
      closeCalls += 1;
    });

    expect(await store.closeOne(session.id, 1000)).toBe("shutdown");
    expect(await store.closeOne(session.id, 1000)).toBe("shutdown");
    expect(closeCalls).toBe(1);
    expect(await store.closeOne("missing", 1000)).toBe("not_found");
  });

  test("resume_agent fails on a session close_agent already shut down (close is permanent)", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.complete(session.id, "## Summary\nDone.");
    await store.closeOne(session.id, 1000);
    expect(store.resumeOne(session.id)).toEqual({ ok: false, status: "shutdown" });
  });

  test("pruneCompleted does not evict a retained, still-open session past maxCompleted", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 1 });
    const retained = store.start({
      description: "keep-me",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.complete(retained.id, "## Summary\nDone.");

    for (let i = 0; i < 3; i++) {
      const s = store.start({ description: `fill-${i}`, agentId: "a", brief: "b" });
      store.complete(s.id, "## Summary\nDone.");
    }

    expect(store.get(retained.id)).toBeDefined();
    expect(store.get(retained.id)?.lifecycleStatus).toBe("completed");
  });

  test("once closed, a retained session becomes a normal finished record subject to the cap", async () => {
    const store = createSubAgentSessionStore({ maxCompleted: 1 });
    const retained = store.start({
      description: "keep-me",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.complete(retained.id, "## Summary\nDone.");
    await store.closeOne(retained.id, 1000);

    for (let i = 0; i < 3; i++) {
      const s = store.start({ description: `fill-${i}`, agentId: "a", brief: "b" });
      store.complete(s.id, "## Summary\nDone.");
    }

    // No longer exempt — the cap may have evicted it like any other record.
    expect(store.get(retained.id)).toBeUndefined();
  });
});
