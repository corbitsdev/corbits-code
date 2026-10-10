import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactorEmittedEvent } from "@intx/inference";

import { createResolvedProviderFailureError } from "../inference-error-message.js";
import { createAdmissionQueue } from "./admission.js";
import {
  callFleetTool,
  createFleetDeps,
  deferred,
  fleetTools,
  spawnAgentId,
  waitUntilMailboxTerminal,
} from "./fleet-test-harness.js";
import { pollUntil } from "./run-test-harness.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

type Row = Record<string, unknown> & {
  agent_id: string;
  status: string;
  failure?: Record<string, unknown>;
};

function retryable(): Error {
  return createResolvedProviderFailureError("test-provider", {
    category: "retryable",
    message: "upstream overloaded",
    statusCode: 429,
  });
}

function credential(): Error {
  return createResolvedProviderFailureError("test-provider", {
    category: "credential_failure",
    message: "Authentication failed",
    statusCode: 401,
  });
}

const inferenceError = {
  type: "inference.error",
  seq: 1,
  data: { error: { category: "retryable" }, partial: { text: "" } },
} as unknown as ReactorEmittedEvent;

async function waitRows(
  tools: ReturnType<typeof fleetTools>,
  targets: string[],
): Promise<Row[]> {
  const waited = await callFleetTool(tools.wait, {
    targets,
    timeout_ms: 5_000,
    mode: "all",
  });
  expect(waited.timed_out).toBe(false);
  return waited.results as Row[];
}

const spawnArgs = { description: "job", prompt: "do it", intent: "explore" };

describe("failure_class drives the existing provider markers", () => {
  test.each([
    ["retryable", retryable, "provider_retryable", true],
    ["credential", credential, "provider_fatal", false],
  ] as const)(
    "%s failure: continuable equals recovery.available",
    async (_label, makeError, failureClass, available) => {
      const deps = createFleetDeps(async () => {
        throw makeError();
      });
      const tools = fleetTools(deps);
      const id = await spawnAgentId(tools.spawn, spawnArgs);
      const [row] = await waitRows(tools, [id]);
      expect(row?.status).toBe("failed");
      expect(row?.provider_failure).toBe(true);
      expect(row?.failure?.failure_class).toBe(failureClass);
      expect(row?.failure?.recovery).toEqual(
        available
          ? { available: true, reason: "eligible" }
          : { available: false, reason: "not_retryable" },
      );
      expect(row?.continuable === true).toBe(available);
    },
  );

  test("a permission suspension after an observed inference.error is error, not provider", async () => {
    const deps = createFleetDeps(async (params) => {
      params.onEvent?.(inferenceError);
      throw Object.assign(
        new Error("Sub-agent send returned a suspended result"),
        {
          suspendedType: "suspended",
          correlationId: "corr-1",
        },
      );
    });
    const tools = fleetTools(deps);
    const id = await spawnAgentId(tools.spawn, spawnArgs);
    const [row] = await waitRows(tools, [id]);
    expect(row?.failure?.failure_class).toBe("error");
    expect(row?.provider_failure).toBeUndefined();
    expect(row?.continuable).toBeUndefined();
  });

  test("an unclassified throw after an observed inference.error stays provider_fatal", async () => {
    const deps = createFleetDeps(async (params) => {
      params.onEvent?.(inferenceError);
      throw new Error("send rejected");
    });
    const tools = fleetTools(deps);
    const id = await spawnAgentId(tools.spawn, spawnArgs);
    const [row] = await waitRows(tools, [id]);
    expect(row?.provider_failure).toBe(true);
    expect(row?.failure?.failure_class).toBe("provider_fatal");
    expect(row?.continuable).toBeUndefined();
  });
});

describe("parent-side setup failure", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a worktree setup failure classifies as error, never provider", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "corbits-not-a-repo-"));
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    dirs.push(notARepo, workdirBase);
    let ran = false;
    const deps = createFleetDeps(
      async () => {
        ran = true;
        return { report: "no" };
      },
      { cwd: notARepo },
    );
    deps.getWorkdirBase = () => workdirBase;
    deps.useWorktree = true;
    const tools = fleetTools(deps);
    const id = await spawnAgentId(tools.spawn, spawnArgs);
    const [row] = await waitRows(tools, [id]);
    expect(ran).toBe(false);
    expect(row?.status).toBe("failed");
    expect(row?.failure?.failure_class).toBe("error");
    expect(row?.provider_failure).toBeUndefined();
  });
});

describe("terminal failure cleanup", () => {
  test("a failure with an open ask releases the wait, the ask, and the admission slot once", async () => {
    const admission = createAdmissionQueue({ capacity: 1 });
    const failFirst = deferred<undefined>();
    let started = 0;
    let askOutcome: Promise<string> | undefined;
    const deps = createFleetDeps(
      async (params: RunSubAgentParams): Promise<RunSubAgentResult> => {
        started += 1;
        if (started > 1) return { report: "second done" };
        params.onAgentReady?.({
          close: async () => undefined,
          interrupt: () => undefined,
          followup: async () => "",
          deliver: () => undefined,
        });
        askOutcome = params.askDirectorPort?.register({
          question: "which path?",
          questionId: "ask-1",
        });
        void askOutcome?.catch(() => undefined);
        await failFirst.promise;
        throw retryable();
      },
    );
    deps.admission = admission;
    const tools = fleetTools(deps);
    const first = await spawnAgentId(tools.spawn, spawnArgs);
    const second = await callFleetTool(tools.spawn, spawnArgs);
    expect(second.status).toBe("queued");
    await pollUntil(() => deps.sessions.hasPendingAsk(first));

    failFirst.resolve(undefined);
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, first);
    const [row] = await waitRows(tools, [first]);
    expect(row?.status).toBe("failed");
    expect(row?.failure).toMatchObject({
      failure_class: "provider_retryable",
      handoff: "unavailable",
      cleanup: "released",
    });
    await expect(askOutcome).rejects.toThrow("session failed");
    expect(deps.sessions.hasPendingAsk(first)).toBe(false);
    expect(deps.sessions.isRunInFlight(first)).toBe(false);
    await pollUntil(() => !admission.occupied(first));

    const secondId = second.agent_id as string;
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, secondId);
    expect(started).toBe(2);
    expect(deps.fleetRecords.peek(secondId)?.status).toBe("done");

    // Collected once: a later wait does not hand the failure out again.
    const again = await callFleetTool(tools.wait, { timeout_ms: 20 });
    expect((again.results as Row[]).map((r) => r.agent_id)).toEqual([secondId]);
  });

  test("late events after settlement change neither the record nor spawn anything", async () => {
    let started = 0;
    const deps = createFleetDeps(async () => {
      started += 1;
      throw retryable();
    });
    const tools = fleetTools(deps);
    const id = await spawnAgentId(tools.spawn, spawnArgs);
    const [row] = await waitRows(tools, [id]);
    const record = deps.sessions.get(id)?.failure;
    expect(record).toBeDefined();

    deps.sessions.appendEvent(id, inferenceError);
    deps.sessions.fail(id, "late", { failure_class: "loop_guard" });
    deps.sessions.complete(id, "late report");
    deps.sessions.cancel(id);

    expect(deps.sessions.get(id)?.failure).toBe(
      record as NonNullable<typeof record>,
    );
    expect(deps.fleetRecords.peek(id)?.failure).toEqual(
      row?.failure as unknown as typeof record,
    );
    expect(started).toBe(1);
  });
});

describe("parent-facing status", () => {
  test("list_agents distinguishes failed, cancelled, completed, and running lanes", async () => {
    const hold = deferred<RunSubAgentResult>();
    const runs = [
      async (): Promise<RunSubAgentResult> => {
        throw retryable();
      },
      async (): Promise<RunSubAgentResult> => ({ report: "fine" }),
      (): Promise<RunSubAgentResult> => hold.promise,
      (): Promise<RunSubAgentResult> => new Promise(() => undefined),
    ];
    let next = 0;
    const deps = createFleetDeps(() => {
      const run = runs[next];
      next += 1;
      if (run === undefined) throw new Error("unexpected spawn");
      return run();
    });
    const tools = fleetTools(deps);
    const failed = await spawnAgentId(tools.spawn, spawnArgs);
    const done = await spawnAgentId(tools.spawn, spawnArgs);
    const cancelled = await spawnAgentId(tools.spawn, spawnArgs);
    const running = await spawnAgentId(tools.spawn, spawnArgs);
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, failed);
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, done);
    deps.sessions.cancel(cancelled);
    deps.sessions.settleRun(cancelled);

    const listed = await callFleetTool(tools.list, {});
    const rows = new Map(
      (listed.agents as Row[]).map((row) => [row.agent_id, row]),
    );
    expect(rows.get(failed)?.status).toBe("failed");
    expect(rows.get(failed)?.failure?.failure_class).toBe("provider_retryable");
    expect(rows.get(cancelled)?.status).toBe("interrupted");
    expect(rows.get(cancelled)?.stop_reason).toBe("cancelled");
    expect(rows.get(cancelled)?.failure?.failure_class).toBe("cancelled");
    expect(rows.get(done)?.status).toBe("done");
    expect(rows.get(done)?.failure).toBeUndefined();
    expect(rows.get(running)?.status).toBe("running");
    expect(rows.get(running)?.failure).toBeUndefined();
  });

  test("a stalled salvage is done with stop_reason and a stalled record", async () => {
    const deps = createFleetDeps(async () => ({
      report: "salvaged",
      stopReason: "stalled",
    }));
    const tools = fleetTools(deps);
    const id = await spawnAgentId(tools.spawn, spawnArgs);
    const [row] = await waitRows(tools, [id]);
    expect(row?.status).toBe("done");
    expect(row?.stop_reason).toBe("stalled");
    expect(row?.failure?.failure_class).toBe("stalled");
    expect(row?.continuable).toBeUndefined();
  });

  test("the mailbox digest carries the same record as wait_agents", async () => {
    const deps = createFleetDeps(async () => {
      throw retryable();
    });
    const tools = fleetTools(deps);
    const id = await spawnAgentId(tools.spawn, spawnArgs);
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, id);
    const { driveMailboxMail } = await import("./mailbox-mail-drive.js");
    const prompts: string[] = [];
    await driveMailboxMail({
      parentProcessing: false,
      mailbox: deps.fleetRecords,
      lanes: deps.sessions.list(),
      beginSystemContinuation: () => undefined,
      send: (prompt: string) => {
        prompts.push(prompt);
        return { status: "accepted" };
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"failure_class":"provider_retryable"');
    expect(prompts[0]).toContain('"continuable":true');
  });
});
