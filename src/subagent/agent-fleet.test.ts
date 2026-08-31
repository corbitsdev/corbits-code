import { describe, expect, test } from "bun:test";

import {
  createFleetMailbox,
  createSpawnAgentTool,
  createWaitAgentsTool,
  createListAgentsTool,
  MAX_FLEET_RECORDS,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import {
  createInterruptAgentTool,
  createCloseAgentTool,
  createSendInputTool,
} from "./lifecycle-tools.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createPermissionGate } from "../permission/gate.js";
import { agentLaneIsLive, fleetProgress } from "../tui/agent-progress.js";
import { AGENTS_PANEL_LINGER_MS, formatAgentsPanel } from "../tui/chrome-state.js";
import { forcedStopReport } from "./stop-policy.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(
  run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>,
  opts: { cwd?: string; sessions?: ReturnType<typeof createSubAgentSessionStore> } = {},
): AgentFleetDeps {
  const sessions = opts.sessions ?? createSubAgentSessionStore();
  return {
    permissionGate: testPermissionGate,
    cwd: opts.cwd ?? "/tmp",
    getWorkdirBase: () => "/tmp/workdir",
    provider,
    run,
    sessions,
    fleetRecords: createFleetMailbox(sessions),
  };
}

async function callToolRaw(
  tool: ReturnType<typeof createSpawnAgentTool> | ReturnType<typeof createWaitAgentsTool>,
  args: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    { id: `call-${Math.random()}`, name: tool.definition.name, arguments: args },
    new AbortController().signal,
  );
  const content =
    typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  return { content, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
}

async function callTool(
  tool: ReturnType<typeof createSpawnAgentTool> | ReturnType<typeof createWaitAgentsTool>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { content } = await callToolRaw(tool, args);
  return JSON.parse(content);
}

describe("spawn_agent", () => {
  test("returns immediately with a running agent_id without waiting for the worker", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    const spawn = createSpawnAgentTool(deps);

    const started = Date.now();
    const result = await callTool(spawn, {
      description: "job",
      prompt: "do it",
      intent: "explore",
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe("running");
    expect(typeof result.agent_id).toBe("string");
    expect(elapsed).toBeLessThan(1000);

    // Worker is still pending; store confirms it has not finished.
    expect(deps.sessions.get(result.agent_id as string)?.status).toBe("running");

    gate.resolve({ report: "done" });
  });
});

describe("spawn_agent + wait_agents", () => {
  test("wait_agents on one target returns once it completes while siblings keep running", async () => {
    const gates = [
      deferred<RunSubAgentResult>(),
      deferred<RunSubAgentResult>(),
      deferred<RunSubAgentResult>(),
    ];
    let callIndex = 0;
    const deps = makeDeps(async () => {
      const i = callIndex++;
      return gates[i]!.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const spawned = await Promise.all(
      [0, 1, 2].map((i) =>
        callTool(spawn, { description: `job-${i}`, prompt: "do it", intent: "explore" }),
      ),
    );
    const ids = spawned.map((s) => s.agent_id as string);

    gates[0]!.resolve({ report: "first report" });

    const waited = await callTool(wait, { targets: [ids[0]], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string; report?: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("done");
    expect(results[0]!.report).toBe("first report");

    // The other two remain untouched and running.
    expect(deps.sessions.get(ids[1]!)?.status).toBe("running");
    expect(deps.sessions.get(ids[2]!)?.status).toBe("running");

    gates[1]!.resolve({ report: "second" });
    gates[2]!.resolve({ report: "third" });
  });

  test("wait_agents times out on a still-running agent without cancelling it, and can be called again", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const spawned = await callTool(spawn, {
      description: "slow job",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    const first = await callTool(wait, { targets: [id], timeout_ms: 50 });
    expect(first.timed_out).toBe(true);
    const firstResults = first.results as { agent_id: string; status: string }[];
    expect(firstResults[0]!.status).toBe("running");

    // Not cancelled, not failed — still running.
    expect(deps.sessions.get(id)?.status).toBe("running");

    // A second wait still works cleanly (either another timeout, or completion).
    gate.resolve({ report: "finished" });
    const second = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(second.timed_out).toBe(false);
    const secondResults = second.results as {
      agent_id: string;
      status: string;
      report?: string;
    }[];
    expect(secondResults[0]!.status).toBe("done");
    expect(secondResults[0]!.report).toBe("finished");
  });

  test("wait_agents with no targets waits on all uncollected agents in this fleet", async () => {
    const gates = [deferred<RunSubAgentResult>(), deferred<RunSubAgentResult>()];
    let callIndex = 0;
    const deps = makeDeps(async () => gates[callIndex++]!.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    await callTool(spawn, { description: "a", prompt: "do it", intent: "explore" });
    await callTool(spawn, { description: "b", prompt: "do it", intent: "explore" });

    gates[0]!.resolve({ report: "a done" });
    const result = await callTool(wait, { timeout_ms: 5000 });
    expect(result.timed_out).toBe(false);
    const results = result.results as { status: string }[];
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.status === "done")).toBe(true);

    gates[1]!.resolve({ report: "b done" });
  });

  test("reports survive well past the session store's display cap (20) until wait_agents collects them", async () => {
    // DEFAULT_MAX_COMPLETED on SubAgentSessionStore is 20 finished sessions;
    // spawn (and complete) enough workers to blow well past it before any of
    // them is collected, proving the wait mailbox pin keeps reports past the
    // store's display cap.
    //
    // CL-7007: this test previously asserted (as CL-7001's fix left it) that
    // the store itself had already evicted and released the earliest
    // session, because a retained session shared the 20-item display cap
    // with every other finished session — exactly the shipped defect this
    // ticket fixes (resume_agent failed with a bare
    // "not_found" past 20 spawned workers, blaming the caller for nothing).
    // Open retained sessions now have their own cap (`maxRetained`, default
    // 50), so 25 of them all stay resumable; mailbox pin + wait_agents is
    // still asserted below as the collect path regardless.
    const COUNT = 25;
    const deps = makeDeps(async () => ({ report: "irrelevant", agentRetained: true }));
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const spawned = await callTool(spawn, {
        description: `job-${i}`,
        prompt: `report-${i}`,
        intent: "explore",
      });
      ids.push(spawned.agent_id as string);
    }

    // Let every spawn's run() resolve and complete() land before collecting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 25 open retained sessions is under the default maxRetained (50), so
    // the earliest is still present and resumable — not evicted.
    expect(deps.sessions.get(ids[0]!)).toBeDefined();

    // Every single one is retrievable through wait_agents too.
    const waited = await callTool(wait, { targets: ids, timeout_ms: 5000 });
    const results = waited.results as { agent_id: string; status: string; report?: string }[];
    expect(results).toHaveLength(COUNT);
    for (const result of results) {
      expect(result.status).toBe("done");
      expect(result.report).toBe("irrelevant");
    }
  });

  // CL-6915: operator cancel aborts the child signal, but run() still returns a
  // salvage body (partial findings). Dropping that body left the wait mailbox
  // "running" forever so wait_agents never saw the salvage.
  test("cancelled spawn_agent still resolves wait_agents with salvage findings", async () => {
    const deps = makeDeps(async (params) => {
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await new Promise((r) => setTimeout(r, 10));
      return {
        report: forcedStopReport("cancelled", "Found path in gate.ts"),
        stopReason: "cancelled",
      };
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const spawned = await callTool(spawn, {
      description: "cancel salvage",
      prompt: "probe",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    expect(deps.sessions.cancel(id)).toBe(true);
    expect(deps.sessions.get(id)?.status).toBe("cancelled");

    const waited = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as {
      agent_id: string;
      status: string;
      report?: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("interrupted");
    expect(results[0]!.report).toContain("## Summary");
    expect(results[0]!.report).toContain("## Findings");
    expect(results[0]!.report).toContain("gate.ts");
    // Strip stays cancelled — salvage is for wait_agents, not a resurrection.
    expect(deps.sessions.get(id)?.status).toBe("cancelled");
    expect(deps.sessions.get(id)?.lifecycle.state).toBe("cancelled");
  });

  test("catch cancel wait_agents is interrupted, not failed", async () => {
    const deps = makeDeps(async (params) => {
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const spawned = await callTool(spawn, {
      description: "catch cancel",
      prompt: "probe",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    expect(deps.sessions.cancel(id)).toBe(true);

    const waited = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { status: string; error?: string; report?: string }[];
    expect(results[0]!.status).toBe("interrupted");
    expect(results[0]!.error).toBeUndefined();
    expect(deps.sessions.get(id)?.status).toBe("cancelled");
  });
});

describe("spawn_agent same-cwd concurrency", () => {
  test("two concurrent implement-intent spawn_agent calls against the same cwd both start", async () => {
    const gates = [deferred<RunSubAgentResult>(), deferred<RunSubAgentResult>()];
    let callIndex = 0;
    const deps = makeDeps(async () => gates[callIndex++]!.promise, { cwd: "/repo" });
    const spawn = createSpawnAgentTool(deps);

    const first = await callTool(spawn, {
      description: "build one",
      prompt: "implement thing one",
      intent: "implement",
    });
    const second = await callTool(spawn, {
      description: "build two",
      prompt: "implement thing two",
      intent: "implement",
    });

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");

    gates[0]!.resolve({ report: "one done" });
    gates[1]!.resolve({ report: "two done" });
  });
});

describe("wait mailbox session tombstone and pin", () => {
  test("many spawned-and-completed workers whose reports are never collected leave memory bounded", async () => {
    const COUNT = MAX_FLEET_RECORDS + 50;
    const deps = makeDeps(async () => ({ report: "x".repeat(1000) }));
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const spawned = await callTool(spawn, {
        description: `job-${i}`,
        prompt: `p-${i}`,
        intent: "explore",
      });
      ids.push(spawned.agent_id as string);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const waited = await callTool(wait, { targets: ids, timeout_ms: 5000 });
    const results = waited.results as { status: string; report?: string }[];
    const withReport = results.filter((r) => r.report !== undefined).length;

    // Payloads are capped: well under COUNT full reports survive uncollected.
    expect(withReport).toBeLessThanOrEqual(MAX_FLEET_RECORDS);
    expect(withReport).toBeLessThan(COUNT);
  });

  test("an evicted-but-uncollected agent resolves to its terminal status plus a read_agent_trace pointer", async () => {
    const COUNT = MAX_FLEET_RECORDS + 50;
    const deps = makeDeps(async () => ({ report: "x".repeat(1000) }));
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const ids: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const spawned = await callTool(spawn, {
        description: `job-${i}`,
        prompt: `p-${i}`,
        intent: "explore",
      });
      ids.push(spawned.agent_id as string);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The earliest spawned agent's payload should have been tombstoned —
    // never collected, so it was evicted once the cap was exceeded.
    const waited = await callTool(wait, { targets: [ids[0]!], timeout_ms: 5000 });
    const results = waited.results as {
      agent_id: string;
      status: string;
      report?: string;
      hint?: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).not.toBe("unknown");
    expect(["done", "failed"]).toContain(results[0]!.status);
    expect(results[0]!.report).toBeUndefined();
    expect(results[0]!.hint).toContain("read_agent_trace");
  });
});

describe("spawn_agent parentage", () => {
  test("records the caller session as parentSessionId", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    deps.parentSessionId = "parent-orch";
    const spawn = createSpawnAgentTool(deps);

    const spawned = await callTool(spawn, {
      description: "child",
      prompt: "do it",
      intent: "explore",
    });
    const session = deps.sessions.get(spawned.agent_id as string);
    expect(session?.parentSessionId).toBe("parent-orch");

    gate.resolve({ report: "done" });
  });
});

describe("wait_agents caller scope", () => {
  test("omitted targets wait only on this fleet, not every running session in the shared store", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    const foreign = deps.sessions.start({
      id: "foreign-sibling",
      description: "someone else's worker",
      agentId: "explorer",
      brief: "b",
    });
    deps.sessions.markRunning(foreign.id);

    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "mine",
      prompt: "do it",
      intent: "explore",
    });

    const waited = await callTool(wait, { timeout_ms: 50 });
    expect(waited.timed_out).toBe(true);
    const results = waited.results as { agent_id: string; status: string }[];
    expect(results.map((r) => r.agent_id)).toEqual([spawned.agent_id as string]);
    expect(results.every((r) => r.agent_id !== foreign.id)).toBe(true);

    gate.resolve({ report: "done" });
  });

  test("mode=all stays blocked until every target is terminal", async () => {
    const gates = [deferred<RunSubAgentResult>(), deferred<RunSubAgentResult>()];
    let callIndex = 0;
    const deps = makeDeps(async () => gates[callIndex++]!.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const first = await callTool(spawn, {
      description: "a",
      prompt: "do it",
      intent: "explore",
    });
    const second = await callTool(spawn, {
      description: "b",
      prompt: "do it",
      intent: "explore",
    });
    const ids = [first.agent_id as string, second.agent_id as string];

    gates[0]!.resolve({ report: "a done" });
    const partial = await callTool(wait, { targets: ids, mode: "all", timeout_ms: 50 });
    expect(partial.timed_out).toBe(true);
    const partialResults = partial.results as { status: string }[];
    expect(partialResults.some((r) => r.status === "running")).toBe(true);

    gates[1]!.resolve({ report: "b done" });
    const finished = await callTool(wait, { targets: ids, mode: "all", timeout_ms: 5000 });
    expect(finished.timed_out).toBe(false);
    const finishedResults = finished.results as { status: string }[];
    expect(finishedResults.every((r) => r.status === "done")).toBe(true);
  });

  test("mode=all with one interrupted target stays blocked until siblings finish", async () => {
    const gates = [deferred<RunSubAgentResult>(), deferred<RunSubAgentResult>()];
    let callIndex = 0;
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return gates[callIndex++]!.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const interrupt = createInterruptAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const first = await callTool(spawn, {
      description: "a",
      prompt: "do it",
      intent: "explore",
    });
    const second = await callTool(spawn, {
      description: "b",
      prompt: "do it",
      intent: "explore",
    });
    const ids = [first.agent_id as string, second.agent_id as string];

    // Interrupt one of N before mode=all starts: interrupted is terminal for
    // that target, but mode=all must not complete as "all done" while a
    // sibling is still running.
    if (interrupt.kind !== "full") throw new Error("expected full tool");
    await interrupt.handler(
      { id: "int-1", name: "interrupt_agent", arguments: { target: ids[0]! } },
      new AbortController().signal,
    );

    const partial = await callTool(wait, { targets: ids, mode: "all", timeout_ms: 50 });
    expect(partial.timed_out).toBe(true);
    const partialResults = partial.results as { agent_id: string; status: string }[];
    expect(partialResults.find((r) => r.agent_id === ids[0]!)?.status).toBe("interrupted");
    expect(partialResults.find((r) => r.agent_id === ids[1]!)?.status).toBe("running");

    gates[1]!.resolve({ report: "b done" });
    const finished = await callTool(wait, { targets: ids, mode: "all", timeout_ms: 5000 });
    expect(finished.timed_out).toBe(false);
    const finishedResults = finished.results as { agent_id: string; status: string }[];
    expect(finishedResults.find((r) => r.agent_id === ids[0]!)?.status).toBe("interrupted");
    expect(finishedResults.find((r) => r.agent_id === ids[1]!)?.status).toBe("done");
    // Leave the interrupted gate unresolved — interrupt unblocked the wait
    // without the run settling.
  });

  test("aborting the wait returns without cancelling workers", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "slow",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    if (wait.kind !== "full") throw new Error("expected full tool");
    const ac = new AbortController();
    const started = Date.now();
    const pending = wait.handler(
      { id: "wait-1", name: "wait_agents", arguments: { targets: [id], timeout_ms: 5000 } },
      ac.signal,
    );
    ac.abort();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(500);
    const content =
      typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const parsed = JSON.parse(content) as {
      timed_out: boolean;
      results: { status: string }[];
    };
    expect(parsed.timed_out).toBe(true);
    expect(parsed.results[0]!.status).toBe("running");
    expect(deps.sessions.get(id)?.status).toBe("running");

    gate.resolve({ report: "done" });
  });
});

describe("interrupt_agent unblocks wait_agents", () => {
  test("interrupt marks the fleet record terminal so wait returns without the run settling", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const interrupt = createInterruptAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    const waiting = callTool(wait, { targets: [id], timeout_ms: 5000 });
    if (interrupt.kind !== "full") throw new Error("expected full tool");
    await interrupt.handler(
      { id: "int-1", name: "interrupt_agent", arguments: { target: id } },
      new AbortController().signal,
    );

    const waited = await waiting;
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string }[];
    expect(results).toEqual([{ agent_id: id, status: "interrupted" }]);
    expect(deps.sessions.get(id)?.lifecycleStatus).toBe("interrupted");
    expect(deps.sessions.get(id)?.status).toBe("running");
  });

  test("an interrupted run result terminalizes a still-running fleet record", async () => {
    const settle = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => settle.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    settle.resolve({
      report: "## Summary\nStopped.\n## Findings\npartial\n## Blockers\ninterrupted\n## Paths\n",
      interrupted: true,
    });

    const waited = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { status: string; report?: string }[];
    expect(results[0]!.status).toBe("interrupted");
    expect(results[0]!.report).toContain("partial");
  });

  test("send_input soft-deliver does not complete wait_agents", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const sendInput = createSendInputTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    await callTool(sendInput, { target: id, message: "keep going" });
    const waited = await callTool(wait, { targets: [id], timeout_ms: 50 });
    expect(waited.timed_out).toBe(true);
    const results = waited.results as { status: string }[];
    expect(results[0]!.status).toBe("running");
    gate.resolve({ report: "done" });
  });

  test("send_input interrupt:true unblocks wait_agents as interrupted", async () => {
    const gate = deferred<RunSubAgentResult>();
    const followupGate = deferred<string>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => followupGate.promise,
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const sendInput = createSendInputTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    const waiting = callTool(wait, { targets: [id], timeout_ms: 5000 });
    await callTool(sendInput, { target: id, message: "stop that", interrupt: true });
    const waited = await waiting;
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { status: string }[];
    expect(results[0]!.status).toBe("interrupted");
    followupGate.resolve("later");
  });

  test("soft-interrupt wait path collects so omitted re-wait does not re-deliver", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    // interruptOne is wait-terminal via session interrupted; collect freezes it.
    expect(deps.sessions.interruptOne(id).ok).toBe(true);
    expect(deps.fleetRecords.peek(id)?.status).toBe("interrupted");

    const waited = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string }[];
    expect(results).toEqual([{ agent_id: id, status: "interrupted" }]);
    expect(deps.fleetRecords.peek(id)?.status).toBe("interrupted");
    expect(deps.fleetRecords.peek(id)?.collected).toBe(true);

    const again = await callTool(wait, { timeout_ms: 50 });
    expect(again.timed_out).toBe(false);
    expect(again.results).toEqual([]);
  });

  test("late salvage attaches after wait collected an early interrupt", async () => {
    const settle = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return settle.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const interrupt = createInterruptAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    // Let onAgentReady register interrupt before we call interrupt_agent.
    await new Promise((resolve) => setTimeout(resolve, 20));

    if (interrupt.kind !== "full") throw new Error("expected full tool");
    await interrupt.handler(
      { id: "int-1", name: "interrupt_agent", arguments: { target: id } },
      new AbortController().signal,
    );

    const early = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect((early.results as { status: string }[])[0]!.status).toBe("interrupted");
    expect((early.results as { report?: string }[])[0]!.report).toBeUndefined();

    settle.resolve({
      report: "## Summary\nStopped.\n## Findings\nsalvage\n## Blockers\ninterrupted\n## Paths\n",
      interrupted: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const again = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    const results = again.results as { status: string; report?: string }[];
    expect(results[0]!.status).toBe("interrupted");
    expect(results[0]!.report).toContain("salvage");
  });

  test("soft-interrupt wait collects so a later followup cannot resurrect done", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const worker = sessions.start({
      id: "soft-int",
      description: "looping",
      agentId: "explorer",
      brief: "b",
      retained: true,
    });
    sessions.markRunning(worker.id);
    fleetRecords.register(worker.id);
    sessions.registerInterrupt(worker.id, () => {});
    sessions.interruptOne(worker.id);

    const wait = createWaitAgentsTool({ sessions, fleetRecords });
    const waited = await callTool(wait, { targets: [worker.id], timeout_ms: 1000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { status: string }[];
    expect(results[0]!.status).toBe("interrupted");
    expect(fleetRecords.peek(worker.id)?.collected).toBe(true);

    fleetRecords.completeAfterInterrupt(worker.id, "resurrected reply");
    sessions.complete(worker.id, "resurrected reply");
    expect(fleetRecords.peek(worker.id)?.status).toBe("interrupted");
    expect(fleetRecords.peek(worker.id)?.collected).toBe(true);
  });

  test("uncollected send_input followup complete clears overlay so wait is done", async () => {
    const followupGate = deferred<string>();
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => followupGate.promise,
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const sendInput = createSendInputTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    await callTool(sendInput, { target: id, message: "stop that", interrupt: true });
    followupGate.resolve("followup report");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waited = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { status: string; report?: string }[];
    expect(results[0]!.status).toBe("done");
    expect(results[0]!.report).toBe("followup report");
  });
});

describe("close_agent unblocks wait_agents", () => {
  test("close terminalizes the fleet record so wait returns without the run settling", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const close = createCloseAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    const waiting = callTool(wait, { targets: [id], timeout_ms: 5000 });
    if (close.kind !== "full") throw new Error("expected full tool");
    await close.handler(
      { id: "close-1", name: "close_agent", arguments: { target: id } },
      new AbortController().signal,
    );

    const waited = await waiting;
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string }[];
    expect(results).toEqual([{ agent_id: id, status: "interrupted" }]);
    expect(deps.sessions.get(id)?.lifecycleStatus).toBe("shutdown");
    expect(deps.fleetRecords.peek(id)?.status).toBe("interrupted");
  });
});

describe("list_agents", () => {
  test("lists this fleet only, including director and lifecycle", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    deps.sessions.start({
      id: "foreign-sibling",
      description: "someone else's worker",
      agentId: "explorer",
      brief: "b",
    });
    const spawn = createSpawnAgentTool(deps);
    const list = createListAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "mine",
      prompt: "do it",
      intent: "explore",
    });
    if (list.kind !== "full") throw new Error("expected full tool");
    const raw = await list.handler(
      { id: "list-1", name: "list_agents", arguments: {} },
      new AbortController().signal,
    );
    const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content);
    const parsed = JSON.parse(content) as {
      agents: {
        agent_id: string;
        status: string;
        collected: boolean;
        director?: string;
        description?: string;
        lifecycle?: string;
      }[];
    };
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.agent_id).toBe(spawned.agent_id as string);
    expect(parsed.agents[0]!.status).toBe("running");
    expect(parsed.agents[0]!.collected).toBe(false);
    expect(parsed.agents[0]!.director).toBe("explorer");
    expect(parsed.agents[0]!.description).toBe("mine");
    expect(parsed.agents[0]!.lifecycle).toBe("pending_init");
    gate.resolve({ report: "done" });
  });

  test("interrupt_agent leaves the strip after the linger window", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const interrupt = createInterruptAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "looping",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (interrupt.kind !== "full") throw new Error("expected full tool");
    await interrupt.handler(
      { id: "int-strip", name: "interrupt_agent", arguments: { target: id } },
      new AbortController().signal,
    );
    const agents = deps.sessions.list();
    const session = agents[0]!;
    expect(session.status).toBe("running");
    expect(session.lifecycleStatus).toBe("interrupted");
    expect(agentLaneIsLive(session)).toBe(false);
    const finishedAt = session.finishedAt!;
    expect(finishedAt).toBeNumber();
    const inside = finishedAt + 1_000;
    expect(fleetProgress(agents, inside).running).toBe(0);
    expect(formatAgentsPanel(agents, undefined, inside)?.[0]?.status).toBe("interrupted");
    expect(formatAgentsPanel(agents, undefined, finishedAt + AGENTS_PANEL_LINGER_MS)).toBeNull();
    gate.resolve({ report: "done", interrupted: true });
  });
});

describe("spawn_agent parity with task", () => {
  test("uses the parent tool call id as the session id", async () => {
    const deps = makeDeps(async () => ({ report: "done" }));
    const spawn = createSpawnAgentTool(deps);
    if (spawn.kind !== "full") throw new Error("expected full tool");
    const result = await spawn.handler(
      {
        id: "call-fixed-id",
        name: "spawn_agent",
        arguments: { description: "job", prompt: "do it", intent: "explore" },
      },
      new AbortController().signal,
    );
    const content = typeof result.content === "string" ? result.content : "";
    expect(JSON.parse(content).agent_id).toBe("call-fixed-id");
    expect(deps.sessions.get("call-fixed-id")).toBeDefined();
  });

  test("refuses skywalker as a spawned worker", async () => {
    const deps = makeDeps(async () => ({ report: "no" }));
    const spawn = createSpawnAgentTool(deps);
    const raw = await callToolRaw(spawn, {
      description: "nope",
      prompt: "do it",
      agent: "skywalker",
    });
    expect(raw.isError).toBe(true);
    expect(raw.content).toContain("skywalker is the primary session identity");
  });

  test("rejects a child outside this director allowlist", async () => {
    const deps = makeDeps(async () => ({ report: "no" }));
    deps.spawnAllowlist = ["intern", "explorer", "critic"];
    const spawn = createSpawnAgentTool(deps);
    const raw = await callToolRaw(spawn, {
      description: "build",
      prompt: "ship it",
      agent: "builder",
    });
    expect(raw.isError).toBe(true);
    expect(raw.content).toContain("allowlist");
    expect(raw.content).toContain("builder");
  });

  test("a maySpawn director is launched as an orchestrator with nestedDispatch", async () => {
    const captured: RunSubAgentParams[] = [];
    const deps = makeDeps(async (params) => {
      captured.push(params);
      return { report: "ok" };
    });
    const spawn = createSpawnAgentTool(deps);
    await callTool(spawn, {
      description: "arch",
      prompt: "judge this",
      agent: "greybeard",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.orchestrator).toBe(true);
    expect(captured[0]!.orchestratorTier).toBe("nested-orchestrator");
    expect(captured[0]!.nestedDispatch).toBeDefined();
    expect(captured[0]!.nestedDispatch?.spawnAllowlist).toEqual(["intern", "explorer", "critic"]);
  });

  test("allowOrchestrator false strips nested spawn even for maySpawn directors", async () => {
    const captured: RunSubAgentParams[] = [];
    const deps = makeDeps(async (params) => {
      captured.push(params);
      return { report: "ok" };
    });
    deps.allowOrchestrator = false;
    const spawn = createSpawnAgentTool(deps);
    await callTool(spawn, {
      description: "arch",
      prompt: "judge this",
      agent: "greybeard",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured[0]!.orchestrator).toBeUndefined();
    expect(captured[0]!.nestedDispatch).toBeUndefined();
  });
});
