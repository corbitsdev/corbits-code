import { describe, expect, test } from "bun:test";

import { createSpawnAgentTool, createWaitAgentsTool, type AgentFleetDeps } from "./agent-fleet.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams } from "./types.js";

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

function makeDeps(run: (params: RunSubAgentParams) => Promise<string>): AgentFleetDeps {
  return {
    permissionGate: testPermissionGate,
    cwd: "/tmp",
    getWorkdirBase: () => "/tmp/workdir",
    provider,
    run,
    sessions: createSubAgentSessionStore(),
  };
}

async function callTool(
  tool: ReturnType<typeof createSpawnAgentTool> | ReturnType<typeof createWaitAgentsTool>,
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

describe("spawn_agent", () => {
  test("returns immediately with a running agent_id without waiting for the worker", async () => {
    const gate = deferred<string>();
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

    gate.resolve("done");
  });
});

describe("spawn_agent + wait_agents", () => {
  test("wait_agents on one target returns once it completes while siblings keep running", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let callIndex = 0;
    const deps = makeDeps(async () => {
      const i = callIndex++;
      return gates[i]!.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions });

    const spawned = await Promise.all(
      [0, 1, 2].map((i) =>
        callTool(spawn, { description: `job-${i}`, prompt: "do it", intent: "explore" }),
      ),
    );
    const ids = spawned.map((s) => s.agent_id as string);

    gates[0]!.resolve("first report");

    const waited = await callTool(wait, { targets: [ids[0]], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string; report?: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("done");
    expect(results[0]!.report).toBe("first report");

    // The other two remain untouched and running.
    expect(deps.sessions.get(ids[1]!)?.status).toBe("running");
    expect(deps.sessions.get(ids[2]!)?.status).toBe("running");

    gates[1]!.resolve("second");
    gates[2]!.resolve("third");
  });

  test("wait_agents times out on a still-running agent without cancelling it, and can be called again", async () => {
    const gate = deferred<string>();
    const deps = makeDeps(async () => gate.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions });

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
    gate.resolve("finished");
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
    const gates = [deferred<string>(), deferred<string>()];
    let callIndex = 0;
    const deps = makeDeps(async () => gates[callIndex++]!.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions: deps.sessions });

    await callTool(spawn, { description: "a", prompt: "do it", intent: "explore" });
    await callTool(spawn, { description: "b", prompt: "do it", intent: "explore" });

    gates[0]!.resolve("a done");
    const result = await callTool(wait, { timeout_ms: 5000 });
    expect(result.timed_out).toBe(false);
    const results = result.results as { status: string }[];
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.status === "done")).toBe(true);

    gates[1]!.resolve("b done");
  });
});
