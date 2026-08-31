import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createSubAgentSessionStore } from "../../src/subagent/session-store.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, data } as ReactorEmittedEvent;
}

describe("createSubAgentSessionStore", () => {
  test("start records identity and brief; complete seals the report", () => {
    let t = 1000;
    const store = createSubAgentSessionStore({
      now: () => t,
      createId: () => "s-1",
    });
    const started = store.start({
      description: "map callers",
      agentId: "greybeard",
      brief: "# Dispatch brief: map callers\n\n## Goal\nFind callers of X",
    });
    expect(started).toMatchObject({
      id: "s-1",
      description: "map callers",
      agentId: "greybeard",
      status: "running",
      currentToolName: null,
      toolNames: [],
      entries: [],
      startedAt: 1000,
    });

    t = 1500;
    store.complete("s-1", "## Summary\nFound 3 callers.");
    const done = store.get("s-1");
    expect(done?.status).toBe("done");
    expect(done?.finishedAt).toBe(1500);
    expect(done?.report).toBe("## Summary\nFound 3 callers.");
    expect(done?.entries[done.entries.length - 1]).toEqual({
      kind: "report",
      content: "## Summary\nFound 3 callers.",
    });
  });

  test("appendEvent builds a transcript without requiring TUI types", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-2" });
    store.start({ description: "job", agentId: "worker", brief: "do it" });

    store.appendEvent("s-2", event("inference.text.delta", { token: "Hello " }));
    store.appendEvent("s-2", event("inference.text.delta", { token: "world" }));
    store.appendEvent("s-2", event("inference.tool_call.start", { name: "grep", callId: "c1" }));
    store.appendEvent(
      "s-2",
      event("inference.tool_call.delta", { argumentFragment: '{"pattern":' }),
    );
    store.appendEvent(
      "s-2",
      event("inference.tool_call.end", {
        name: "grep",
        callId: "c1",
        arguments: { pattern: "foo" },
      }),
    );
    store.appendEvent(
      "s-2",
      event("tool.done", {
        result: { callId: "c1", content: "match at a.ts:1", isError: false },
      }),
    );

    const session = store.get("s-2");
    expect(session?.toolNames).toEqual(["grep"]);
    expect(session?.currentToolName).toBeNull();
    expect(session?.entries).toEqual([
      { kind: "text", content: "Hello world" },
      {
        kind: "tool",
        callId: "c1",
        name: "grep",
        arguments: JSON.stringify({ pattern: "foo" }),
      },
      {
        kind: "tool_result",
        callId: "c1",
        name: "grep",
        content: "match at a.ts:1",
        isError: false,
      },
    ]);
  });

  test("interleaved parallel tool_call deltas attach to their own callId", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-parallel" });
    store.start({ description: "job", agentId: "worker", brief: "do it" });

    store.appendEvent(
      "s-parallel",
      event("inference.tool_call.start", { name: "read", callId: "a" }),
    );
    store.appendEvent(
      "s-parallel",
      event("inference.tool_call.start", { name: "grep", callId: "b" }),
    );
    // Deltas arrive interleaved for the two open calls; each fragment must land
    // on the entry that owns its callId, not the most recent tool entry.
    store.appendEvent(
      "s-parallel",
      event("inference.tool_call.delta", { callId: "a", argumentFragment: '{"path":' }),
    );
    store.appendEvent(
      "s-parallel",
      event("inference.tool_call.delta", { callId: "b", argumentFragment: '{"pattern":' }),
    );
    store.appendEvent(
      "s-parallel",
      event("inference.tool_call.delta", { callId: "a", argumentFragment: '"a.ts"}' }),
    );

    const session = store.get("s-parallel");
    const toolEntries = session?.entries.filter((e) => e.kind === "tool") ?? [];
    expect(toolEntries).toEqual([
      { kind: "tool", callId: "a", name: "read", arguments: '{"path":"a.ts"}' },
      { kind: "tool", callId: "b", name: "grep", arguments: '{"pattern":' },
    ]);
  });

  test("fail marks status and keeps the session for inspection", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-3" });
    store.start({ description: "boom", agentId: "worker", brief: "x" });
    store.fail("s-3", "provider 500");
    const session = store.get("s-3");
    expect(session?.status).toBe("failed");
    expect(session?.error).toBe("provider 500");
    expect(session?.entries[session.entries.length - 1]).toEqual({
      kind: "report",
      content: "Error: provider 500",
    });
  });

  test("prunes oldest completed sessions beyond maxCompleted", () => {
    const store = createSubAgentSessionStore({
      maxCompleted: 2,
      createId: (() => {
        let n = 0;
        return () => `s-${++n}`;
      })(),
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });
    for (let i = 0; i < 3; i++) {
      const s = store.start({ description: `job-${i}`, agentId: "w", brief: "b" });
      store.complete(s.id, `report ${i}`);
    }
    // A running session is never pruned by the completed bound.
    store.start({ description: "live", agentId: "w", brief: "b" });

    const ids = store
      .list()
      .map((s) => s.id)
      .sort();
    // s-1 pruned; s-2, s-3 completed retained; s-4 running.
    expect(ids).toEqual(["s-2", "s-3", "s-4"]);
    expect(store.get("s-1")).toBeUndefined();
  });

  test("subscribe notifies listeners on start, event, and complete", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-n" });
    let ticks = 0;
    const unsub = store.subscribe(() => {
      ticks += 1;
    });
    store.start({ description: "n", agentId: "w", brief: "b" });
    store.appendEvent("s-n", event("inference.text.delta", { token: "x" }));
    store.complete("s-n", "done");
    expect(ticks).toBe(3);
    unsub();
    store.clear();
    expect(ticks).toBe(3);
  });

  test("listForStrip puts running sessions first", () => {
    let t = 0;
    const store = createSubAgentSessionStore({
      now: () => ++t,
      createId: (() => {
        let n = 0;
        return () => `s-${++n}`;
      })(),
    });
    const a = store.start({ description: "old-done", agentId: "w", brief: "b" });
    store.complete(a.id, "ok");
    store.start({ description: "live", agentId: "w", brief: "b" });
    const strip = store.listForStrip();
    expect(strip[0]?.description).toBe("live");
    expect(strip[0]?.status).toBe("running");
    expect(strip[1]?.description).toBe("old-done");
  });

  test("cancel marks status, fires abort handle, and ignores late complete", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-cancel" });
    store.start({ description: "stuck", agentId: "worker", brief: "loop" });
    let aborted = 0;
    store.registerCancel("s-cancel", () => {
      aborted += 1;
    });
    expect(store.cancel("s-cancel", "operator kill")).toBe(true);
    const session = store.get("s-cancel");
    expect(session?.status).toBe("cancelled");
    expect(session?.error).toBe("operator kill");
    expect(session?.entries.at(-1)).toEqual({
      kind: "report",
      content: "Cancelled: operator kill",
    });
    expect(aborted).toBe(1);
    // Late complete from the child must not resurrect a cancelled session.
    store.complete("s-cancel", "should not win");
    expect(store.get("s-cancel")?.status).toBe("cancelled");
    expect(store.get("s-cancel")?.report).toBeUndefined();
    // Idempotent: second cancel is a no-op.
    expect(store.cancel("s-cancel")).toBe(false);
    expect(aborted).toBe(1);
  });

  test("cancelAll aborts every running session", () => {
    let n = 0;
    const store = createSubAgentSessionStore({
      createId: () => `s-${++n}`,
    });
    store.start({ description: "a", agentId: "w", brief: "b" });
    store.start({ description: "b", agentId: "w", brief: "b" });
    const done = store.start({ description: "done", agentId: "w", brief: "b" });
    store.complete(done.id, "ok");
    const aborted: string[] = [];
    store.registerCancel("s-1", () => aborted.push("s-1"));
    store.registerCancel("s-2", () => aborted.push("s-2"));
    store.registerCancel("s-3", () => aborted.push("s-3")); // already done — ignored
    const cancelled = store.cancelAll("Parent stop");
    expect(cancelled.sort()).toEqual(["s-1", "s-2"]);
    expect(aborted.sort()).toEqual(["s-1", "s-2"]);
    expect(store.get("s-1")?.status).toBe("cancelled");
    expect(store.get("s-2")?.status).toBe("cancelled");
    expect(store.get("s-3")?.status).toBe("done");
  });

  test("start records parentSessionId when the caller is a nested dispatch", () => {
    let n = 0;
    const store = createSubAgentSessionStore({ createId: () => `s-${++n}` });
    const orchestrator = store.start({ description: "orchestrate", agentId: "lead", brief: "b" });
    const nested = store.start({
      description: "nested worker",
      agentId: "helper",
      brief: "b",
      parentSessionId: orchestrator.id,
    });
    expect(nested.parentSessionId).toBe(orchestrator.id);
    expect(store.get(nested.id)?.parentSessionId).toBe(orchestrator.id);
    // Top-level sessions carry no parent link.
    expect(orchestrator.parentSessionId).toBeUndefined();
  });
});
