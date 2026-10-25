import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createSendInputTool,
  createApproveWorkerCallTool,
  resumeAgentToolDefinition,
} from "./lifecycle-tools.js";
import {
  createFleetMailbox,
  createListAgentsTool,
  createWaitAgentsTool,
} from "./agent-fleet.js";
import {
  createSubAgentSessionStore,
  DEFAULT_MAX_ENTRY_CHARS,
  type SubAgentSession,
} from "./session-store.js";
import { createAdmissionQueue } from "./admission.js";
import { runWithSubAgentIdentity } from "./identity-context.js";
import { createPermissionGate } from "../permission/gate.js";
import {
  createWorkerAuthorize,
  workerPermissionGate,
} from "../permission/reactor-authorize.js";
import {
  createDeniedCallEnvelope,
  getProcessWorkerGrantStore,
} from "../permission/worker-grant.js";
import { defined } from "../../testkit/defined.js";
import { callFleetTool, callFleetToolRaw } from "./fleet-test-harness.js";

const callTool = callFleetTool;

type SessionStore = ReturnType<typeof createSubAgentSessionStore>;

function parentGate(cwd: string, allow: boolean) {
  return createPermissionGate({
    approvals: [],
    cwd,
    interactive: true,
    skipPermissions: false,
    reactorGated: false,
    requestApproval: async (request) => {
      if (!allow) return { allow: false };
      const exact = request.scopes[0];
      return exact === undefined
        ? { allow: true }
        : { allow: true, persist: { ...exact, grant: "session" as const } };
    },
  });
}

function pendingDeniedAsk(
  sessions: SessionStore,
  options: {
    id: string;
    cwd: string;
    command: string;
    expiresAt?: number;
    parentSessionId?: string;
  },
) {
  const session = startSession(sessions, {
    id: options.id,
    description: "worker",
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
  });
  sessions.markRunning(session.id);
  const envelope = getProcessWorkerGrantStore().register(
    createDeniedCallEnvelope({
      callId: `${session.id}-denied`,
      tool: "run_shell",
      action: "Run",
      subject: options.command,
      args: { command: options.command },
      cwd: options.cwd,
      workerSessionId: session.id,
    }),
  );
  if (options.expiresAt !== undefined) envelope.expiresAt = options.expiresAt;
  const received: string[] = [];
  expect(
    sessions.registerAsk(session.id, {
      question: "approve exact denied call",
      questionId: `${session.id}-question`,
      grantRequestId: envelope.requestId,
      assessment: assessedAsk,
      resolve: (answer) => received.push(answer),
      reject: () => undefined,
    }),
  ).toBe(true);
  return { session, envelope, received };
}

/** Valid assessed ask payload for the structured-resolution tests. */
const assessedAsk = {
  policyVersion: "1",
  classification: "operator_decision_required",
  blockedOutcome: "cannot produce the authenticated verification result",
  unavailableDirectorPath: "the director has no credential authority",
  permittedAlternatives: [
    {
      attempted: "focused local test",
      result: "requires the missing credential",
      comparableConfidence: false,
    },
  ],
  minimumAddition: "allow an authenticated read-only snapshot",
  declineConsequence: "implementation is complete but verification is blocked",
  requestedMechanism: "broad web access",
  minimumAuthority: "authenticated read-only snapshot",
  verification: {
    verificationOutcome: "integration verification",
    rootCause: "missing test credential",
    attemptedNarrowChecks: ["focused local test"],
    reducedConfidence: "integration behavior remains unverified",
  },
} as const;

// Every session in this suite uses the same agentId/brief scaffold; callers
// pass only the fields that actually vary for the behavior under test.
function startSession(
  sessions: SessionStore,
  overrides: Partial<Parameters<SessionStore["start"]>[0]> & {
    description: string;
  },
): SubAgentSession {
  return sessions.start({ agentId: "a", brief: "b", ...overrides });
}

function retainedPendingFollowup(
  sessions: ReturnType<typeof createSubAgentSessionStore>,
): {
  worker: SubAgentSession;
  finish: (reply: string) => void;
} {
  const worker = startSession(sessions, {
    description: "worker",
    retained: true,
  });
  let finish: (reply: string) => void = () => undefined;
  sessions.registerFollowup(
    worker.id,
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  // Followup resolution is wired at resume time, so hand back a forwarder.
  return { worker, finish: (reply: string) => finish(reply) };
}

describe("close_agent", () => {
  test("closes descendants before the parent, and reports not_found for an unknown target", async () => {
    const sessions = createSubAgentSessionStore();
    const parent = startSession(sessions, { description: "parent" });
    const child = startSession(sessions, {
      description: "child",
      parentSessionId: parent.id,
    });
    const grandchild = startSession(sessions, {
      description: "grandchild",
      parentSessionId: child.id,
    });

    const closedOrder: string[] = [];
    for (const id of [parent.id, child.id, grandchild.id]) {
      sessions.registerClose(id, async () => {
        closedOrder.push(id);
      });
    }

    const closeAgent = createCloseAgentTool({
      sessions,
      fleetRecords: createFleetMailbox(sessions),
    });
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

  test("closes remaining siblings after a leftover-child throw, then fails", async () => {
    const sessions = createSubAgentSessionStore();
    const parent = startSession(sessions, { description: "parent" });
    const leftover = startSession(sessions, {
      description: "leftover",
      parentSessionId: parent.id,
    });
    const sibling = startSession(sessions, {
      description: "sibling",
      parentSessionId: parent.id,
    });
    const closedOrder: string[] = [];
    sessions.registerClose(leftover.id, async () => {
      closedOrder.push(leftover.id);
      throw new Error("1 shell child process still live after 2000ms reap");
    });
    sessions.registerClose(sibling.id, async () => {
      closedOrder.push(sibling.id);
    });
    sessions.registerClose(parent.id, async () => {
      closedOrder.push(parent.id);
    });

    const closeAgent = createCloseAgentTool({
      sessions,
      fleetRecords: createFleetMailbox(sessions),
    });
    await expect(callTool(closeAgent, { target: parent.id })).rejects.toThrow(
      /still live after 2000ms reap/,
    );
    expect(closedOrder).toContain(leftover.id);
    expect(closedOrder).toContain(sibling.id);
    expect(closedOrder).toContain(parent.id);
  });
});

describe("resume_agent", () => {
  test("starts the next turn on a completed retained session and returns immediately", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const retained = startSession(sessions, {
      description: "d",
      retained: true,
    });
    const history: string[] = ["first task"];
    let finish: (reply: string) => void = () => undefined;
    sessions.registerFollowup(
      retained.id,
      (message: string) =>
        new Promise<string>((resolve) => {
          history.push(message);
          finish = resolve;
        }),
    );
    sessions.complete(retained.id, "## Summary\nDone.");

    const notRetained = startSession(sessions, { description: "d2" });
    sessions.complete(notRetained.id, "## Summary\nDone.");

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });

    const started = Date.now();
    const ok = await callTool(resumeAgent, {
      target: retained.id,
      message: "now do task two",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ok.status).toBe("running");
    expect(sessions.get(retained.id)?.status).toBe("running");
    expect(sessions.get(retained.id)?.lifecycleStatus).toBe("running");
    expect(history).toEqual(["first task", "now do task two"]);

    sessions.registerDeliver(retained.id, () => undefined);
    sessions.registerInterrupt(retained.id, () => undefined);
    const sendInput = createSendInputTool({ sessions });
    const steered = await callTool(sendInput, {
      target: retained.id,
      message: "steer",
    });
    expect(steered).toEqual({ agent_id: retained.id, status: "running" });
    const interrupted = await callTool(
      createInterruptAgentTool({ sessions, fleetRecords }),
      {
        target: retained.id,
      },
    );
    expect(interrupted.status).toBe("interrupted");

    finish("done, history now 2 turns");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.get(retained.id)?.lifecycleStatus).toBe("interrupted");
    expect(sessions.get(retained.id)?.id).toBe(retained.id);
    expect(sessions.get(retained.id)?.report).toBe("## Summary\nDone.");

    const rejected = await callFleetToolRaw(resumeAgent, {
      target: notRetained.id,
      message: "more",
    });
    expect(rejected.isError).toBe(true);
  });

  test("resumes an interrupted retained session without calling close()", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
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

    const interruptResult = await callTool(interruptAgent, {
      target: worker.id,
    });
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
    expect(sessions.get(worker.id)?.report).toContain(
      "Applying fix given 3 prior turns",
    );
  });

  test("rejects a closed session and a concurrent resume of a running turn", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const closed = startSession(sessions, {
      description: "closed",
      retained: true,
    });
    sessions.registerClose(closed.id, async () => undefined);
    sessions.registerFollowup(closed.id, async () => "should not run");
    sessions.complete(closed.id, "## Summary\nDone.");
    const closeAgent = createCloseAgentTool({ sessions, fleetRecords });
    await callTool(closeAgent, { target: closed.id });

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const closedErr = await callFleetToolRaw(resumeAgent, {
      target: closed.id,
      message: "more",
    });
    expect(closedErr.isError).toBe(true);
    expect(String(closedErr.content)).toContain("shutdown");

    const { worker, finish } = retainedPendingFollowup(sessions);
    sessions.complete(worker.id, "## Summary\nDone.");

    const first = await callTool(resumeAgent, {
      target: worker.id,
      message: "turn two",
    });
    expect(first.status).toBe("running");
    const concurrent = await callFleetToolRaw(resumeAgent, {
      target: worker.id,
      message: "again",
    });
    expect(concurrent.isError).toBe(true);
    expect(String(concurrent.content)).toContain("running");
    finish("done");
  });

  test("rejects resume before an uncollected prior terminal fleet result is delivered", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    sessions.registerFollowup(worker.id, async () => "second report");
    sessions.complete(worker.id, "first report");
    fleetRecords.register(worker.id);

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const result = await callFleetToolRaw(resumeAgent, {
      target: worker.id,
      message: "next",
    });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("prior result is collected");
    const wait = createWaitAgentsTool({ sessions, fleetRecords });
    const collected = await callTool(wait, {
      targets: [worker.id],
      timeout_ms: 1000,
    });
    const results = collected.results as {
      agent_id: string;
      status: string;
      report?: string;
    }[];
    expect(results[0]).toEqual({
      agent_id: worker.id,
      status: "done",
      report: "first report",
    });
  });

  test("does not demand wait_agents for a worker with a pending ask", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    sessions.markRunning(worker.id);
    sessions.registerFollowup(worker.id, async () => "second report");
    fleetRecords.register(worker.id);
    expect(
      sessions.registerAsk(worker.id, {
        question: "which file?",
        questionId: "ask-1",
        assessment: assessedAsk,
        resolve: () => undefined,
        reject: () => undefined,
      }),
    ).toBe(true);

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const result = await callFleetToolRaw(resumeAgent, {
      target: worker.id,
      message: "next",
    });

    expect(String(result.content)).not.toContain("prior result is collected");
    expect(String(result.content)).not.toContain("wait_agents");
  });

  test("wait_agents collects the resumed turn after resume_agent returns", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const { worker, finish } = retainedPendingFollowup(sessions);
    sessions.complete(worker.id, "first report");
    fleetRecords.register(worker.id);

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const wait = createWaitAgentsTool({ sessions, fleetRecords });

    const firstWait = await callTool(wait, {
      targets: [worker.id],
      timeout_ms: 1000,
    });
    expect(firstWait.timed_out).toBe(false);
    const firstResults = firstWait.results as {
      status: string;
      report?: string;
    }[];
    expect(defined(firstResults[0]).status).toBe("done");
    expect(defined(firstResults[0]).report).toBe("first report");

    const started = Date.now();
    const resumed = await callTool(resumeAgent, {
      target: worker.id,
      message: "second turn",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(resumed.status).toBe("running");

    const waiting = callTool(wait, { targets: [worker.id], timeout_ms: 2000 });
    finish("second report");
    const collected = await waiting;
    expect(collected.timed_out).toBe(false);
    const results = collected.results as { status: string; report?: string }[];
    expect(defined(results[0]).status).toBe("done");
    expect(defined(results[0]).report).toBe("second report");
  });

  test("interrupt then successful resume wait is done without leftover interrupted stop_reason", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    sessions.markRunning(worker.id);
    sessions.registerInterrupt(worker.id, () => undefined);
    let finish: (reply: string) => void = () => undefined;
    sessions.registerFollowup(
      worker.id,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    fleetRecords.register(worker.id);

    const interruptAgent = createInterruptAgentTool({ sessions, fleetRecords });
    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const wait = createWaitAgentsTool({ sessions, fleetRecords });

    const interruptWaiting = callTool(wait, {
      targets: [worker.id],
      timeout_ms: 2000,
    });
    await callTool(interruptAgent, { target: worker.id });
    const interruptedWait = await interruptWaiting;
    expect(interruptedWait.timed_out).toBe(false);
    const interruptedResults = interruptedWait.results as {
      status: string;
      stop_reason?: string;
    }[];
    expect(defined(interruptedResults[0]).status).toBe("interrupted");
    expect(defined(interruptedResults[0]).stop_reason).toBe("interrupted");

    const resumed = await callTool(resumeAgent, {
      target: worker.id,
      message: "continue",
    });
    expect(resumed.status).toBe("running");

    const waiting = callTool(wait, { targets: [worker.id], timeout_ms: 2000 });
    finish("resumed report");
    const collected = await waiting;
    expect(collected.timed_out).toBe(false);
    const results = collected.results as {
      status: string;
      report?: string;
      stop_reason?: string;
    }[];
    expect(defined(results[0]).status).toBe("done");
    expect(defined(results[0]).report).toBe("resumed report");
    expect(defined(results[0]).stop_reason).toBeUndefined();
  });

  test("resume followup rejection invokes close; close_agent tears down leftover", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    let closeCalls = 0;
    sessions.registerClose(worker.id, async () => {
      closeCalls++;
    });
    sessions.registerFollowup(worker.id, async () => {
      throw new Error("send failed");
    });
    sessions.complete(worker.id, "first report");

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const closeAgent = createCloseAgentTool({ sessions, fleetRecords });
    const resumed = await callTool(resumeAgent, {
      target: worker.id,
      message: "again",
    });
    expect(resumed.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
    expect(sessions.get(worker.id)?.lifecycle.state).toBe("failed");

    const started = Date.now();
    const closed = await callTool(closeAgent, { target: worker.id });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(closed.status).toBe("shutdown");
    expect(sessions.get(worker.id)?.lifecycle.state).toBe("failed");
    expect(closeCalls).toBe(1);
  });

  test("wait_agents collects a failed resumed turn instead of hanging", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    sessions.registerFollowup(worker.id, async () => {
      throw new Error("resumed turn failed");
    });
    sessions.complete(worker.id, "first report");

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const wait = createWaitAgentsTool({ sessions, fleetRecords });

    const resumed = await callTool(resumeAgent, {
      target: worker.id,
      message: "second turn",
    });
    expect(resumed.status).toBe("running");
    const collected = await callTool(wait, {
      targets: [worker.id],
      timeout_ms: 1000,
    });

    expect(collected.timed_out).toBe(false);
    const results = collected.results as {
      agent_id: string;
      status: string;
      error?: string;
      failure?: unknown;
    }[];
    expect(results[0]).toEqual({
      agent_id: worker.id,
      status: "failed",
      error: "resumed turn failed",
      failure: expect.objectContaining({
        failure_class: "error",
        recovery: { available: false, reason: "not_retryable" },
      }),
    });
  });

  test("rejects missing, empty, and oversize messages without starting a turn", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    let starts = 0;
    sessions.registerFollowup(worker.id, async () => {
      starts++;
      return "should not run";
    });
    sessions.complete(worker.id, "first report");

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });

    const missing = await callFleetToolRaw(resumeAgent, {
      target: worker.id,
    });
    expect(missing.isError).toBe(true);
    expect(String(missing.content)).toContain("message");

    const empty = await callFleetToolRaw(resumeAgent, {
      target: worker.id,
      message: "   ",
    });
    expect(empty.isError).toBe(true);
    expect(String(empty.content).startsWith("Error:")).toBe(true);
    expect(String(empty.content)).toContain("non-empty message");

    const oversize = await callFleetToolRaw(resumeAgent, {
      target: worker.id,
      message: "x".repeat(DEFAULT_MAX_ENTRY_CHARS + 1),
    });
    expect(oversize.isError).toBe(true);
    expect(String(oversize.content)).toContain(
      `exceeds ${DEFAULT_MAX_ENTRY_CHARS} characters`,
    );
    expect(starts).toBe(0);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("completed");
  });

  test("schema requires message and exposes no followup_task alias", () => {
    expect(resumeAgentToolDefinition.name).toBe("resume_agent");
    expect(resumeAgentToolDefinition.inputSchema.required).toEqual([
      "target",
      "message",
    ]);
    expect(JSON.stringify(resumeAgentToolDefinition)).not.toContain(
      "followup_task",
    );
  });

  test("resume_agent returns queued when admission is full", async () => {
    const admission = createAdmissionQueue({ capacity: 0 });
    const sessions = createSubAgentSessionStore({ admission });
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
      provider: "p",
    });
    let started = false;
    sessions.registerFollowup(worker.id, async () => {
      started = true;
      return "second report";
    });
    sessions.complete(worker.id, "first report");
    fleetRecords.register(worker.id);
    const wait = createWaitAgentsTool({ sessions, fleetRecords });
    await callTool(wait, { targets: [worker.id], timeout_ms: 1000 });

    const resumeAgent = createResumeAgentTool({ sessions, fleetRecords });
    const resumed = await callTool(resumeAgent, {
      target: worker.id,
      message: "second turn",
    });
    expect(resumed.status).toBe("queued");
    expect(started).toBe(false);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("pending_init");
    expect(fleetRecords.peek(worker.id)?.status).toBe("queued");
  });
});

describe("interrupt_agent", () => {
  test("interrupt_agent fails closed on a non-running target", async () => {
    const sessions = createSubAgentSessionStore();
    const notRunning = startSession(sessions, { description: "d" });
    sessions.complete(notRunning.id, "## Summary\nDone.");

    const interruptAgent = createInterruptAgentTool({
      sessions,
      fleetRecords: createFleetMailbox(sessions),
    });

    const interruptErr = await callFleetToolRaw(interruptAgent, {
      target: notRunning.id,
    });
    expect(interruptErr.isError).toBe(true);
  });
});

describe("send_input", () => {
  function liveLane(
    opts: {
      inFlight?: boolean;
      interrupt?: () => void;
      followup?: (message: string) => Promise<string>;
      deliver?: (message: string) => void;
    } = {},
  ) {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = startSession(sessions, {
      description: "worker",
      retained: true,
    });
    sessions.markRunning(worker.id);
    if (opts.inFlight === true) sessions.markRunInFlight(worker.id);
    if (opts.interrupt !== undefined)
      sessions.registerInterrupt(worker.id, opts.interrupt);
    if (opts.followup !== undefined)
      sessions.registerFollowup(worker.id, opts.followup);
    if (opts.deliver !== undefined)
      sessions.registerDeliver(worker.id, opts.deliver);
    fleetRecords.register(worker.id);
    return { sessions, fleetRecords, worker };
  }

  async function interruptSteerThenCollect(
    lane: ReturnType<typeof liveLane>,
  ): Promise<
    { status: string; stop_reason?: string; error?: string; report?: string }[]
  > {
    const sendInput = createSendInputTool({
      sessions: lane.sessions,
      fleetRecords: lane.fleetRecords,
    });
    const wait = createWaitAgentsTool({
      sessions: lane.sessions,
      fleetRecords: lane.fleetRecords,
    });
    await callTool(sendInput, {
      target: lane.worker.id,
      message: "stop that",
      interrupt: true,
    });
    lane.sessions.attachReport(lane.worker.id, "salvage", {
      stopReason: "interrupted",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const collected = await callTool(wait, {
      targets: [lane.worker.id],
      timeout_ms: 1000,
    });
    expect(collected.timed_out).toBe(false);
    return collected.results as {
      status: string;
      stop_reason?: string;
      error?: string;
      report?: string;
    }[];
  }

  test("send_input interrupt then successful follow-up wait is done without leftover interrupted stop_reason", async () => {
    let finish: (reply: string) => void = () => undefined;
    const { sessions, fleetRecords, worker } = liveLane({
      interrupt: () => undefined,
      followup: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });

    const sendInput = createSendInputTool({ sessions, fleetRecords });
    const wait = createWaitAgentsTool({ sessions, fleetRecords });

    await callTool(sendInput, {
      target: worker.id,
      message: "stop that",
      interrupt: true,
    });
    const inflight = fleetRecords.peek(worker.id);
    expect(inflight?.status).toBe("running");
    expect(sessions.get(worker.id)?.stopReason).toBe("interrupted");
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("running");

    // The interrupt stashes the follow-up until the original run
    // settles; the salvage handoff launches it.
    sessions.attachReport(worker.id, "salvage", { stopReason: "interrupted" });
    finish("followup report");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const collected = await callTool(wait, {
      targets: [worker.id],
      timeout_ms: 1000,
    });
    expect(collected.timed_out).toBe(false);
    const results = collected.results as {
      status: string;
      report?: string;
      stop_reason?: string;
    }[];
    expect(defined(results[0]).status).toBe("done");
    expect(defined(results[0]).report).toBe("followup report");
    expect(defined(results[0]).stop_reason).toBeUndefined();
  });

  test("followup throw after interrupt wait still has stop_reason interrupted", async () => {
    const { sessions, fleetRecords, worker } = liveLane({
      interrupt: () => undefined,
      followup: async () => {
        throw new Error("send failed");
      },
    });

    // The interrupt stashes the follow-up until the original run
    // settles; the salvage handoff launches it, it rejects, and the session
    // restamps interrupted.
    const results = await interruptSteerThenCollect({
      sessions,
      fleetRecords,
      worker,
    });
    expect(defined(results[0]).status).toBe("interrupted");
    expect(defined(results[0]).stop_reason).toBe("interrupted");
  });

  test("soft-delivers without flipping lifecycle or awaiting a reply", async () => {
    const delivered: string[] = [];
    const { sessions, worker } = liveLane({
      deliver: (message) => {
        delivered.push(message);
      },
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
    let interrupted = false;
    let followupStarted = false;
    const { sessions, worker } = liveLane({
      interrupt: () => {
        interrupted = true;
      },
      followup: async (message) => {
        followupStarted = true;
        expect(message).toBe("patch only the test");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "queued turn finished";
      },
      deliver: () => {
        throw new Error("interrupt:true should not soft-deliver");
      },
    });

    const sendInput = createSendInputTool({ sessions });
    const result = await callTool(sendInput, {
      target: worker.id,
      message: "patch only the test",
      interrupt: true,
    });
    expect(result).toEqual({ agent_id: worker.id, status: "interrupted" });
    expect(interrupted).toBe(true);
    // The interrupt stashes the follow-up until the original run
    // settles; the salvage handoff launches it.
    expect(followupStarted).toBe(false);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("running");
    sessions.attachReport(worker.id, "salvage", { stopReason: "interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(followupStarted).toBe(true);
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("running");
    expect(sessions.get(worker.id)?.finishedAt).toBeUndefined();

    const missing = startSession(sessions, {
      description: "no-followup",
      retained: true,
    });
    sessions.markRunning(missing.id);
    sessions.registerInterrupt(missing.id, () => undefined);
    const denied = await callFleetToolRaw(sendInput, {
      target: missing.id,
      message: "steer",
      interrupt: true,
    });
    expect(denied.isError).toBe(true);
    expect(sessions.get(missing.id)?.lifecycleStatus).toBe("running");
  });

  test("completion during interrupt delivers the stashed steer as a follow-up", async () => {
    let followupStarted = false;
    const { sessions, fleetRecords, worker } = liveLane({
      inFlight: true,
      followup: async () => {
        followupStarted = true;
        return "follow-up report";
      },
    });
    sessions.registerInterrupt(worker.id, () => {
      sessions.complete(worker.id, "original report");
    });

    const sendInput = createSendInputTool({ sessions, fleetRecords });
    const wait = createWaitAgentsTool({ sessions, fleetRecords });
    const result = await callTool(sendInput, {
      target: worker.id,
      message: "late interrupt",
      interrupt: true,
    });
    expect(result).toEqual({ agent_id: worker.id, status: "interrupted" });

    const collected = await callTool(wait, {
      targets: [worker.id],
      timeout_ms: 1000,
    });
    expect(collected.timed_out).toBe(false);
    expect(collected.results).toEqual([
      expect.objectContaining({
        agent_id: worker.id,
        status: "done",
        report: "follow-up report",
      }),
    ]);
    expect(followupStarted).toBe(true);
    expect(sessions.get(worker.id)?.entries).toContainEqual(
      expect.objectContaining({
        kind: "report",
        content: expect.stringContaining("original report"),
      }),
    );
  });

  test("CL-7344: AgentClosedError follow-up wait collects failed", async () => {
    const { AgentClosedError } = await import("@intx/agent");
    const { sessions, fleetRecords, worker } = liveLane({
      inFlight: true,
      interrupt: () => undefined,
      followup: async () => {
        throw new AgentClosedError();
      },
    });
    const list = createListAgentsTool({ sessions, fleetRecords });
    const resume = createResumeAgentTool({ sessions, fleetRecords });
    const results = await interruptSteerThenCollect({
      sessions,
      fleetRecords,
      worker,
    });
    expect(defined(results[0]).status).toBe("failed");
    expect(defined(results[0]).error).toContain("closed");

    const listed = await callTool(list, {});
    const listedWorker = (
      listed.agents as { agent_id: string; status: string; lifecycle: string }[]
    ).find((agent) => agent.agent_id === worker.id);
    expect(listedWorker?.status).toBe("failed");
    expect(listedWorker?.lifecycle).toBe("shutdown");

    const resumed = await callFleetToolRaw(resume, {
      target: worker.id,
      message: "retry",
    });
    expect(resumed.isError).toBe(true);
    expect(String(resumed.content)).toContain("status: shutdown");
  });

  test("rejects completed, interrupted, and closed sessions — steering is in-flight only", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const completed = startSession(sessions, {
      description: "done",
      retained: true,
    });
    sessions.markRunning(completed.id);
    sessions.registerDeliver(completed.id, () => {
      throw new Error("must not deliver to a completed session");
    });
    sessions.complete(completed.id, "## Summary\nDone.");
    const completedErr = await callFleetToolRaw(sendInput, {
      target: completed.id,
      message: "x",
    });
    expect(completedErr.isError).toBe(true);

    const interrupted = startSession(sessions, {
      description: "paused",
      retained: true,
    });
    sessions.markRunning(interrupted.id);
    sessions.registerInterrupt(interrupted.id, () => undefined);
    sessions.registerDeliver(interrupted.id, () => {
      throw new Error("must not deliver to an interrupted session");
    });
    await callTool(createInterruptAgentTool({ sessions, fleetRecords }), {
      target: interrupted.id,
    });
    const interruptedErr = await callFleetToolRaw(sendInput, {
      target: interrupted.id,
      message: "x",
    });
    expect(interruptedErr.isError).toBe(true);

    const closed = startSession(sessions, {
      description: "closed",
      retained: true,
    });
    sessions.markRunning(closed.id);
    sessions.registerClose(closed.id, async () => undefined);
    sessions.registerDeliver(closed.id, () => {
      throw new Error("must not deliver to a closed session");
    });
    await callTool(createCloseAgentTool({ sessions, fleetRecords }), {
      target: closed.id,
    });
    const closedErr = await callFleetToolRaw(sendInput, {
      target: closed.id,
      message: "x",
    });
    expect(closedErr.isError).toBe(true);
    expect(sessions.get(closed.id)?.lifecycleStatus).toBe("shutdown");
  });

  test("completed send_input error redirects to resume_agent and mailbox mail", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const completed = startSession(sessions, {
      description: "done",
      retained: true,
    });
    sessions.markRunning(completed.id);
    sessions.registerDeliver(completed.id, () => {
      throw new Error("must not deliver to a completed session");
    });
    sessions.complete(completed.id, "## Summary\nDone.");
    const err = await callFleetToolRaw(sendInput, {
      target: completed.id,
      message: "late steer",
    });
    expect(err.isError).toBe(true);
    expect(err.content).toContain(`cannot send_input to "${completed.id}"`);
    expect(err.content).toContain("status: completed");
    expect(err.content).toContain("resume_agent");
    expect(err.content).toContain("mailbox mail");
    expect(err.content).toContain("do not retry send_input");
    expect(err.content).toContain("Summary: Done.");
    expect(err.content).toContain(
      `report_uri: tool-output:///fleet-dry:${completed.id}:report`,
    );
    expect(err.content).toContain("read_file");
  });

  test("interrupted send_input error resumes without a false report-delivered claim", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const worker = startSession(sessions, {
      description: "paused",
      retained: true,
    });
    sessions.markRunning(worker.id);
    sessions.registerInterrupt(worker.id, () => undefined);
    sessions.registerDeliver(worker.id, () => {
      throw new Error("must not deliver to an interrupted session");
    });
    await callTool(createInterruptAgentTool({ sessions, fleetRecords }), {
      target: worker.id,
    });
    const err = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "late steer",
    });
    expect(err.isError).toBe(true);
    expect(err.content).toContain(`cannot send_input to "${worker.id}"`);
    expect(err.content).toContain("status: interrupted");
    expect(err.content).toContain("resume_agent");
    expect(err.content).toContain("do not retry send_input");
    expect(err.content).toContain("no report delivered");
    expect(err.content).not.toContain("report was delivered");
    expect(err.content).not.toContain("mailbox mail");
  });

  test("shutdown send_input error points at trace/spawn, never resume_agent", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const worker = startSession(sessions, {
      description: "closed",
      retained: true,
    });
    sessions.markRunning(worker.id);
    sessions.registerClose(worker.id, async () => undefined);
    sessions.registerDeliver(worker.id, () => {
      throw new Error("must not deliver to a closed session");
    });
    await callTool(createCloseAgentTool({ sessions, fleetRecords }), {
      target: worker.id,
    });
    expect(sessions.get(worker.id)?.lifecycleStatus).toBe("shutdown");
    const err = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "late steer",
    });
    expect(err.isError).toBe(true);
    expect(err.content).toContain(`cannot send_input to "${worker.id}"`);
    expect(err.content).toContain("status: shutdown");
    expect(err.content).toContain("read_agent_trace");
    expect(err.content).not.toContain("use resume_agent for another turn");
    expect(err.content).not.toContain("report was delivered");
  });

  test("enforces nested orchestrator descendant authority", async () => {
    const sessions = createSubAgentSessionStore();
    const nested = startSession(sessions, {
      id: "nested",
      description: "nested",
    });
    const child = startSession(sessions, {
      id: "child",
      description: "child",
      parentSessionId: nested.id,
    });
    const sibling = startSession(sessions, {
      id: "sibling",
      description: "sibling",
    });
    for (const session of [nested, child, sibling]) {
      sessions.markRunning(session.id);
      sessions.registerDeliver(session.id, () => undefined);
    }
    const sendInput = createSendInputTool({
      sessions,
      authority: {
        actorId: nested.id,
        tier: "nested-orchestrator",
        getNodes: () => sessions.list(),
      },
    });

    const ok = await callTool(sendInput, {
      target: child.id,
      message: "continue",
    });
    expect(ok.status).toBe("running");

    const denied = await callFleetToolRaw(sendInput, {
      target: sibling.id,
      message: "continue",
    });
    expect(denied.isError).toBe(true);
  });

  test("fails closed when nested authority has no actorId", async () => {
    const sessions = createSubAgentSessionStore();
    const worker = startSession(sessions, {
      id: "worker",
      description: "worker",
    });
    sessions.markRunning(worker.id);
    sessions.registerDeliver(worker.id, () => undefined);
    const sendInput = createSendInputTool({
      sessions,
      authority: {
        actorId: undefined,
        tier: "nested-orchestrator",
        getNodes: () => sessions.list(),
      },
    });
    const denied = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "x",
    });
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain("no resolvable session");
  });

  test("structured escalation resolution requires the pending questionId and rejects a stale one (SF2)", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });
    const worker = startSession(sessions, { description: "worker" });
    sessions.markRunning(worker.id);
    sessions.registerAsk(worker.id, {
      question: "which file?",
      questionId: "ask-1",
      assessment: assessedAsk,
      resolve: () => undefined,
      reject: () => undefined,
    });

    const noQuestion = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "No.",
      resolution: { kind: "declined", answer: "No." },
    });
    expect(noQuestion.isError).toBe(true);
    expect(String(noQuestion.content)).toContain("questionId");

    const mismatch = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "No.",
      resolution: {
        kind: "declined",
        answer: "No.",
        questionId: "ask-0",
      },
    });
    expect(mismatch.isError).toBe(true);
    expect(String(mismatch.content)).toContain("questionId mismatch");
    expect(String(mismatch.content)).toContain('"ask-1"');
    expect(sessions.hasPendingAsk(worker.id)).toBe(true);
  });

  test("structured resolution delivers the message together with the answer (SF6)", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });
    const worker = startSession(sessions, { description: "worker" });
    sessions.markRunning(worker.id);
    let resolved: string | undefined;
    sessions.registerAsk(worker.id, {
      question: "which file?",
      questionId: "ask-1",
      assessment: assessedAsk,
      resolve: (answer) => {
        resolved = answer;
      },
      reject: () => {
        throw new Error("should not reject");
      },
    });

    const both = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "use branch X",
      resolution: {
        kind: "declined",
        answer: "No credential grant.",
        questionId: "ask-1",
      },
    });
    expect(both.isError).not.toBe(true);
    expect(resolved).toBe("use branch X\nNo credential grant.");
    expect(sessions.get(worker.id)?.terminalOutcome).toMatchObject({
      kind: "verification_blocked",
      resolution: "declined",
    });
  });

  test("a resolution with no pending escalation is ignored and the message is delivered as plain input", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });
    const worker = startSession(sessions, { description: "worker" });
    sessions.markRunning(worker.id);
    const delivered: string[] = [];
    sessions.registerDeliver(worker.id, (message) => {
      delivered.push(message);
    });

    // Filler a field-filling model sent after approve_worker_call had
    // already answered the worker's only ask.
    const fillers = [
      { questionId: "", kind: "director_answer", answer: "" },
      {
        questionId: "ask-2",
        kind: "director_answer",
        answer: "Additional requirement applies after rebase.",
      },
      {
        questionId: "none",
        kind: "unavailable",
        answer: "No escalation; normal task update only.",
      },
    ];
    for (const resolution of fillers) {
      const result = await callTool(sendInput, {
        target: worker.id,
        message: "also require the PR checklist",
        interrupt: false,
        resolution,
      });
      expect(result).toEqual({
        agent_id: worker.id,
        status: "running",
        resolution_ignored: "no pending escalation",
      });
    }
    expect(delivered).toEqual(
      fillers.map(() => "also require the PR checklist"),
    );
  });

  test("an interrupt carrying a resolution with no pending escalation interrupts as a plain interrupt would", async () => {
    let interrupted = false;
    const followups: string[] = [];
    const { sessions, fleetRecords, worker } = liveLane({
      interrupt: () => {
        interrupted = true;
      },
      followup: async (message) => {
        followups.push(message);
        return "queued turn finished";
      },
      deliver: () => {
        throw new Error("interrupt:true should not soft-deliver");
      },
    });
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const result = await callTool(sendInput, {
      target: worker.id,
      message: "patch only the test",
      interrupt: true,
      resolution: {
        questionId: "none",
        kind: "unavailable",
        answer: "No escalation; normal task update only.",
      },
    });
    expect(result).toEqual({
      agent_id: worker.id,
      status: "interrupted",
      resolution_ignored: "no pending escalation",
    });
    expect(interrupted).toBe(true);
    sessions.attachReport(worker.id, "salvage", { stopReason: "interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(followups).toEqual(["patch only the test"]);
  });

  test("an interrupt carrying a resolution is refused while an ask is pending", async () => {
    let interrupted = false;
    const { sessions, fleetRecords, worker } = liveLane({
      interrupt: () => {
        interrupted = true;
      },
      followup: async () => "unused",
    });
    sessions.registerAsk(worker.id, {
      question: "which file?",
      questionId: "ask-1",
      assessment: assessedAsk,
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: () => undefined,
    });
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const result = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "use branch X",
      interrupt: true,
      resolution: {
        questionId: "ask-1",
        kind: "director_answer",
        answer: "use branch X",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cannot interrupt");
    expect(interrupted).toBe(false);
    expect(sessions.hasPendingAsk(worker.id)).toBe(true);
  });

  test("an interrupt carrying a malformed resolution while an ask is pending reports the interrupt conflict", async () => {
    let interrupted = false;
    const { sessions, fleetRecords, worker } = liveLane({
      interrupt: () => {
        interrupted = true;
      },
      followup: async () => "unused",
    });
    sessions.registerAsk(worker.id, {
      question: "which file?",
      questionId: "ask-1",
      assessment: assessedAsk,
      resolve: () => {
        throw new Error("should not resolve");
      },
      reject: () => undefined,
    });
    const sendInput = createSendInputTool({ sessions, fleetRecords });

    const result = await callFleetToolRaw(sendInput, {
      target: worker.id,
      message: "use branch X",
      interrupt: true,
      resolution: { questionId: "", kind: "not_a_kind", answer: "" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cannot interrupt");
    expect(result.content).not.toContain("resolution invalid");
    expect(interrupted).toBe(false);
    expect(sessions.hasPendingAsk(worker.id)).toBe(true);
  });

  test("an unusable resolution against a pending ask names the plain-message alternative", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const sendInput = createSendInputTool({ sessions, fleetRecords });
    const worker = startSession(sessions, { description: "worker" });
    sessions.markRunning(worker.id);
    sessions.registerAsk(worker.id, {
      question: "which file?",
      questionId: "ask-1",
      assessment: assessedAsk,
      resolve: () => undefined,
      reject: () => undefined,
    });

    for (const resolution of [
      { questionId: "", kind: "director_answer", answer: "" },
      { questionId: "ask-0", kind: "declined", answer: "No." },
    ]) {
      const result = await callFleetToolRaw(sendInput, {
        target: worker.id,
        message: "No.",
        resolution,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "Omit resolution to answer with a plain message.",
      );
    }
    expect(sessions.hasPendingAsk(worker.id)).toBe(true);
  });
});

describe("nested lifecycle authority", () => {
  function nestAuthority(
    sessions: ReturnType<typeof createSubAgentSessionStore>,
    actorId: string,
  ) {
    return {
      actorId,
      tier: "nested-orchestrator" as const,
      getNodes: () => sessions.list(),
    };
  }

  function nestedSetup(retained = false) {
    const sessions = createSubAgentSessionStore();
    const nested = startSession(sessions, { id: "nested", description: "n" });
    const child = startSession(sessions, {
      id: "child",
      description: "c",
      parentSessionId: nested.id,
      ...(retained ? { retained: true } : {}),
    });
    const sibling = startSession(sessions, {
      id: "sibling",
      description: "s",
      ...(retained ? { retained: true } : {}),
    });
    const fleetRecords = createFleetMailbox(sessions);
    return { sessions, nested, child, sibling, fleetRecords };
  }

  test.each([
    {
      tool: "interrupt_agent",
      arm: (sessions: SessionStore, id: string) => {
        sessions.markRunning(id);
        sessions.registerInterrupt(id, () => undefined);
      },
      allowedStatus: "interrupted",
    },
    {
      tool: "close_agent",
      arm: (sessions: SessionStore, id: string) => {
        sessions.registerClose(id, async () => undefined);
      },
      allowedStatus: "shutdown",
    },
    {
      tool: "resume_agent",
      retained: true,
      arm: (sessions: SessionStore, id: string) => {
        sessions.complete(id, "done");
        sessions.registerFollowup(id, async () => "reply");
      },
      allowedStatus: "running",
    },
  ])(
    "$tool denies a sibling and allows a descendant",
    async ({ tool, retained, arm, allowedStatus }) => {
      const { sessions, nested, child, sibling, fleetRecords } = nestedSetup(
        retained ?? false,
      );
      for (const s of [child, sibling]) arm(sessions, s.id);
      const authority = nestAuthority(sessions, nested.id);
      const deps = { sessions, fleetRecords, authority };
      const agentTool =
        tool === "interrupt_agent"
          ? createInterruptAgentTool(deps)
          : tool === "close_agent"
            ? createCloseAgentTool(deps)
            : createResumeAgentTool(deps);
      const callArgs =
        tool === "resume_agent"
          ? { target: child.id, message: "more" }
          : { target: child.id };

      const allowed = await callTool(agentTool, callArgs);
      expect(allowed.status).toBe(allowedStatus);

      const denied = await callFleetToolRaw(agentTool, {
        ...callArgs,
        target: sibling.id,
      });
      expect(denied.isError).toBe(true);
      if (tool === "close_agent") {
        expect(sessions.get(sibling.id)?.lifecycleStatus).not.toBe("shutdown");
      }
    },
  );
});

describe("approve_worker_call", () => {
  test("nested parent reaches the approval handler through worker authz while its gate still denies the child call", async () => {
    const grants = getProcessWorkerGrantStore();
    grants.clear();
    const cwd = "/tmp/nested-worker-approval";
    const sessions = createSubAgentSessionStore();
    const nested = startSession(sessions, {
      id: "nested-parent",
      description: "nested parent",
    });
    const { session, envelope } = pendingDeniedAsk(sessions, {
      id: "nested-child",
      cwd,
      command: "printf changed > generated.txt",
      parentSessionId: nested.id,
    });
    const permissionGate = parentGate(cwd, false);
    const args = {
      target: session.id,
      question_id: `${session.id}-question`,
      request_id: envelope.requestId,
    };

    expect(
      (
        await createWorkerAuthorize(permissionGate)(
          "tool:approve_worker_call",
          "invoke",
          { id: "approve-1", name: "approve_worker_call", arguments: args },
        )
      ).effect,
    ).toBe("allow");

    const approve = createApproveWorkerCallTool({
      sessions,
      authority: {
        actorId: nested.id,
        tier: "nested-orchestrator",
        getNodes: () => sessions.list(),
      },
      permissionGate,
    });
    const denied = await callFleetToolRaw(approve, args);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("parent permission evaluation denied");
    expect(sessions.hasPendingAsk(session.id)).toBe(true);
    expect(envelope.status).toBe("pending");
    grants.clear();
  });

  test.each([
    ["read-only Git-shaped", "git status --short"],
    ["consequential shell", "printf changed > generated.txt"],
  ])(
    "%s authorizes only the exact pending retry once",
    async (_name, command) => {
      const grants = getProcessWorkerGrantStore();
      grants.clear();
      const cwd = "/tmp/worker-approval";
      const sessions = createSubAgentSessionStore();
      const gate = parentGate(cwd, true);
      const { session, envelope, received } = pendingDeniedAsk(sessions, {
        id: `worker-${command.length}`,
        cwd,
        command,
      });
      const approve = createApproveWorkerCallTool({
        sessions,
        permissionGate: gate,
      });

      const approved = await callTool(approve, {
        target: session.id,
        question_id: `${session.id}-question`,
        request_id: envelope.requestId,
      });
      expect(approved.status).toBe("authorized");
      expect(received).toEqual([
        "Parent approved the exact denied call; retry it once.",
      ]);
      expect(sessions.hasPendingAsk(session.id)).toBe(false);

      const workerGate = workerPermissionGate(gate, { sessionId: session.id });
      expect(
        await runWithSubAgentIdentity({ description: "worker", cwd }, () =>
          workerGate.authorizeCall({
            id: "retry-1",
            name: "run_shell",
            arguments: { command },
          }),
        ),
      ).toEqual({ effect: "allow" });
      expect(
        await runWithSubAgentIdentity({ description: "worker", cwd }, () =>
          workerGate.executionVerdict({
            id: "retry-1",
            name: "run_shell",
            arguments: { command },
          }),
        ),
      ).toEqual({ effect: "allow" });
      expect(grants.peek(envelope.requestId)?.status).toBe("consumed");
      const duplicateExecution = await runWithSubAgentIdentity(
        { description: "worker", cwd },
        () =>
          workerGate.executionVerdict({
            id: "retry-2",
            name: "run_shell",
            arguments: { command },
          }),
      );
      expect(duplicateExecution.effect).toBe("deny");
      grants.clear();
    },
  );

  test("an ordinary denied call reaches the operator once, through the approve_worker_call prompt", async () => {
    const grants = getProcessWorkerGrantStore();
    grants.clear();
    // The gate's path checks resolve against cwd, so it must exist.
    const cwd = mkdtempSync(join(tmpdir(), "worker-approval-one-prompt-"));
    const sessions = createSubAgentSessionStore();
    const { session, envelope } = pendingDeniedAsk(sessions, {
      id: "worker-one-prompt",
      cwd,
      command: "printf changed > generated.txt",
    });
    const prompts: string[] = [];
    const gate = createPermissionGate({
      approvals: [],
      cwd,
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
      requestApproval: async (request) => {
        prompts.push(request.tool);
        return { allow: true };
      },
    });
    const call = {
      id: "approve-once",
      name: "approve_worker_call",
      arguments: {
        target: session.id,
        question_id: `${session.id}-question`,
        request_id: envelope.requestId,
      },
    };

    expect(await gate.evaluate(call)).toEqual({ allowed: true });
    const approved = await callTool(
      createApproveWorkerCallTool({
        sessions,
        permissionGate: gate,
        approvalPrompted: true,
      }),
      call.arguments,
    );

    expect(approved.status).toBe("authorized");
    expect(prompts).toEqual(["approve_worker_call"]);
    grants.clear();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("an in-flight allowed retry cannot leave an authorized replay", async () => {
    const grants = getProcessWorkerGrantStore();
    grants.clear();
    const cwd = "/tmp/worker-approval-race";
    const command = "printf changed > generated.txt";
    const sessions = createSubAgentSessionStore();
    const { session, envelope } = pendingDeniedAsk(sessions, {
      id: "worker-race",
      cwd,
      command,
    });
    const baseGate = parentGate(cwd, true);
    let enteredExecution!: () => void;
    const executionEntered = new Promise<void>((resolve) => {
      enteredExecution = resolve;
    });
    let resumeExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      resumeExecution = resolve;
    });
    const gate = {
      ...baseGate,
      executionVerdict: async () => {
        enteredExecution();
        await executionGate;
        return { effect: "allow" } as const;
      },
    };
    const workerGate = workerPermissionGate(gate, { sessionId: session.id });
    const execution = runWithSubAgentIdentity(
      { description: "worker", cwd },
      () =>
        workerGate.executionVerdict({
          id: "retry-racing",
          name: "run_shell",
          arguments: { command },
        }),
    );
    await executionEntered;

    const approve = createApproveWorkerCallTool({
      sessions,
      permissionGate: gate,
    });
    const approval = callFleetToolRaw(approve, {
      target: session.id,
      question_id: `${session.id}-question`,
      request_id: envelope.requestId,
    });
    resumeExecution();

    await expect(execution).resolves.toEqual({ effect: "allow" });
    const approvalResult = await approval;
    expect(approvalResult.isError).toBe(true);
    expect(String(approvalResult.content)).toContain("does not match");
    expect(envelope.status).toBe("consumed");
    await expect(
      runWithSubAgentIdentity({ description: "worker", cwd }, () =>
        workerGate.executionVerdict({
          id: "retry-replay",
          name: "run_shell",
          arguments: { command },
        }),
      ),
    ).resolves.toMatchObject({ effect: "deny" });
    grants.clear();
  });

  test("rejects wrong or stale IDs, altered envelope args/CWD, expiry, decline, failed evaluation, and duplicate approval", async () => {
    const grants = getProcessWorkerGrantStore();
    grants.clear();
    const cwd = "/tmp/worker-approval-fail-closed";
    const sessions = createSubAgentSessionStore();
    const { session, envelope } = pendingDeniedAsk(sessions, {
      id: "worker-fail-closed",
      cwd,
      command: "git status --short",
    });
    const approve = createApproveWorkerCallTool({
      sessions,
      permissionGate: parentGate(cwd, true),
    });
    const args = {
      target: session.id,
      question_id: `${session.id}-question`,
      request_id: envelope.requestId,
    };

    for (const invalid of [
      { ...args, target: "wrong-worker" },
      { ...args, question_id: "wrong-question" },
      { ...args, request_id: "wrong-request" },
    ]) {
      const result = await callFleetToolRaw(approve, invalid);
      expect(result.isError).toBe(true);
      expect(sessions.hasPendingAsk(session.id)).toBe(true);
    }

    envelope.args.command = "git reset --hard";
    expect((await callFleetToolRaw(approve, args)).isError).toBe(true);
    envelope.args.command = "git status --short";
    envelope.cwd = "/tmp/altered-cwd";
    expect((await callFleetToolRaw(approve, args)).isError).toBe(true);
    envelope.cwd = cwd;

    envelope.expiresAt = Date.now() - 1;
    expect((await callFleetToolRaw(approve, args)).isError).toBe(true);
    expect(envelope.status).toBe("expired");
    grants.clear();

    const declinedSessions = createSubAgentSessionStore();
    const declined = pendingDeniedAsk(declinedSessions, {
      id: "worker-declined",
      cwd,
      command: "printf changed > generated.txt",
    });
    const declineTool = createApproveWorkerCallTool({
      sessions: declinedSessions,
      permissionGate: parentGate(cwd, false),
    });
    const declinedArgs = {
      target: declined.session.id,
      question_id: `${declined.session.id}-question`,
      request_id: declined.envelope.requestId,
    };
    expect((await callFleetToolRaw(declineTool, declinedArgs)).isError).toBe(
      true,
    );
    expect(declinedSessions.hasPendingAsk(declined.session.id)).toBe(true);

    const failedTool = createApproveWorkerCallTool({
      sessions: declinedSessions,
      permissionGate: {
        ...parentGate(cwd, true),
        evaluate: async () => {
          throw new Error("gate unavailable");
        },
      },
    });
    expect((await callFleetToolRaw(failedTool, declinedArgs)).isError).toBe(
      true,
    );
    expect(declinedSessions.hasPendingAsk(declined.session.id)).toBe(true);

    const successTool = createApproveWorkerCallTool({
      sessions: declinedSessions,
      permissionGate: parentGate(cwd, true),
    });
    expect((await callTool(successTool, declinedArgs)).status).toBe(
      "authorized",
    );
    expect((await callFleetToolRaw(successTool, declinedArgs)).isError).toBe(
      true,
    );
    grants.clear();
  });
});
