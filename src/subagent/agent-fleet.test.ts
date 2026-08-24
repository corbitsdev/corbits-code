import { describe, expect, test } from "bun:test";

import {
  createFleetRecords,
  createSpawnAgentTool,
  createWaitAgentsTool,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createPermissionGate } from "../permission/gate.js";
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
  opts: { cwd?: string } = {},
): AgentFleetDeps {
  return {
    permissionGate: testPermissionGate,
    cwd: opts.cwd ?? "/tmp",
    getWorkdirBase: () => "/tmp/workdir",
    provider,
    run,
    sessions: createSubAgentSessionStore(),
    fleetRecords: createFleetRecords(),
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

  test("wait_agents with no targets waits on all currently running spawned agents", async () => {
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
    // them is collected, proving fleetRecords — not the store — is what
    // wait_agents actually reads from.
    const COUNT = 25;
    const deps = makeDeps(async () => ({ report: "irrelevant" }));
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

    // The store itself has already evicted all but the most recent 20.
    expect(deps.sessions.get(ids[0]!)).toBeUndefined();

    // But every single one is still retrievable through wait_agents.
    const waited = await callTool(wait, { targets: ids, timeout_ms: 5000 });
    const results = waited.results as { agent_id: string; status: string; report?: string }[];
    expect(results).toHaveLength(COUNT);
    for (const result of results) {
      expect(result.status).toBe("done");
      expect(result.report).toBe("irrelevant");
    }
  });
});

describe("spawn_agent write-lane isolation", () => {
  test("refuses a second concurrent implement-intent spawn against the same cwd", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise, { cwd: "/repo" });
    const spawn = createSpawnAgentTool(deps);

    const first = await callTool(spawn, {
      description: "build one",
      prompt: "implement thing one",
      intent: "implement",
    });
    expect(first.status).toBe("running");

    const second = await callToolRaw(spawn, {
      description: "build two",
      prompt: "implement thing two",
      intent: "implement",
    });
    expect(second.isError).toBe(true);
    expect(second.content).toContain("Error:");
    expect(second.content).toContain(first.agent_id as string);

    gate.resolve({ report: "done" });
  });

  test("does not refuse a second concurrent explore-intent spawn against the same cwd", async () => {
    const deps = makeDeps(async () => ({ report: "explored" }), { cwd: "/repo" });
    const spawn = createSpawnAgentTool(deps);

    const first = await callTool(spawn, {
      description: "explore one",
      prompt: "look around",
      intent: "explore",
    });
    const second = await callTool(spawn, {
      description: "explore two",
      prompt: "look around more",
      intent: "explore",
    });

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
  });

  test("releases the write lane once the implement worker finishes, allowing another", async () => {
    const deps = makeDeps(async () => ({ report: "built" }), { cwd: "/repo" });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions, fleetRecords: deps.fleetRecords });

    const first = await callTool(spawn, {
      description: "build one",
      prompt: "implement thing one",
      intent: "implement",
    });
    await callTool(wait, { targets: [first.agent_id as string], timeout_ms: 5000 });

    const second = await callTool(spawn, {
      description: "build two",
      prompt: "implement thing two",
      intent: "implement",
    });
    expect(second.status).toBe("running");
  });
});
