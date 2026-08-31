import { describe, expect, test } from "bun:test";

import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createSendInputTool,
} from "./lifecycle-tools.js";
import { createFleetRecords, createWaitAgentsTool } from "./agent-fleet.js";
import { createSubAgentSessionStore } from "./session-store.js";

async function callTool(
  tool:
    | ReturnType<typeof createCloseAgentTool>
    | ReturnType<typeof createResumeAgentTool>
    | ReturnType<typeof createInterruptAgentTool>
    | ReturnType<typeof createSendInputTool>
    | ReturnType<typeof createWaitAgentsTool>,
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

    const closeAgent = createCloseAgentTool({ sessions, fleetRecords: createFleetRecords() });
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
  test("starts the next turn on a completed retained session and returns immediately", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetRecords();
    const retained = sessions.start({ description: "d", agentId: "a", brief: "b", retained: true });
    const history: string[] = ["first task"];
    let finish: (reply: string) => void = () => {};
    sessions.registerFollowup(
      retained.id,
      (message: string) =>
        new Promise<string>((resolve) => {
          history.push(message);
          finish = resolve;
        }),
    );
    sessions.complete(retained.id, "## Summary\nDone.");

    const notRetained = sessions.start({ description: "d2", agentId: "a", brief: "b" });
    sessions.complete(notRetained.id, "## Summary\nDone.");

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });

    const started = Date.now();
    const ok = await callTool(resumeAgent, { target: retained.id, message: "now do task two" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ok.status).toBe("running");
    expect(sessions.get(retained.id)?.status).toBe("running");
    expect(sessions.get(retained.id)?.lifecycleStatus).toBe("running");
    expect(history).toEqual(["first task", "now do task two"]);

    sessions.registerDeliver(retained.id, () => {});
    sessions.registerInterrupt(retained.id, () => {});
    const sendInput = createSendInputTool({ sessions });
    const steered = await callTool(sendInput, { target: retained.id, message: "steer" });
    expect(steered).toEqual({ agent_id: retained.id, status: "running" });
    const interrupted = await callTool(createInterruptAgentTool({ sessions, fleetRecords }), {
      target: retained.id,
    });
    expect(interrupted.status).toBe("interrupted");

    finish("done, history now 2 turns");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.get(retained.id)?.lifecycleStatus).toBe("completed");
    expect(sessions.get(retained.id)?.id).toBe(retained.id);
    expect(sessions.get(retained.id)?.report).toBe("done, history now 2 turns");

    if (resumeAgent.kind !== "full") throw new Error("expected full tool");
    const rejected = await resumeAgent.handler(
      {
        id: "call-x",
        name: "resume_agent",
        arguments: { target: notRetained.id, message: "more" },
      },
      new AbortController().signal,
    );
    expect(rejected.isError).toBe(true);
  });

  test("resumes an interrupted retained session without calling close()", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetRecords();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(worker.id);

    const history: string[] = ["read src/index.ts", "found the bug on line 12"];
    let interruptFired = false;
    let closeCalls = 0;
    sessions.registerClose(worker.id, async () => {
      closeCalls++;
    });
    sessions.registerInterrupt(worker.id, () => {
      interruptFired = true;
    });
    sessions.registerFollowup(worker.id, async (message: string) => {
      history.push(message);
      return `Applying fix given ${history.length} prior turns of context.`;
    });

    const interruptAgent = createInterruptAgentTool({ sessions, fleetRecords });
    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });

    const interruptResult = await callTool(interruptAgent, { target: worker.id });
    expect(interruptResult.status).toBe("interrupted");
    expect(interruptFired).toBe(true);
    expect(closeCalls).toBe(0);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("interrupted");

    const started = Date.now();
    const resumeResult = await callTool(resumeAgent, {
      target: worker.id,
      message: "actually fix line 12 directly, not line 20",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(resumeResult.status).toBe("running");
    expect(closeCalls).toBe(0);
    expect(history).toEqual([
      "read src/index.ts",
      "found the bug on line 12",
      "actually fix line 12 directly, not line 20",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("completed");
    expect(sessions.get(worker.id)?.report).toContain("Applying fix given 3 prior turns");
  });

  test("rejects a closed session and a concurrent resume of a running turn", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetRecords();
    const closed = sessions.start({
      description: "closed",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.registerClose(closed.id, async () => {});
    sessions.registerFollowup(closed.id, async () => "should not run");
    sessions.complete(closed.id, "## Summary\nDone.");
    const closeAgent = createCloseAgentTool({ sessions, fleetRecords });
    await callTool(closeAgent, { target: closed.id });

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    if (resumeAgent.kind !== "full") throw new Error("expected full tool");
    const closedErr = await resumeAgent.handler(
      { id: "c-closed", name: "resume_agent", arguments: { target: closed.id, message: "more" } },
      new AbortController().signal,
    );
    expect(closedErr.isError).toBe(true);
    expect(String(closedErr.content)).toContain("shutdown");

    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    let finish: (reply: string) => void = () => {};
    sessions.registerFollowup(
      worker.id,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    sessions.complete(worker.id, "## Summary\nDone.");

    const first = await callTool(resumeAgent, { target: worker.id, message: "turn two" });
    expect(first.status).toBe("running");
    const concurrent = await resumeAgent.handler(
      {
        id: "c-concurrent",
        name: "resume_agent",
        arguments: { target: worker.id, message: "again" },
      },
      new AbortController().signal,
    );
    expect(concurrent.isError).toBe(true);
    expect(String(concurrent.content)).toContain("running");
    finish("done");
  });

  test("wait_agents collects the resumed turn after resume_agent returns", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetRecords();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    let finish: (reply: string) => void = () => {};
    sessions.registerFollowup(
      worker.id,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    sessions.complete(worker.id, "first report");
    fleetRecords.register(worker.id);
    fleetRecords.resolve(worker.id, "first report");

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const wait = createWaitAgentsTool({ sessions, fleetRecords });

    const firstWait = await callTool(wait, { targets: [worker.id], timeout_ms: 1000 });
    expect(firstWait.timed_out).toBe(false);
    const firstResults = firstWait.results as { status: string; report?: string }[];
    expect(firstResults[0]!.status).toBe("done");
    expect(firstResults[0]!.report).toBe("first report");

    const started = Date.now();
    const resumed = await callTool(resumeAgent, { target: worker.id, message: "second turn" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(resumed.status).toBe("running");

    const waiting = callTool(wait, { targets: [worker.id], timeout_ms: 2000 });
    finish("second report");
    const collected = await waiting;
    expect(collected.timed_out).toBe(false);
    const results = collected.results as { status: string; report?: string }[];
    expect(results[0]!.status).toBe("done");
    expect(results[0]!.report).toBe("second report");
  });
});

describe("interrupt_agent", () => {
  test("interrupt_agent fails closed on a non-running target", async () => {
    const sessions = createSubAgentSessionStore();
    const notRunning = sessions.start({ description: "d", agentId: "a", brief: "b" });
    sessions.complete(notRunning.id, "## Summary\nDone.");

    const interruptAgent = createInterruptAgentTool({
      sessions,
      fleetRecords: createFleetRecords(),
    });

    if (interruptAgent.kind !== "full") throw new Error("expected full tool");
    const interruptErr = await interruptAgent.handler(
      { id: "c1", name: "interrupt_agent", arguments: { target: notRunning.id } },
      new AbortController().signal,
    );
    expect(interruptErr.isError).toBe(true);
  });
});

describe("send_input", () => {
  test("soft-delivers without flipping lifecycle or awaiting a reply", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(worker.id);
    const delivered: string[] = [];
    sessions.registerDeliver(worker.id, (message) => {
      delivered.push(message);
    });

    const sendInput = createSendInputTool({ sessions });
    const result = await callTool(sendInput, {
      target: worker.id,
      message: "stop and inspect line 4",
    });

    expect(result).toEqual({ agent_id: worker.id, status: "running" });
    expect(delivered).toEqual(["stop and inspect line 4"]);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("running");
  });

  test("interrupt:true queues followup without awaiting and refuses when followup is missing", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = sessions.start({
      description: "worker",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(worker.id);
    let interrupted = false;
    let followupStarted = false;
    sessions.registerInterrupt(worker.id, () => {
      interrupted = true;
    });
    sessions.registerFollowup(worker.id, async (message) => {
      followupStarted = true;
      expect(message).toBe("patch only the test");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "queued turn finished";
    });
    sessions.registerDeliver(worker.id, () => {
      throw new Error("interrupt:true should not soft-deliver");
    });

    const sendInput = createSendInputTool({ sessions });
    const result = await callTool(sendInput, {
      target: worker.id,
      message: "patch only the test",
      interrupt: true,
    });
    expect(result).toEqual({ agent_id: worker.id, status: "interrupted" });
    expect(interrupted).toBe(true);
    expect(followupStarted).toBe(true);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("running");
    expect(sessions.get(worker.id)?.finishedAt).toBeUndefined();

    const missing = sessions.start({
      description: "no-followup",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(missing.id);
    sessions.registerInterrupt(missing.id, () => {});
    if (sendInput.kind !== "full") throw new Error("expected full tool");
    const denied = await sendInput.handler(
      {
        id: "missing-followup",
        name: "send_input",
        arguments: { target: missing.id, message: "steer", interrupt: true },
      },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
    expect(sessions.get(missing.id)?.lifecycleStatus).toBe("running");
  });

  test("rejects completed, interrupted, and closed sessions — steering is in-flight only", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetRecords();
    const sendInput = createSendInputTool({ sessions, fleetRecords });
    if (sendInput.kind !== "full") throw new Error("expected full tool");

    const completed = sessions.start({
      description: "done",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(completed.id);
    sessions.registerDeliver(completed.id, () => {
      throw new Error("must not deliver to a completed session");
    });
    sessions.complete(completed.id, "## Summary\nDone.");
    const completedErr = await sendInput.handler(
      { id: "to-completed", name: "send_input", arguments: { target: completed.id, message: "x" } },
      new AbortController().signal,
    );
    expect(completedErr.isError).toBe(true);

    const interrupted = sessions.start({
      description: "paused",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(interrupted.id);
    sessions.registerInterrupt(interrupted.id, () => {});
    sessions.registerDeliver(interrupted.id, () => {
      throw new Error("must not deliver to an interrupted session");
    });
    await callTool(createInterruptAgentTool({ sessions, fleetRecords }), {
      target: interrupted.id,
    });
    const interruptedErr = await sendInput.handler(
      {
        id: "to-interrupted",
        name: "send_input",
        arguments: { target: interrupted.id, message: "x" },
      },
      new AbortController().signal,
    );
    expect(interruptedErr.isError).toBe(true);

    const closed = sessions.start({
      description: "closed",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(closed.id);
    sessions.registerClose(closed.id, async () => {});
    sessions.registerDeliver(closed.id, () => {
      throw new Error("must not deliver to a closed session");
    });
    await callTool(createCloseAgentTool({ sessions, fleetRecords }), { target: closed.id });
    const closedErr = await sendInput.handler(
      { id: "to-closed", name: "send_input", arguments: { target: closed.id, message: "x" } },
      new AbortController().signal,
    );
    expect(closedErr.isError).toBe(true);
    expect(sessions.get(closed.id)?.lifecycleStatus).toBe("shutdown");
  });

  test("enforces nested orchestrator descendant authority", async () => {
    const sessions = createSubAgentSessionStore();
    const nested = sessions.start({
      id: "nested",
      description: "nested",
      agentId: "a",
      brief: "b",
    });
    const child = sessions.start({
      id: "child",
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: nested.id,
    });
    const sibling = sessions.start({
      id: "sibling",
      description: "sibling",
      agentId: "a",
      brief: "b",
    });
    for (const session of [nested, child, sibling]) {
      sessions.markRunning(session.id);
      sessions.registerDeliver(session.id, () => {});
    }
    const sendInput = createSendInputTool({
      sessions,
      authority: {
        actorId: nested.id,
        tier: "nested-orchestrator",
        getNodes: () => sessions.list(),
      },
    });

    const ok = await callTool(sendInput, { target: child.id, message: "continue" });
    expect(ok.status).toBe("running");

    if (sendInput.kind !== "full") throw new Error("expected full tool");
    const denied = await sendInput.handler(
      { id: "denied", name: "send_input", arguments: { target: sibling.id, message: "continue" } },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
  });

  test("fails closed when nested authority has no actorId", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = sessions.start({
      id: "worker",
      description: "worker",
      agentId: "a",
      brief: "b",
    });
    sessions.markRunning(worker.id);
    sessions.registerDeliver(worker.id, () => {});
    const sendInput = createSendInputTool({
      sessions,
      authority: {
        actorId: undefined,
        tier: "nested-orchestrator",
        getNodes: () => sessions.list(),
      },
    });
    if (sendInput.kind !== "full") throw new Error("expected full tool");
    const denied = await sendInput.handler(
      { id: "no-actor", name: "send_input", arguments: { target: worker.id, message: "x" } },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain("no resolvable session");
  });
});

describe("nested lifecycle authority", () => {
  function nestAuthority(sessions: ReturnType<typeof createSubAgentSessionStore>, actorId: string) {
    return {
      actorId,
      tier: "nested-orchestrator" as const,
      getNodes: () => sessions.list(),
    };
  }

  test("interrupt_agent denies a sibling and allows a descendant", async () => {
    const sessions = createSubAgentSessionStore();
    const nested = sessions.start({ id: "nested", description: "n", agentId: "a", brief: "b" });
    const child = sessions.start({
      id: "child",
      description: "c",
      agentId: "a",
      brief: "b",
      parentSessionId: nested.id,
    });
    const sibling = sessions.start({ id: "sibling", description: "s", agentId: "a", brief: "b" });
    for (const s of [child, sibling]) {
      sessions.markRunning(s.id);
      sessions.registerInterrupt(s.id, () => {});
    }
    const interrupt = createInterruptAgentTool({
      sessions,
      fleetRecords: createFleetRecords(),
      authority: nestAuthority(sessions, nested.id),
    });
    expect((await callTool(interrupt, { target: child.id })).status).toBe("interrupted");
    if (interrupt.kind !== "full") throw new Error("expected full tool");
    const denied = await interrupt.handler(
      { id: "d", name: "interrupt_agent", arguments: { target: sibling.id } },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
  });

  test("close_agent denies a sibling and allows a descendant", async () => {
    const sessions = createSubAgentSessionStore();
    const nested = sessions.start({ id: "nested", description: "n", agentId: "a", brief: "b" });
    const child = sessions.start({
      id: "child",
      description: "c",
      agentId: "a",
      brief: "b",
      parentSessionId: nested.id,
    });
    const sibling = sessions.start({ id: "sibling", description: "s", agentId: "a", brief: "b" });
    for (const s of [child, sibling]) sessions.registerClose(s.id, async () => {});
    const close = createCloseAgentTool({
      sessions,
      fleetRecords: createFleetRecords(),
      authority: nestAuthority(sessions, nested.id),
    });
    expect((await callTool(close, { target: child.id })).status).toBe("shutdown");
    if (close.kind !== "full") throw new Error("expected full tool");
    const denied = await close.handler(
      { id: "d", name: "close_agent", arguments: { target: sibling.id } },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
    expect(sessions.get(sibling.id)?.lifecycleStatus).not.toBe("shutdown");
  });

  test("resume_agent denies a sibling and allows a descendant", async () => {
    const sessions = createSubAgentSessionStore();
    const nested = sessions.start({ id: "nested", description: "n", agentId: "a", brief: "b" });
    const child = sessions.start({
      id: "child",
      description: "c",
      agentId: "a",
      brief: "b",
      parentSessionId: nested.id,
      retained: true,
    });
    const sibling = sessions.start({
      id: "sibling",
      description: "s",
      agentId: "a",
      brief: "b",
      retained: true,
    });
    for (const s of [child, sibling]) {
      sessions.complete(s.id, "done");
      sessions.registerFollowup(s.id, async () => "reply");
    }
    const resume = createResumeAgentTool({
      sessions,
      fleetRecords: createFleetRecords(),
      authority: nestAuthority(sessions, nested.id),
    });
    expect((await callTool(resume, { target: child.id, message: "more" })).status).toBe("running");
    if (resume.kind !== "full") throw new Error("expected full tool");
    const denied = await resume.handler(
      { id: "d", name: "resume_agent", arguments: { target: sibling.id, message: "more" } },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
  });
});
