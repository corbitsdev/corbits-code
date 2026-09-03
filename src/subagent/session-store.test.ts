import { describe, expect, test } from "bun:test";

import { createSubAgentSessionStore, DEFAULT_MAX_ENTRY_CHARS } from "./session-store.js";
import { forcedStopReport } from "./stop-policy.js";
import { agentLaneIsLive, fleetProgress } from "../tui/agent-progress.js";
import { formatAgentsPanel } from "../tui/chrome-state.js";

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
  test("complete() records the typed stopReason, not report prose", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.complete(session.id, forcedStopReport("stalled", "partial"), { stopReason: "stalled" });
    expect(store.get(session.id)?.stopReason).toBe("stalled");
  });

  test("literal Stopped: in report prose does not fabricate stopReason", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.complete(
      session.id,
      'Stopped: repetition — window "Groaning. " × 1363\n\n## Summary\nStopped: looping.\n\n## Findings\nx',
    );
    expect(store.get(session.id)?.stopReason).toBeUndefined();
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

    store.registerFollowup(session.id, async () => "next turn");
    store.complete(session.id, "## Summary\nDone.");
    expect(store.get(session.id)?.lifecycleStatus).toBe("completed");
    expect(store.get(session.id)?.retained).toBe(true);

    const outcome = store.resumeOne(session.id, "continue");
    expect(outcome).toEqual({ ok: true, status: "running" });
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.lifecycleStatus).toBe("running");
  });

  test("resume-from-completed is a live turn: send_input, interrupt, and appendEvent work", async () => {
    let finish: (reply: string) => void = () => {};
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    const delivered: string[] = [];
    store.registerDeliver(session.id, (message) => {
      delivered.push(message);
    });
    store.registerInterrupt(session.id, () => {});
    store.registerFollowup(
      session.id,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    store.complete(session.id, "## Summary\nDone.");
    expect(store.get(session.id)?.status).toBe("done");
    expect(store.get(session.id)?.lifecycleStatus).toBe("completed");

    expect(store.resumeOne(session.id, "continue")).toEqual({ ok: true, status: "running" });
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.lifecycleStatus).toBe("running");
    expect(store.get(session.id)?.finishedAt).toBeUndefined();

    expect(store.sendInputOne(session.id, "steer mid-turn")).toEqual({
      ok: true,
      status: "running",
    });
    expect(delivered).toEqual(["steer mid-turn"]);

    store.appendEvent(session.id, startCall(1, "call-1", "grep"));
    const afterTool = store.get(session.id);
    if (afterTool === undefined) throw new Error("session missing after tool start");
    expect(afterTool.toolNames).toContain("grep");
    expect(afterTool.outstandingTools).toHaveLength(1);
    expect(afterTool.currentToolName).toBe("grep");
    expect(agentLaneIsLive(afterTool)).toBe(true);
    expect(fleetProgress(store.list(), Date.now()).running).toBe(1);

    expect(store.interruptOne(session.id).ok).toBe(true);
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.lifecycleStatus).toBe("interrupted");

    finish("later");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.lifecycleStatus).toBe("interrupted");
    expect(store.get(session.id)?.report).toBe("## Summary\nDone.");
  });

  test("rejected followup restores strip status so interrupt_agent fails closed", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    store.registerInterrupt(session.id, () => {});
    store.registerFollowup(session.id, async () => {
      throw new Error("send failed");
    });
    store.complete(session.id, "## Summary\nDone.");
    expect(store.get(session.id)?.status).toBe("done");
    expect(store.get(session.id)?.lifecycleStatus).toBe("completed");

    expect(store.resumeOne(session.id, "continue")).toEqual({ ok: true, status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = store.get(session.id);
    expect(after?.status).toBe("done");
    expect(after?.lifecycleStatus).toBe("completed");
    expect(store.interruptOne(session.id)).toEqual({ ok: false, status: "completed" });
  });

  test("interrupt then abort does not overwrite interrupted stamp to completed", async () => {
    let rejectFollowup: (err: unknown) => void = () => {};
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    store.registerInterrupt(session.id, () => {});
    store.registerFollowup(
      session.id,
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFollowup = reject;
        }),
    );
    store.complete(session.id, "## Summary\nDone.");

    expect(store.resumeOne(session.id, "continue")).toEqual({ ok: true, status: "running" });
    expect(store.interruptOne(session.id).ok).toBe(true);
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.lifecycleStatus).toBe("interrupted");

    rejectFollowup(new Error("aborted"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = store.get(session.id);
    expect(after?.status).toBe("running");
    expect(after?.lifecycleStatus).toBe("interrupted");
  });

  test("resume_agent fails on a session that was never retained", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.complete(session.id, "## Summary\nDone.");
    expect(store.resumeOne(session.id, "more")).toEqual({ ok: false, status: "completed" });
  });

  test("resume_agent validates the message before starting a retained turn", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    let starts = 0;
    store.registerFollowup(session.id, async () => {
      starts++;
      return "should not run";
    });
    store.complete(session.id, "## Summary\nDone.");

    expect(store.resumeOne(session.id, "   ")).toEqual({
      ok: false,
      status: "completed",
      hint: "resume_agent requires a non-empty message.",
    });
    expect(store.resumeOne(session.id, "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1))).toEqual({
      ok: false,
      status: "completed",
      hint:
        `resume_agent message exceeds ${DEFAULT_MAX_ENTRY_CHARS} characters ` +
        `(got ${DEFAULT_MAX_ENTRY_CHARS + 1}).`,
    });
    expect(starts).toBe(0);
    expect(store.get(session.id)?.lifecycleStatus).toBe("completed");
  });

  test("resume_agent fails on an unknown id with not_found", () => {
    const store = createSubAgentSessionStore();
    expect(store.resumeOne("missing", "more")).toEqual({ ok: false, status: "not_found" });
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
    // registerClose always fires in production before onAgentReady's window
    // closes (CL-7001) — closeOne otherwise waits for it up to the deadline.
    store.registerClose(session.id, async () => {});
    store.complete(session.id, "## Summary\nDone.");
    await store.closeOne(session.id, 1000);
    expect(store.resumeOne(session.id, "more")).toEqual({ ok: false, status: "shutdown" });
  });

  // CL-7001 originally folded a retained, still-open session into
  // maxCompleted (the TUI display cap) with no separate bound at all,
  // fixing the unbounded leak but creating a new bug: resume_agent
  // fails once more than `maxCompleted` (default 20) workers
  // have spawned, even though every one of them is still perfectly
  // reusable. CL-7007 gives open retained sessions their own cap
  // (`maxRetained`) instead — this test changed from asserting that
  // `maxCompleted` evicts a retained session (no longer true: retained
  // sessions are excluded from that cap, see isOpenRetained) to asserting
  // that `maxRetained` does, with the same "handles still get released"
  // guarantee.
  test("pruneRetained evicts a retained, still-open session past maxRetained and releases it", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 1, maxRetained: 1 });
    const retained = store.start({
      description: "keep-me",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    let closed = false;
    store.registerClose(retained.id, async () => {
      closed = true;
    });
    store.complete(retained.id, "## Summary\nDone.");

    for (let i = 0; i < 3; i++) {
      const s = store.start({
        description: `fill-${i}`,
        agentId: "a",
        brief: "b",
        retained: true,
      });
      store.registerClose(s.id, async () => {});
      store.complete(s.id, "## Summary\nDone.");
    }

    expect(store.get(retained.id)).toBeUndefined();
    expect(closed).toBe(true);
  });

  // CL-7002's fix (retained sessions are no longer exempt from any cap) must
  // survive CL-7007: a non-retained finished session still obeys
  // maxCompleted exactly as before.
  test("maxCompleted still evicts an ordinary (non-retained) finished session", () => {
    const store = createSubAgentSessionStore({ maxCompleted: 1 });
    const first = store.start({ description: "first", agentId: "a", brief: "b" });
    store.complete(first.id, "## Summary\nDone.");

    for (let i = 0; i < 3; i++) {
      const s = store.start({ description: `fill-${i}`, agentId: "a", brief: "b" });
      store.complete(s.id, "## Summary\nDone.");
    }

    expect(store.get(first.id)).toBeUndefined();
  });

  test("resume_agent on a retention-evicted session returns an actionable status, not not_found", () => {
    const store = createSubAgentSessionStore({ maxRetained: 1 });
    const retained = store.start({
      description: "keep-me",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.registerClose(retained.id, async () => {});
    store.complete(retained.id, "## Summary\nDone.");

    for (let i = 0; i < 3; i++) {
      const s = store.start({
        description: `fill-${i}`,
        agentId: "a",
        brief: "b",
        retained: true,
      });
      store.registerClose(s.id, async () => {});
      store.complete(s.id, "## Summary\nDone.");
    }

    const outcome = store.resumeOne(retained.id, "more");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe("completed");
      expect(outcome.hint).toMatch(/read_agent_trace/);
    }
  });

  test("a running session is never evicted by maxRetained even when the cap is exceeded", () => {
    const store = createSubAgentSessionStore({ maxRetained: 1 });
    const running = store.start({
      description: "keep-me",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.markRunning(running.id);
    // Resume it back to "running" so it is an open, actively-driven session.
    store.registerClose(running.id, async () => {});
    store.registerFollowup(running.id, () => new Promise<string>(() => {}));
    store.complete(running.id, "## Summary\nDone.");
    store.resumeOne(running.id, "keep going");
    expect(store.get(running.id)?.lifecycleStatus).toBe("running");

    for (let i = 0; i < 5; i++) {
      const s = store.start({
        description: `fill-${i}`,
        agentId: "a",
        brief: "b",
        retained: true,
      });
      store.registerClose(s.id, async () => {});
      store.complete(s.id, "## Summary\nDone.");
    }

    expect(store.get(running.id)).toBeDefined();
    expect(store.get(running.id)?.lifecycleStatus).toBe("running");
  });

  test("maxRetained bounds memory: many spawned-and-completed retained sessions do not grow without limit", () => {
    const store = createSubAgentSessionStore({ maxRetained: 5 });
    for (let i = 0; i < 50; i++) {
      const s = store.start({
        description: `worker-${i}`,
        agentId: "a",
        brief: "b",
        retained: true,
      });
      store.registerClose(s.id, async () => {});
      store.complete(s.id, "## Summary\nDone.");
    }
    const openRetained = store
      .list()
      .filter((s) => s.retained === true && s.lifecycleStatus === "completed");
    expect(openRetained.length).toBeLessThanOrEqual(5);
  });

  test("once closed, a retained session becomes a normal finished record subject to the cap", async () => {
    const store = createSubAgentSessionStore({ maxCompleted: 1 });
    const retained = store.start({
      description: "keep-me",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.registerClose(retained.id, async () => {});
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

describe("interrupt stamps finishedAt once", () => {
  test("interruptOne sets finishedAt, keeps status running, and preserves tools", () => {
    let t = 1000;
    const store = createSubAgentSessionStore({
      now: () => t,
      createId: () => "s-int",
    });
    const session = store.start({
      description: "looping",
      agentId: "explorer",
      brief: "b",
      retained: true,
    });
    store.markRunning(session.id);
    store.appendEvent(session.id, startCall(1, "call-1", "run_shell"));
    store.registerInterrupt(session.id, () => {});

    t = 2000;
    expect(store.interruptOne(session.id).ok).toBe(true);
    const after = store.get(session.id);
    expect(after?.status).toBe("running");
    expect(after?.lifecycleStatus).toBe("interrupted");
    expect(after?.finishedAt).toBe(2000);
    expect(after?.outstandingTools).toHaveLength(1);
    expect(after?.currentToolName).toBe("run_shell");

    t = 3500;
    expect(store.interruptOne(session.id).ok).toBe(true);
    expect(store.get(session.id)?.finishedAt).toBe(2000);
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.outstandingTools).toHaveLength(1);
  });

  test("sendInputOne interrupt starts a live follow-up turn and keeps tools", async () => {
    let t = 1000;
    let finish: (reply: string) => void = () => {};
    const store = createSubAgentSessionStore({
      now: () => t,
      createId: () => "s-send",
    });
    const session = store.start({
      description: "looping",
      agentId: "explorer",
      brief: "b",
      retained: true,
    });
    store.markRunning(session.id);
    store.appendEvent(session.id, startCall(1, "call-1", "run_shell"));
    store.registerInterrupt(session.id, () => {});
    store.registerFollowup(
      session.id,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    t = 2500;
    const outcome = store.sendInputOne(session.id, "stop that", { interrupt: true });
    expect(outcome).toEqual({ ok: true, status: "interrupted" });
    const after = store.get(session.id);
    expect(after?.status).toBe("running");
    expect(after?.lifecycleStatus).toBe("running");
    expect(after?.finishedAt).toBeUndefined();
    expect(after?.outstandingTools).toHaveLength(1);

    t = 4000;
    expect(store.interruptOne(session.id).ok).toBe(true);
    expect(store.get(session.id)?.finishedAt).toBe(4000);

    t = 5000;
    finish("later");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get(session.id)?.status).toBe("running");
    expect(store.get(session.id)?.lifecycleStatus).toBe("interrupted");
    expect(store.get(session.id)?.finishedAt).toBe(4000);
  });

  test("a follow-up turn keeps the lane live past the linger window until it completes", async () => {
    let t = 1000;
    let finish: (reply: string) => void = () => {};
    const store = createSubAgentSessionStore({
      now: () => t,
      createId: () => "s-followup",
    });
    const session = store.start({
      description: "looping",
      agentId: "explorer",
      brief: "b",
      retained: true,
    });
    store.markRunning(session.id);
    store.registerInterrupt(session.id, () => {});
    store.registerFollowup(
      session.id,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    t = 2000;
    expect(store.interruptOne(session.id).ok).toBe(true);
    expect(store.get(session.id)?.finishedAt).toBe(2000);

    t = 3000;
    const outcome = store.resumeOne(session.id, "keep going");
    expect(outcome).toEqual({ ok: true, status: "running" });

    t = 11_000;
    store.appendEvent(session.id, startCall(1, "call-1", "run_shell"));
    const live = store.list();
    expect(live[0]?.lifecycleStatus).toBe("running");
    expect(live[0]?.finishedAt).toBeUndefined();
    expect(agentLaneIsLive(live[0]!)).toBe(true);
    expect(formatAgentsPanel(live, undefined, t)?.[0]?.status).toBe("running");
    expect(fleetProgress(live, t).running).toBe(1);

    t = 12_000;
    finish("done");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const terminal = store.list();
    expect(terminal[0]?.status).toBe("done");
    expect(terminal[0]?.lifecycleStatus).toBe("completed");
    expect(terminal[0]?.finishedAt).toBe(12_000);
    expect(agentLaneIsLive(terminal[0]!)).toBe(false);
    expect(fleetProgress(terminal, t).running).toBe(0);
  });
});

describe("CL-7269 one stored worker lifecycle", () => {
  test("complete() after interrupt_agent does not overwrite interrupted", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    store.registerInterrupt(session.id, () => {});
    expect(store.interruptOne(session.id).ok).toBe(true);
    store.complete(session.id, "late original send");
    const after = store.get(session.id);
    expect(after?.lifecycle.state).toBe("interrupted");
    expect(after?.lifecycleStatus).toBe("interrupted");
    expect(after?.report).toBeUndefined();
  });

  test("fail() of a live persisted agent invokes the registered close", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    let closeCalls = 0;
    store.registerClose(session.id, async () => {
      closeCalls++;
    });
    store.fail(session.id, "send failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
    expect(store.get(session.id)?.lifecycle.state).toBe("failed");
    const started = Date.now();
    const status = await store.closeOne(session.id, 5000);
    expect(Date.now() - started).toBeLessThan(200);
    expect(status).toBe("shutdown");
    expect(store.get(session.id)?.lifecycle.state).toBe("failed");
    expect(closeCalls).toBe(1);
  });

  test("closeOne still tears down a leftover close handle after fail()", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b", retained: true });
    store.markRunning(session.id);
    let closeCalls = 0;
    store.fail(session.id, "send failed");
    store.registerClose(session.id, async () => {
      closeCalls++;
    });
    const status = await store.closeOne(session.id, 5000);
    expect(status).toBe("shutdown");
    expect(closeCalls).toBe(1);
    expect(store.get(session.id)?.lifecycle.state).toBe("failed");
  });

  test("fail() stores failed, projects strip failed and verb shutdown", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.fail(session.id, "provider 500");
    const after = store.get(session.id);
    expect(after?.status).toBe("failed");
    expect(after?.lifecycle.state).toBe("failed");
    expect(after?.lifecycleStatus).toBe("shutdown");
    expect(after?.error).toBe("provider 500");
  });

  test("cancel() is not resumable; interruptOne() is when retained", () => {
    const store = createSubAgentSessionStore();
    const cancelled = store.start({
      description: "c",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.markRunning(cancelled.id);
    store.registerFollowup(cancelled.id, async () => "nope");
    expect(store.cancel(cancelled.id, "operator kill")).toBe(true);
    const afterCancel = store.get(cancelled.id);
    expect(afterCancel?.status).toBe("cancelled");
    expect(afterCancel?.lifecycle.state).toBe("cancelled");
    expect(afterCancel?.lifecycleStatus).toBe("interrupted");
    expect(afterCancel?.retained).toBe(false);
    expect(store.resumeOne(cancelled.id, "continue").ok).toBe(false);

    const interrupted = store.start({
      description: "i",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.markRunning(interrupted.id);
    store.registerInterrupt(interrupted.id, () => {});
    store.registerFollowup(interrupted.id, async () => "next");
    expect(store.interruptOne(interrupted.id).ok).toBe(true);
    const afterInterrupt = store.get(interrupted.id);
    expect(afterInterrupt?.lifecycle.state).toBe("interrupted");
    expect(afterInterrupt?.status).toBe("running");
    expect(afterInterrupt?.lifecycleStatus).toBe("interrupted");
    expect(afterInterrupt?.retained).toBe(true);
    expect(store.resumeOne(interrupted.id, "continue")).toEqual({ ok: true, status: "running" });
  });

  test("complete() after cancel() no-ops", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.cancel(session.id, "operator kill");
    store.complete(session.id, "should not win");
    const after = store.get(session.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.lifecycle.state).toBe("cancelled");
    expect(after?.report).toBeUndefined();
  });

  test("pin keeps a session past maxCompleted; unpin allows prune", () => {
    let n = 0;
    let t = 0;
    const store = createSubAgentSessionStore({
      maxCompleted: 1,
      createId: () => `s-${++n}`,
      now: () => ++t,
    });
    const pinned = store.start({ description: "keep", agentId: "a", brief: "b" });
    store.pin(pinned.id);
    store.complete(pinned.id, "report keep");

    const extra1 = store.start({ description: "drop-me", agentId: "a", brief: "b" });
    store.complete(extra1.id, "report extra");
    expect(store.get(pinned.id)?.id).toBe(pinned.id);
    expect(store.get(extra1.id)?.id).toBe(extra1.id);

    const extra2 = store.start({ description: "also", agentId: "a", brief: "b" });
    store.complete(extra2.id, "report also");
    expect(store.get(pinned.id)).toBeDefined();
    expect(store.get(extra1.id)).toBeUndefined();
    expect(store.get(extra2.id)).toBeDefined();

    store.unpin(pinned.id);
    const extra3 = store.start({ description: "prune-pinned", agentId: "a", brief: "b" });
    store.complete(extra3.id, "report prune");
    expect(store.get(pinned.id)).toBeUndefined();
    expect(store.get(extra3.id)).toBeDefined();
  });

  test("closeOne after fail() returns immediately and leaves stored failed", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.fail(session.id, "provider 500");
    const started = Date.now();
    const status = await store.closeOne(session.id, 5000);
    expect(Date.now() - started).toBeLessThan(200);
    expect(status).toBe("shutdown");
    expect(store.get(session.id)?.lifecycle.state).toBe("failed");
  });

  test("closeOne during setup then fail() does not wait the deadline", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    const started = Date.now();
    const closePromise = store.closeOne(session.id, 5000);
    setTimeout(() => store.fail(session.id, "boom"), 15);
    expect(await closePromise).toBe("shutdown");
    expect(Date.now() - started).toBeLessThan(200);
    expect(store.get(session.id)?.lifecycle.state).toBe("failed");
  });

  test("start() reuse of an id drops leftover pins", () => {
    let t = 0;
    const store = createSubAgentSessionStore({
      maxCompleted: 1,
      now: () => ++t,
    });
    store.start({ id: "reuse", description: "old", agentId: "a", brief: "b" });
    store.pin("reuse");
    store.start({ id: "reuse", description: "new", agentId: "a", brief: "b" });
    store.complete("reuse", "new report");
    const extra = store.start({ description: "other", agentId: "a", brief: "b" });
    store.complete(extra.id, "other report");
    const extra2 = store.start({ description: "prune", agentId: "a", brief: "b" });
    store.complete(extra2.id, "prune report");
    expect(store.get("reuse")).toBeUndefined();
  });
});

describe("pending ask_director", () => {
  test("soft sendInputOne resolves a pending ask without deliver", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({ description: "d", agentId: "a", brief: "b" });
    store.markRunning(session.id);
    const delivered: string[] = [];
    store.registerDeliver(session.id, (message) => {
      delivered.push(message);
    });
    let resolved: string | undefined;
    expect(
      store.registerAsk(session.id, {
        question: "which file?",
        questionId: "ask-1",
        resolve: (answer) => {
          resolved = answer;
        },
        reject: () => {
          throw new Error("should not reject");
        },
      }),
    ).toBe(true);
    expect(store.hasPendingAsk(session.id)).toBe(true);
    expect(store.peekAsk(session.id)).toEqual({ question: "which file?", questionId: "ask-1" });

    expect(store.sendInputOne(session.id, "src/foo.ts")).toEqual({ ok: true, status: "running" });
    expect(resolved).toBe("src/foo.ts");
    expect(delivered).toEqual([]);
    expect(store.hasPendingAsk(session.id)).toBe(false);
  });

  test("interruptOne cancels a pending ask", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({
      description: "d",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.markRunning(session.id);
    store.registerInterrupt(session.id, () => {});
    store.registerFollowup(session.id, async () => "next");
    let rejected: unknown;
    store.registerAsk(session.id, {
      question: "which file?",
      questionId: "ask-1",
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: (reason) => {
        rejected = reason;
      },
    });

    expect(store.interruptOne(session.id).ok).toBe(true);
    expect(store.hasPendingAsk(session.id)).toBe(false);
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toContain("interrupted");
  });

  test("sendInputOne interrupt cancels then followup", async () => {
    const store = createSubAgentSessionStore();
    const session = store.start({
      description: "d",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.markRunning(session.id);
    const delivered: string[] = [];
    store.registerDeliver(session.id, (message) => {
      delivered.push(message);
    });
    store.registerInterrupt(session.id, () => {});
    const followups: string[] = [];
    store.registerFollowup(session.id, async (message) => {
      followups.push(message);
      return "later";
    });
    let rejected: unknown;
    store.registerAsk(session.id, {
      question: "which file?",
      questionId: "ask-1",
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: (reason) => {
        rejected = reason;
      },
    });

    expect(store.sendInputOne(session.id, "stop that", { interrupt: true })).toEqual({
      ok: true,
      status: "interrupted",
    });
    expect(store.hasPendingAsk(session.id)).toBe(false);
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toContain("cancelled by send_input interrupt");
    expect(delivered).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(followups).toEqual(["stop that"]);
  });

  test("sendInputOne interrupt cancels a descendant pending ask", () => {
    const store = createSubAgentSessionStore();
    const parent = store.start({
      description: "parent",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    const child = store.start({
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: parent.id,
    });
    store.markRunning(parent.id);
    store.markRunning(child.id);
    store.registerInterrupt(parent.id, () => {});
    store.registerFollowup(parent.id, async () => "next");
    let rejected: unknown;
    store.registerAsk(child.id, {
      question: "q",
      questionId: "ask-1",
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: (reason) => {
        rejected = reason;
      },
    });

    expect(store.sendInputOne(parent.id, "stop that", { interrupt: true })).toEqual({
      ok: true,
      status: "interrupted",
    });
    expect(store.hasPendingAsk(child.id)).toBe(false);
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toContain("cancelled by send_input interrupt");
  });

  test("sendInputOne interrupt with missing handles does not cancel the pending ask", () => {
    const store = createSubAgentSessionStore();
    const session = store.start({
      description: "d",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    store.markRunning(session.id);
    store.registerFollowup(session.id, async () => "next");
    let rejected: unknown;
    let resolved: string | undefined;
    store.registerAsk(session.id, {
      question: "which file?",
      questionId: "ask-1",
      resolve: (answer) => {
        resolved = answer;
      },
      reject: (reason) => {
        rejected = reason;
      },
    });

    expect(store.sendInputOne(session.id, "stop that", { interrupt: true })).toEqual({
      ok: false,
      status: "running",
    });
    expect(store.hasPendingAsk(session.id)).toBe(true);
    expect(rejected).toBeUndefined();
    expect(resolved).toBeUndefined();
    expect(store.resolveAsk(session.id, "src/foo.ts")).toBe(true);
    expect(resolved).toBe("src/foo.ts");
  });

  test("complete and close cancel a pending ask", async () => {
    const store = createSubAgentSessionStore();
    const completed = store.start({ description: "c", agentId: "a", brief: "b" });
    store.markRunning(completed.id);
    let completeRejected: unknown;
    store.registerAsk(completed.id, {
      question: "q",
      questionId: "ask-1",
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: (reason) => {
        completeRejected = reason;
      },
    });
    store.complete(completed.id, "done");
    expect(store.hasPendingAsk(completed.id)).toBe(false);
    expect(String(completeRejected)).toContain("session completed");

    const closed = store.start({ description: "x", agentId: "a", brief: "b", retained: true });
    store.markRunning(closed.id);
    store.registerClose(closed.id, async () => {});
    let closeRejected: unknown;
    store.registerAsk(closed.id, {
      question: "q",
      questionId: "ask-1",
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: (reason) => {
        closeRejected = reason;
      },
    });
    await store.closeOne(closed.id, 1000);
    expect(store.hasPendingAsk(closed.id)).toBe(false);
    expect(String(closeRejected)).toContain("session closed");
  });

  test("ancestor settle cancels a descendant ask", () => {
    const store = createSubAgentSessionStore();
    const parent = store.start({ description: "parent", agentId: "a", brief: "b" });
    const child = store.start({
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: parent.id,
    });
    store.markRunning(parent.id);
    store.markRunning(child.id);
    let rejected: unknown;
    store.registerAsk(child.id, {
      question: "q",
      questionId: "ask-1",
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: (reason) => {
        rejected = reason;
      },
    });
    store.complete(parent.id, "parent done");
    expect(store.hasPendingAsk(child.id)).toBe(false);
    expect(String(rejected)).toContain("session completed");
  });
});
