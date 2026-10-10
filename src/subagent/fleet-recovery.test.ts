import { afterEach, describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createResolvedProviderFailureError } from "../inference-error-message.js";
import {
  createDeniedCallEnvelope,
  getProcessWorkerGrantStore,
} from "../permission/worker-grant.js";
import { driveOpenTasksAfterFleetDry } from "./fleet-dry-drive.js";
import { driveMailboxMail } from "./mailbox-mail-drive.js";
import {
  callFleetTool,
  callFleetToolRaw,
  createFleetDeps,
  fleetTools,
  spawnAgentId,
  waitUntilMailboxTerminal,
} from "./fleet-test-harness.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createSubAgentLoopGuardError } from "./terminal-failure.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

type Behavior = (params: RunSubAgentParams) => Promise<RunSubAgentResult>;
type Row = Record<string, unknown> & {
  agent_id: string;
  status: string;
  failure?: {
    failure_class?: string;
    attempt?: number;
    recovers?: string;
    handoff?: string;
    recovery?: Record<string, unknown>;
  };
};

const brief = { description: "plan", prompt: "write the plan", intent: "plan" };

function retryable(): Error {
  return createResolvedProviderFailureError("test-provider", {
    category: "timeout",
    message: "upstream timed out",
  });
}

function toolStart(name: string, id: string): ReactorEmittedEvent {
  return {
    type: "tool.start",
    seq: 1,
    data: { call: { name, id, arguments: {} } },
  } as unknown as ReactorEmittedEvent;
}

const failRetryably: Behavior = async () => {
  throw retryable();
};

function failAfterTools(names: readonly string[]): Behavior {
  return async (params) => {
    names.forEach((name, i) => params.onEvent?.(toolStart(name, `t${i}`)));
    throw retryable();
  };
}

const succeed: Behavior = async () => ({ report: "plan written" });

/** Fleet whose Nth spawn runs behaviors[N]; extra spawns fail the test. */
function scriptedFleet(behaviors: readonly Behavior[]) {
  const runs: RunSubAgentParams[] = [];
  const deps = createFleetDeps(async (params) => {
    runs.push(params);
    const behavior = behaviors[runs.length - 1];
    if (behavior === undefined) throw new Error("unexpected extra spawn");
    return behavior(params);
  });
  return { deps, runs, tools: fleetTools(deps) };
}

async function failedLane(
  fleet: ReturnType<typeof scriptedFleet>,
): Promise<{ id: string; row: Row }> {
  const id = await spawnAgentId(fleet.tools.spawn, brief);
  await waitUntilMailboxTerminal(
    fleet.deps.fleetRecords,
    fleet.deps.sessions,
    id,
  );
  const waited = await callFleetTool(fleet.tools.wait, {
    targets: [id],
    timeout_ms: 5_000,
  });
  const row = (waited.results as Row[])[0];
  if (row === undefined) throw new Error("no wait row");
  return { id, row };
}

async function recover(
  fleet: ReturnType<typeof scriptedFleet>,
  failedId: string,
): Promise<{ content: string; isError?: boolean }> {
  return callFleetToolRaw(fleet.tools.spawn, { ...brief, recovers: failedId });
}

function refusalReason(content: string): string | undefined {
  return /^Error: recovery_unavailable reason=([a-z_]+):/.exec(content)?.[1];
}

describe("recovery is never automatic", () => {
  test("a retryable failure yields zero replacements without a recovers call, even after fleet ticks and dry-drive", async () => {
    const fleet = scriptedFleet([failRetryably]);
    const { id, row } = await failedLane(fleet);
    expect(row.continuable).toBe(true);
    expect(row.continue_with).toBe(
      `Recoverable: call spawn_agent with recovers="${id}" at most once.`,
    );

    await driveMailboxMail({
      parentProcessing: false,
      mailbox: fleet.deps.fleetRecords,
      lanes: fleet.deps.sessions.list(),
      beginSystemContinuation: () => undefined,
      send: () => ({ status: "accepted" }),
    });
    await driveOpenTasksAfterFleetDry({
      previousRunning: 1,
      running: 0,
      openTasks: [{ id: "t1", title: "plan", status: "doing" }],
      parentProcessing: false,
      mailbox: fleet.deps.fleetRecords,
      lanes: fleet.deps.sessions.list(),
      beginSystemContinuation: () => undefined,
      send: () => ({ status: "accepted" }),
    });
    await callFleetTool(fleet.tools.wait, { timeout_ms: 20 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fleet.runs).toHaveLength(1);
    expect(fleet.deps.sessions.list()).toHaveLength(1);
    expect(fleet.deps.sessions.get(id)?.failure?.recovery).toEqual({
      available: true,
      reason: "eligible",
    });
  });
});

describe("enforced recovery", () => {
  test("one recovers call starts exactly one replacement linked to the failure", async () => {
    const fleet = scriptedFleet([failRetryably, succeed]);
    const { id } = await failedLane(fleet);

    const result = await callFleetTool(fleet.tools.spawn, {
      ...brief,
      recovers: id,
    });
    const replacementId = result.agent_id as string;
    expect(result).toMatchObject({ recovers: id, attempt: 2 });
    expect(replacementId).not.toBe(id);
    await waitUntilMailboxTerminal(
      fleet.deps.fleetRecords,
      fleet.deps.sessions,
      replacementId,
    );

    expect(fleet.runs).toHaveLength(2);
    expect(fleet.deps.sessions.get(replacementId)?.recovers).toBe(id);
    expect(fleet.deps.fleetRecords.peek(replacementId)?.status).toBe("done");

    // The failed lane stays failed; it only gained the replacement link.
    const failed = fleet.deps.sessions.get(id);
    expect(failed?.lifecycle.state).toBe("failed");
    expect(fleet.deps.fleetRecords.peek(id)?.status).toBe("failed");
    expect(failed?.failure).toMatchObject({
      failure_class: "provider_retryable",
      attempt: 1,
      recovery: {
        available: false,
        reason: "already_recovered",
        replacement_id: replacementId,
      },
    });
  });

  test("concurrent recovers calls converge on one replacement", async () => {
    const fleet = scriptedFleet([failRetryably, succeed]);
    const { id } = await failedLane(fleet);

    const [a, b] = await Promise.all([recover(fleet, id), recover(fleet, id)]);
    const first = JSON.parse(a.content) as Record<string, unknown>;
    const second = JSON.parse(b.content) as Record<string, unknown>;
    expect(a.isError).not.toBe(true);
    expect(b.isError).not.toBe(true);
    expect(second.agent_id).toBe(first.agent_id);
    expect(second).toMatchObject({
      recovers: id,
      status: "recovery_already_started",
      reason: "already_recovered",
    });

    const third = await callFleetTool(fleet.tools.spawn, {
      ...brief,
      recovers: id,
    });
    expect(third.agent_id).toBe(first.agent_id);
    expect(third.reason).toBe("already_recovered");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fleet.runs).toHaveLength(2);
    expect(fleet.deps.sessions.list()).toHaveLength(2);
  });

  test("a failed replacement is recovery_exhausted and cannot be recovered again", async () => {
    const fleet = scriptedFleet([failRetryably, failRetryably]);
    const { id } = await failedLane(fleet);
    const replacementId = (
      await callFleetTool(fleet.tools.spawn, { ...brief, recovers: id })
    ).agent_id as string;
    await waitUntilMailboxTerminal(
      fleet.deps.fleetRecords,
      fleet.deps.sessions,
      replacementId,
    );
    const waited = await callFleetTool(fleet.tools.wait, {
      targets: [replacementId],
      timeout_ms: 5_000,
    });
    const row = (waited.results as Row[])[0];
    expect(row?.status).toBe("failed");
    expect(row?.failure).toMatchObject({
      failure_class: "provider_retryable",
      attempt: 2,
      recovers: id,
      recovery: { available: false, reason: "recovery_exhausted" },
    });
    expect(row?.continuable).toBeUndefined();
    expect(row?.continue_with).toBeUndefined();

    const again = await recover(fleet, replacementId);
    expect(again.isError).toBe(true);
    expect(refusalReason(again.content)).toBe("recovery_exhausted");
    expect(fleet.runs).toHaveLength(2);
  });

  test("a failure whose session was evicted is still recovered exactly once", async () => {
    const runs: RunSubAgentParams[] = [];
    const behaviors = [failRetryably, succeed];
    const deps = createFleetDeps(
      async (params) => {
        runs.push(params);
        const behavior = behaviors[runs.length - 1];
        if (behavior === undefined) throw new Error("unexpected extra spawn");
        return behavior(params);
      },
      { sessions: createSubAgentSessionStore({ maxCompleted: 0 }) },
    );
    const fleet = { deps, runs, tools: fleetTools(deps) };
    const { id } = await failedLane(fleet);
    expect(deps.sessions.get(id)).toBeUndefined();
    expect(deps.fleetRecords.peek(id)?.failure?.recovery.available).toBe(true);

    const first = await callFleetTool(fleet.tools.spawn, {
      ...brief,
      recovers: id,
    });
    const again = await callFleetTool(fleet.tools.spawn, {
      ...brief,
      recovers: id,
    });
    expect(again.agent_id).toBe(first.agent_id);
    expect(deps.fleetRecords.peek(id)?.failure?.recovery).toEqual({
      available: false,
      reason: "already_recovered",
      replacement_id: first.agent_id as string,
    });
    expect(runs).toHaveLength(2);
  });

  test("an invalid spawn does not consume the recovery", async () => {
    const fleet = scriptedFleet([failRetryably, succeed]);
    const { id } = await failedLane(fleet);
    const invalid = await callFleetToolRaw(fleet.tools.spawn, {
      description: "implement",
      prompt: "do it",
      intent: "implement",
      recovers: id,
    });
    expect(invalid.isError).toBe(true);
    expect(fleet.deps.sessions.get(id)?.failure?.recovery.available).toBe(true);

    const ok = await callFleetTool(fleet.tools.spawn, {
      ...brief,
      recovers: id,
    });
    expect(ok.attempt).toBe(2);
    expect(fleet.runs).toHaveLength(2);
  });
});

describe("ineligible recovery spawns nothing", () => {
  test.each([
    ["a completed write", ["read_file", "write_file"]],
    ["a run_shell call", ["grep", "run_shell"]],
    ["an MCP tool", ["mcp__tracker__create_issue"]],
    ["an unknown tool", ["mystery_tool"]],
  ] as const)("side_effects_completed after %s", async (_label, names) => {
    const fleet = scriptedFleet([failAfterTools(names)]);
    const { id, row } = await failedLane(fleet);
    expect(row.failure?.failure_class).toBe("provider_retryable");
    expect(row.failure?.recovery).toEqual({
      available: false,
      reason: "side_effects_completed",
    });
    expect(row.continuable).toBeUndefined();
    expect(row.continue_with).toBeUndefined();

    const refused = await recover(fleet, id);
    expect(refused.isError).toBe(true);
    expect(refusalReason(refused.content)).toBe("side_effects_completed");
    expect(fleet.runs).toHaveLength(1);
    expect(fleet.deps.sessions.list()).toHaveLength(1);
  });

  test("read, search, and web read calls keep a failure replay-safe", async () => {
    const fleet = scriptedFleet([
      failAfterTools(["read_file", "grep", "search_files", "web_fetch"]),
    ]);
    const { row } = await failedLane(fleet);
    expect(row.failure?.recovery).toEqual({
      available: true,
      reason: "eligible",
    });
    expect(row.continuable).toBe(true);
  });

  test.each([
    [
      "provider_fatal",
      async (): Promise<RunSubAgentResult> => {
        throw createResolvedProviderFailureError("test-provider", {
          category: "credential_failure",
          message: "Authentication failed",
        });
      },
    ],
    [
      "loop_guard",
      async (): Promise<RunSubAgentResult> => {
        throw createSubAgentLoopGuardError(
          new Error("reactor error: Doom loop detected: x"),
        );
      },
    ],
  ] as const)("not_retryable for %s", async (failureClass, behavior) => {
    const fleet = scriptedFleet([behavior]);
    const { id, row } = await failedLane(fleet);
    expect(row.failure?.failure_class).toBe(failureClass);
    const refused = await recover(fleet, id);
    expect(refused.isError).toBe(true);
    expect(refusalReason(refused.content)).toBe("not_retryable");
    expect(fleet.runs).toHaveLength(1);
  });

  test("not_retryable for a cancelled worker", async () => {
    const fleet = scriptedFleet([() => new Promise(() => undefined)]);
    const id = await spawnAgentId(fleet.tools.spawn, brief);
    fleet.deps.sessions.cancel(id);
    fleet.deps.sessions.settleRun(id);
    expect(fleet.deps.sessions.get(id)?.failure?.failure_class).toBe(
      "cancelled",
    );
    const refused = await recover(fleet, id);
    expect(refused.isError).toBe(true);
    expect(refusalReason(refused.content)).toBe("not_retryable");
    expect(fleet.runs).toHaveLength(1);
  });

  test("not_retryable for a worker that is still running", async () => {
    const fleet = scriptedFleet([() => new Promise(() => undefined)]);
    const id = await spawnAgentId(fleet.tools.spawn, brief);
    const refused = await recover(fleet, id);
    expect(refusalReason(refused.content)).toBe("not_retryable");
    expect(fleet.runs).toHaveLength(1);
  });

  test("an id that is not one of the caller's workers is refused", async () => {
    const fleet = scriptedFleet([]);
    const refused = await recover(fleet, "someone-else");
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("not one of your workers");
    expect(fleet.runs).toHaveLength(0);
    expect(fleet.deps.sessions.list()).toHaveLength(0);
  });
});

describe("replacement authority", () => {
  const touched: string[] = [];
  afterEach(() => {
    for (const id of touched.splice(0)) {
      getProcessWorkerGrantStore().invalidateSession(id, "test cleanup");
    }
  });

  // Callbacks and the per-run identity differ by construction; everything
  // else in the params is the authority a worker runs with.
  function authorityOf(params: RunSubAgentParams | undefined) {
    if (params === undefined) throw new Error("run never started");
    const {
      id: _id,
      signal: _signal,
      onEvent: _onEvent,
      onRunSettled: _onRunSettled,
      onAgentReady: _onAgentReady,
      askDirectorPort: _askDirectorPort,
      onProgress: _onProgress,
      ...authority
    } = params;
    return authority;
  }

  test("a replacement runs with exactly a fresh spawn's authority and none of the failed worker's state", async () => {
    let failedAsk: Promise<string> | undefined;
    const failWithGrantAndAsk: Behavior = async (params) => {
      const workerId = params.id ?? "";
      touched.push(workerId);
      getProcessWorkerGrantStore().register(
        createDeniedCallEnvelope({
          callId: "denied-1",
          tool: "write_file",
          subject: "src/a.ts",
          args: { path: "src/a.ts" },
          cwd: params.cwd,
          workerSessionId: workerId,
        }),
      );
      params.onAgentReady?.({
        close: async () => undefined,
        interrupt: () => undefined,
        followup: async () => "",
        deliver: () => undefined,
      });
      failedAsk = params.askDirectorPort?.register({
        question: "may I write src/a.ts?",
        questionId: "ask-1",
      });
      void failedAsk?.catch(() => undefined);
      throw retryable();
    };
    const fleet = scriptedFleet([failWithGrantAndAsk, succeed, succeed]);
    const { id, row } = await failedLane(fleet);
    expect(row.failure?.handoff).toBe("unavailable");
    await expect(failedAsk).rejects.toThrow("session failed");

    const replacementId = (
      await callFleetTool(fleet.tools.spawn, { ...brief, recovers: id })
    ).agent_id as string;
    const freshId = await spawnAgentId(fleet.tools.spawn, brief);
    touched.push(replacementId, freshId);
    await waitUntilMailboxTerminal(
      fleet.deps.fleetRecords,
      fleet.deps.sessions,
      freshId,
    );

    const replacementRun = fleet.runs.find((p) => p.id === replacementId);
    const freshRun = fleet.runs.find((p) => p.id === freshId);
    expect(authorityOf(replacementRun)).toEqual(authorityOf(freshRun));
    expect(replacementRun?.permissionGate).toBe(freshRun?.permissionGate);

    const grants = getProcessWorkerGrantStore();
    expect(grants.pendingForSession(id)).toBeUndefined();
    expect(grants.pendingForSession(replacementId)).toBeUndefined();
    expect(fleet.deps.sessions.hasPendingAsk(replacementId)).toBe(false);
  });
});
