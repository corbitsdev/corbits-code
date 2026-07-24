import { describe, expect, test } from "bun:test";

import { createSubAgentSessionStore } from "./session-store.js";

import type { ReactorEmittedEvent } from "@intx/inference";

const textDelta = (token: string): ReactorEmittedEvent => ({
  type: "inference.text.delta",
  seq: 1,
  data: { token, partial: { text: token } },
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

    const restarted = store.start({ description: "a", agentId: "agent", brief: "second", id: "fixed" });
    const snapshot = store.get("fixed");

    expect(snapshot).not.toBe(first);
    expect(snapshot?.brief).toBe("second");
    expect(snapshot?.entries).toEqual([]);
  });
});
