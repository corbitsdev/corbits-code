import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createSubAgentSessionStore } from "../../src/subagent/session-store.js";
import { createTaskTool } from "../../src/subagent/index.js";
import { createPermissionGate } from "../../src/permission/gate.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

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
    expect(session?.lifecycle.state).toBe("failed");
    expect(session?.lifecycleStatus).toBe("shutdown");
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

  test("cancel is not resumable and complete after cancel no-ops", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-cancel-resume" });
    store.start({ description: "stuck", agentId: "worker", brief: "loop", retained: true });
    store.markRunning("s-cancel-resume");
    store.registerFollowup("s-cancel-resume", async () => "nope");
    expect(store.cancel("s-cancel-resume", "operator kill")).toBe(true);
    const session = store.get("s-cancel-resume");
    expect(session?.status).toBe("cancelled");
    expect(session?.lifecycle.state).toBe("cancelled");
    expect(session?.lifecycleStatus).toBe("interrupted");
    expect(session?.retained).toBe(false);
    expect(store.resumeOne("s-cancel-resume", "more").ok).toBe(false);
    store.complete("s-cancel-resume", "should not win");
    expect(store.get("s-cancel-resume")?.lifecycle.state).toBe("cancelled");
    expect(store.get("s-cancel-resume")?.report).toBeUndefined();
  });

  test("interruptOne stays strip-running and resumable when retained", () => {
    const store = createSubAgentSessionStore({ createId: () => "s-int" });
    store.start({ description: "loop", agentId: "worker", brief: "b", retained: true });
    store.markRunning("s-int");
    store.registerInterrupt("s-int", () => {});
    store.registerFollowup("s-int", async () => "next");
    expect(store.interruptOne("s-int").ok).toBe(true);
    const session = store.get("s-int");
    expect(session?.lifecycle.state).toBe("interrupted");
    expect(session?.status).toBe("running");
    expect(session?.lifecycleStatus).toBe("interrupted");
    expect(store.resumeOne("s-int", "continue")).toEqual({ ok: true, status: "running" });
  });

  test("pinned completed sessions survive maxCompleted until unpin", () => {
    const store = createSubAgentSessionStore({
      maxCompleted: 1,
      createId: (() => {
        let n = 0;
        return () => `s-${++n}`;
      })(),
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });
    const pinned = store.start({ description: "keep", agentId: "w", brief: "b" });
    store.pin(pinned.id);
    store.complete(pinned.id, "keep");
    store.complete(store.start({ description: "a", agentId: "w", brief: "b" }).id, "a");
    store.complete(store.start({ description: "b", agentId: "w", brief: "b" }).id, "b");
    expect(store.get(pinned.id)).toBeDefined();
    store.unpin(pinned.id);
    store.complete(store.start({ description: "c", agentId: "w", brief: "b" }).id, "c");
    expect(store.get(pinned.id)).toBeUndefined();
  });
});

describe("createTaskTool session recording", () => {
  const provider = {
    providerName: "test",
    baseURL: "http://localhost",
    apiKey: "k",
    model: "m",
  };

  async function call(
    tool: ReturnType<typeof createTaskTool>,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await tool.handler(
      {
        id: "task-call-test",
        name: "task",
        arguments: args,
      },
      signal ?? new AbortController().signal,
    );
    if (typeof result === "string") return result;
    return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  }

  test("records a session on spawn and completes it with the report", async () => {
    const store = createSubAgentSessionStore();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: process.cwd(),
      getWorkdirBase: () => "/tmp",
      provider,
      sessions: store,
      run: async (params) => {
        params.onEvent?.(event("inference.text.delta", { token: "working" }));
        return { report: "## Summary\nDone." };
      },
    });
    const out = await call(tool, {
      description: "inspect store",
      prompt: "do the job",
      context: "background",
      intent: "explore",
    });
    expect(out).toContain("## Summary\nDone.");
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("done");
    expect(sessions[0]?.description).toBe("inspect store");
    expect(sessions[0]?.brief).toContain("## Goal");
    expect(sessions[0]?.brief).toContain("do the job");
    expect(sessions[0]?.entries.some((e) => e.kind === "text" && e.content === "working")).toBe(
      true,
    );
    expect(sessions[0]?.report).toBe("## Summary\nDone.");
  });

  test("records failure without throwing out of the tool handler", async () => {
    const store = createSubAgentSessionStore();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: process.cwd(),
      getWorkdirBase: () => "/tmp",
      provider,
      sessions: store,
      run: async () => {
        throw new Error("boom");
      },
    });
    const out = await call(tool, { description: "fail me", prompt: "x", intent: "explore" });
    expect(out).toContain("failed: boom");
    const session = store.list()[0];
    expect(session?.status).toBe("failed");
    expect(session?.error).toBe("boom");
  });

  test("does not require a store — spawn still works", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: process.cwd(),
      getWorkdirBase: () => "/tmp",
      provider,
      run: async () => ({ report: "ok" }),
    });
    const out = await call(tool, { description: "no store", prompt: "x", intent: "explore" });
    expect(out).toContain("ok");
  });

  test("strip cancel aborts the child run and marks the session cancelled", async () => {
    const store = createSubAgentSessionStore();
    let sawAbort = false;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: process.cwd(),
      getWorkdirBase: () => "/tmp",
      provider,
      sessions: store,
      run: async (params) => {
        // Simulate a long-running child that only exits when the operator cancels.
        await new Promise<void>((_resolve, reject) => {
          const signal = params.signal;
          if (signal === undefined) {
            reject(new Error("expected signal"));
            return;
          }
          if (signal.aborted) {
            sawAbort = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
          // Cancel from the strip after the run has registered its handle.
          queueMicrotask(() => {
            const id = store.list()[0]?.id;
            expect(id).toBeDefined();
            store.cancel(id!, "Cancelled from Agents strip");
          });
        });
        return { report: "should not complete" };
      },
    });
    const out = await call(tool, {
      description: "stuck looper",
      prompt: "spin",
      intent: "explore",
    });
    expect(out).toContain("cancelled by operator");
    expect(sawAbort).toBe(true);
    const session = store.list()[0];
    expect(session?.status).toBe("cancelled");
    expect(session?.error).toContain("Cancelled");
  });

  test("parent tool signal abort cancels the session", async () => {
    const store = createSubAgentSessionStore();
    const parent = new AbortController();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: process.cwd(),
      getWorkdirBase: () => "/tmp",
      provider,
      sessions: store,
      run: async (params) => {
        await new Promise<void>((_resolve, reject) => {
          const signal = params.signal!;
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
          queueMicrotask(() => parent.abort());
        });
        return { report: "nope" };
      },
    });
    const out = await call(
      tool,
      { description: "parent stop child", prompt: "x", intent: "explore" },
      parent.signal,
    );
    expect(out).toContain("cancelled by operator");
    expect(store.list()[0]?.status).toBe("cancelled");
  });
});
