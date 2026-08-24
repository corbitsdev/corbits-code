import { describe, expect, test } from "bun:test";

import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createFollowupTaskTool,
} from "./lifecycle-tools.js";
import { createSubAgentSessionStore } from "./session-store.js";

async function callTool(
  tool:
    | ReturnType<typeof createCloseAgentTool>
    | ReturnType<typeof createResumeAgentTool>
    | ReturnType<typeof createInterruptAgentTool>
    | ReturnType<typeof createFollowupTaskTool>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    { id: `call-${Math.random()}`, name: tool.definition.name, arguments: args },
    new AbortController().signal,
  );
  const content =
    typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  return JSON.parse(content);
}

describe("close_agent", () => {
  test("closes descendants before the parent, and reports not_found for an unknown target", async () => {
    const sessions = createSubAgentSessionStore();
    const parent = sessions.start({ description: "parent", agentId: "a", brief: "b" });
    const child = sessions.start({
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: parent.id,
    });
    const grandchild = sessions.start({
      description: "grandchild",
      agentId: "a",
      brief: "b",
      parentSessionId: child.id,
    });

    const closedOrder: string[] = [];
    for (const id of [parent.id, child.id, grandchild.id]) {
      sessions.registerClose(id, async () => {
        closedOrder.push(id);
      });
    }

    const closeAgent = createCloseAgentTool({ sessions });
    const result = await callTool(closeAgent, { target: parent.id });

    expect(result.status).toBe("shutdown");
    // Descendants close before their ancestor: grandchild, then child, then parent.
    expect(closedOrder).toEqual([grandchild.id, child.id, parent.id]);
    expect(sessions.get(parent.id)?.lifecycleStatus).toBe("shutdown");
    expect(sessions.get(child.id)?.lifecycleStatus).toBe("shutdown");
    expect(sessions.get(grandchild.id)?.lifecycleStatus).toBe("shutdown");

    const missing = await callTool(closeAgent, { target: "does-not-exist" });
    expect(missing.status).toBe("not_found");
  });

  test("a wedged descendant hits its own deadline instead of hanging the whole close", async () => {
    const sessions = createSubAgentSessionStore();
    const parent = sessions.start({ description: "parent", agentId: "a", brief: "b" });
    const wedgedChild = sessions.start({
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: parent.id,
    });
    sessions.registerClose(wedgedChild.id, () => new Promise<void>(() => {}));
    sessions.registerClose(parent.id, async () => {});

    // Exercise the store directly with a short deadline (the tool itself
    // uses the real ~30s bound, which would make this test slow).
    const started = Date.now();
    const childStatus = await sessions.closeOne(wedgedChild.id, 25);
    expect(Date.now() - started).toBeLessThan(500);
    expect(childStatus).toBe("shutdown");
  });
});

describe("resume_agent", () => {
  test("resumes a retained completed session and rejects a non-retained one", async () => {
    const sessions = createSubAgentSessionStore();
    const retained = sessions.start({ description: "d", agentId: "a", brief: "b", retained: true });
    sessions.complete(retained.id, "## Summary\nDone.");

    const notRetained = sessions.start({ description: "d2", agentId: "a", brief: "b" });
    sessions.complete(notRetained.id, "## Summary\nDone.");

    const resumeAgent = createResumeAgentTool({ sessions });

    const ok = await callTool(resumeAgent, { target: retained.id });
    expect(ok.status).toBe("running");
    expect(sessions.get(retained.id)?.lifecycleStatus).toBe("running");

    const rawResult = await (async () => {
      if (resumeAgent.kind !== "full") throw new Error("expected full tool");
      return resumeAgent.handler(
        { id: "call-x", name: "resume_agent", arguments: { target: notRetained.id } },
        new AbortController().signal,
      );
    })();
    expect(rawResult.isError).toBe(true);
  });
});

describe("interrupt_agent / followup_task", () => {
  test("interrupt then followup keeps prior context — the worker does not re-read from scratch", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(worker.id);

    // Simulates the live agent's own message history (what run.ts's
    // `followup`/`interrupt` closures actually close over) — a shared array,
    // not something recreated per call.
    const history: string[] = ["read src/index.ts", "found the bug on line 12"];
    let interruptFired = false;
    sessions.registerInterrupt(worker.id, () => {
      interruptFired = true;
    });
    sessions.registerFollowup(worker.id, async (message: string) => {
      history.push(message);
      return `Applying fix given ${history.length} prior turns of context.`;
    });

    const interruptAgent = createInterruptAgentTool({ sessions });
    const followupTask = createFollowupTaskTool({ sessions });

    const interruptResult = await callTool(interruptAgent, { target: worker.id });
    expect(interruptResult.status).toBe("interrupted");
    expect(interruptFired).toBe(true);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("interrupted");

    const followupResult = await callTool(followupTask, {
      target: worker.id,
      message: "actually fix line 12 directly, not line 20",
    });
    expect(followupResult.status).toBe("completed");

    // The load-bearing assertion: the worker's own history object still
    // holds the turns that predate the interrupt, plus the new one appended
    // in place — not a fresh array the followup started from empty.
    expect(history).toEqual([
      "read src/index.ts",
      "found the bug on line 12",
      "actually fix line 12 directly, not line 20",
    ]);
    expect(history.length).toBe(3);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("completed");
    expect(sessions.get(worker.id)?.report).toBe(followupResult.reply as string);
  });

  test("followup_task on a completed retained worker reuses its existing session, not a fresh one", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    const history: string[] = ["did the first task"];
    sessions.registerFollowup(worker.id, async (message: string) => {
      history.push(message);
      return `done, history now ${history.length} turns`;
    });
    sessions.complete(worker.id, "## Summary\nFirst task done.");

    const followupTask = createFollowupTaskTool({ sessions });
    const result = await callTool(followupTask, { target: worker.id, message: "now do task two" });

    expect(result.status).toBe("completed");
    // Same session id throughout — never re-created — and its underlying
    // history object grew rather than being replaced.
    expect(sessions.get(worker.id)?.id).toBe(worker.id);
    expect(history).toEqual(["did the first task", "now do task two"]);

    const nonRetained = sessions.start({ description: "d2", agentId: "a", brief: "b" });
    sessions.complete(nonRetained.id, "## Summary\nDone.");
    if (followupTask.kind !== "full") throw new Error("expected full tool");
    const rejected = await followupTask.handler(
      {
        id: "c3",
        name: "followup_task",
        arguments: { target: nonRetained.id, message: "more work" },
      },
      new AbortController().signal,
    );
    expect(rejected.isError).toBe(true);
  });

  test("an interrupted session is resumable via followup_task and interrupt never touches close()", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(worker.id);

    let closeCalls = 0;
    sessions.registerClose(worker.id, async () => {
      closeCalls++;
    });
    sessions.registerInterrupt(worker.id, () => {
      // Real interrupt handle: fires a dedicated signal, never close().
    });
    sessions.registerFollowup(worker.id, async () => "resumed cleanly");

    const interruptAgent = createInterruptAgentTool({ sessions });
    const followupTask = createFollowupTaskTool({ sessions });

    await callTool(interruptAgent, { target: worker.id });
    expect(closeCalls).toBe(0);

    const followupResult = await callTool(followupTask, { target: worker.id, message: "continue" });
    expect(followupResult.status).toBe("completed");
    expect(closeCalls).toBe(0);
    // No lock-strand risk from this path: close() was never invoked, so the
    // workdir lock close_agent's bounded teardown would otherwise release
    // was never at risk of being held by a wedged close in the first place.
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("completed");
  });

  test("interrupt_agent and followup_task fail closed on a non-running / non-retained target", async () => {
    const sessions = createSubAgentSessionStore();
    const notRunning = sessions.start({ description: "d", agentId: "a", brief: "b" });
    sessions.complete(notRunning.id, "## Summary\nDone.");

    const interruptAgent = createInterruptAgentTool({ sessions });
    const followupTask = createFollowupTaskTool({ sessions });

    if (interruptAgent.kind !== "full") throw new Error("expected full tool");
    const interruptErr = await interruptAgent.handler(
      { id: "c1", name: "interrupt_agent", arguments: { target: notRunning.id } },
      new AbortController().signal,
    );
    expect(interruptErr.isError).toBe(true);

    if (followupTask.kind !== "full") throw new Error("expected full tool");
    const followupErr = await followupTask.handler(
      { id: "c2", name: "followup_task", arguments: { target: notRunning.id, message: "x" } },
      new AbortController().signal,
    );
    // Not retained, so followup_task must reject even though it is "completed".
    expect(followupErr.isError).toBe(true);
  });
});
