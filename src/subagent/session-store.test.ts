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
      data: { call: { id: "call-1", name: "run_shell", arguments: {} } },
    } as unknown as ReactorEmittedEvent);
    expect(store.get(session.id)?.currentToolName).toBe("run_shell");
    expect(store.get(session.id)?.currentToolStartedAt).toBe(5_000);

    clock = 95_000;
    store.appendEvent(session.id, {
      type: "tool.done",
      seq: 2,
      data: { result: { callId: "call-1", content: "ok", isError: false } },
    } as unknown as ReactorEmittedEvent);
    expect(store.get(session.id)?.currentToolName).toBeNull();
    expect(store.get(session.id)?.currentToolStartedAt).toBeNull();
  });

  test("a terminal transition never leaves a tool clock outstanding", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.appendEvent(session.id, startCall(1, "call-1", "grep"));
    expect(store.get(session.id)?.currentToolStartedAt).not.toBeNull();

    store.complete(session.id, "report");
    expect(store.get(session.id)?.currentToolStartedAt).toBeNull();
  });
});
