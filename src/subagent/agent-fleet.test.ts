import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFleetMailbox,
  createSpawnAgentTool,
  createWaitAgentsTool,
  createListAgentsTool,
  MAX_FLEET_RECORDS,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import { createAdmissionQueue, unlimitedAdmissionQueue } from "./admission.js";
import { isLiveWaitStatus } from "./lifecycle.js";
import {
  createInterruptAgentTool,
  createCloseAgentTool,
  createSendInputTool,
} from "./lifecycle-tools.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { INTENT_DEFAULT_DIRECTOR } from "../agent/directors/registry.js";
import { createPermissionGate } from "../permission/gate.js";
import { agentLaneIsLive, fleetProgress } from "../tui/agent-progress.js";
import { AGENTS_PANEL_LINGER_MS, formatAgentsPanel } from "../tui/chrome-state.js";
import { forcedStopReport } from "./stop-policy.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";
import { INTERVENTION_FILE } from "./intervention-log.js";

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
  opts: {
    cwd?: string;
    sessions?: ReturnType<typeof createSubAgentSessionStore>;
  } & Partial<Pick<AgentFleetDeps, "settings" | "catalog" | "profiles">> = {},
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
    admission: unlimitedAdmissionQueue(),
    ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
  };
}

function waitUntilMailboxTerminal(
  mailbox: ReturnType<typeof createFleetMailbox>,
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  id: string,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): boolean => {
      const snap = mailbox.peek(id);
      return snap !== undefined && !isLiveWaitStatus(snap.status);
    };
    if (done()) {
      resolve();
      return;
    }
    const unsub = sessions.subscribe(() => {
      if (done()) {
        unsub();
        resolve();
      }
    });
    if (done()) {
      unsub();
      resolve();
    }
  });
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

  test("rejects unsupported profile orchestrators before starting a session", async () => {
    let runCalled = false;
    const deps = makeDeps(
      async () => {
        runCalled = true;
        return { report: "done" };
      },
      {
        profiles: [
          {
            id: "profile-orchestrator",
            orchestrator: true,
            systemPromptRole: "You coordinate work.",
          },
        ],
      },
    );
    const spawn = createSpawnAgentTool(deps);
    const result = await callToolRaw(spawn, {
      description: "profile job",
      prompt: "do it",
      agent: "profile-orchestrator",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("profile orchestrators are not supported");
    expect(runCalled).toBe(false);
    expect(deps.sessions.list()).toEqual([]);
  });

  test("dispatches a local profile id returned by search_agents", async () => {
    let captured: RunSubAgentParams | undefined;
    const deps = makeDeps(
      async (params) => {
        captured = params;
        return { report: "done" };
      },
      {
        profiles: [
          {
            id: "plugin-reviewer",
            capabilities: { mode: "allow", tools: ["read_file"] },
            systemPromptRole: "You are the plugin reviewer.",
          },
        ],
      },
    );
    const spawn = createSpawnAgentTool(deps);

    const result = await callTool(spawn, {
      description: "profile job",
      prompt: "do it",
      agent: "plugin-reviewer",
    });

    expect(result.status).toBe("running");
    expect(captured?.directorId).toBe("plugin-reviewer");
    expect(captured?.systemPromptRole).toBe("You are the plugin reviewer.");
    expect(captured?.capabilities).toEqual({ mode: "allow", tools: ["read_file"] });
    expect(captured?.tier).toBe("leaf");
    expect(captured?.orchestrator).toBeUndefined();
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
      success_criteria: ["thing one ships"],
    });
    const second = await callTool(spawn, {
      description: "build two",
      prompt: "implement thing two",
      intent: "implement",
      success_criteria: ["thing two ships"],
    });

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");

    gates[0]!.resolve({ report: "one done" });
    gates[1]!.resolve({ report: "two done" });
  });

  test("two concurrent shared-cwd spawn_agent lanes log concurrent-lane-overlap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-overlap-"));
    const gates = [deferred<RunSubAgentResult>(), deferred<RunSubAgentResult>()];
    let callIndex = 0;
    const deps = makeDeps(async () => gates[callIndex++]!.promise, { cwd: "/repo" });
    deps.getWorkdirBase = () => dir;
    const spawn = createSpawnAgentTool(deps);

    await callTool(spawn, {
      description: "build one",
      prompt: "implement thing one",
      intent: "implement",
      success_criteria: ["thing one ships"],
    });
    await callTool(spawn, {
      description: "build two",
      prompt: "implement thing two",
      intent: "implement",
      success_criteria: ["thing two ships"],
    });

    const path = join(dir, INTERVENTION_FILE);
    let log = "";
    for (let i = 0; i < 50; i++) {
      try {
        log = await readFile(path, "utf8");
        if (log.includes("concurrent-lane-overlap")) break;
      } catch {
        // append is fire-and-forget
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(log).toContain("concurrent-lane-overlap");
    expect(log).toContain("conflict");
    expect(log).toContain("/repo");
    expect(log).toContain("build one");
    expect(log).toContain("build two");

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

  test("spawn_agent call.id reuse still pins the new session", async () => {
    let t = 0;
    const sessions = createSubAgentSessionStore({
      maxCompleted: 1,
      now: () => ++t,
    });
    const firstRun = deferred<RunSubAgentResult>();
    const secondRun = deferred<RunSubAgentResult>();
    let calls = 0;
    const deps = makeDeps(
      async () => {
        calls += 1;
        return (calls === 1 ? firstRun : secondRun).promise;
      },
      { sessions },
    );
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({ sessions, fleetRecords: deps.fleetRecords });
    if (spawn.kind !== "full") throw new Error("expected full tool");
    const args = { description: "job", prompt: "do it", intent: "explore" };
    const signal = new AbortController().signal;

    await spawn.handler({ id: "reuse-id", name: "spawn_agent", arguments: args }, signal);
    firstRun.resolve({ report: "ok" });
    await callTool(wait, { targets: ["reuse-id"], timeout_ms: 5000 });

    await spawn.handler({ id: "reuse-id", name: "spawn_agent", arguments: args }, signal);
    secondRun.resolve({ report: "ok" });
    await waitUntilMailboxTerminal(deps.fleetRecords, sessions, "reuse-id");

    const extra1 = sessions.start({ description: "flood-1", agentId: "a", brief: "b" });
    sessions.complete(extra1.id, "flood-1");
    const extra2 = sessions.start({ description: "flood-2", agentId: "a", brief: "b" });
    sessions.complete(extra2.id, "flood-2");

    expect(sessions.get("reuse-id")).toBeDefined();
    const waited = await callTool(wait, { targets: ["reuse-id"], timeout_ms: 1000 });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { status: string }[];
    expect(results[0]!.status).toBe("done");
  });

  test("wait on a pruned mailbox member is tombstone not eternal running", () => {
    let t = 0;
    const sessions = createSubAgentSessionStore({
      maxCompleted: 1,
      now: () => ++t,
    });
    const mailbox = createFleetMailbox(sessions);
    sessions.start({ id: "reuse", description: "old", agentId: "a", brief: "b" });
    mailbox.register("reuse");
    sessions.complete("reuse", "old report");
    sessions.start({ id: "reuse", description: "new", agentId: "a", brief: "b" });
    sessions.complete("reuse", "new report");
    const extra = sessions.start({ description: "other", agentId: "a", brief: "b" });
    sessions.complete(extra.id, "other");
    const extra2 = sessions.start({ description: "prune", agentId: "a", brief: "b" });
    sessions.complete(extra2.id, "prune");
    expect(sessions.get("reuse")).toBeUndefined();
    const snap = mailbox.peek("reuse");
    expect(snap?.status).toBe("done");
    expect(snap?.tombstoned).toBe(true);
    expect(snap?.hint).toContain("read_agent_trace");
  });

  test("wait on a mailbox member with no session history is interrupted", () => {
    const sessions = createSubAgentSessionStore();
    const mailbox = createFleetMailbox(sessions);
    mailbox.register("ghost");
    const snap = mailbox.peek("ghost");
    expect(snap?.status).toBe("interrupted");
    expect(snap?.tombstoned).toBe(true);
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

  test("explicit targets respect nested orchestrator subtree authority", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetMailbox(sessions);
    const actor = sessions.start({
      id: "actor",
      description: "actor",
      agentId: "builder",
      brief: "b",
    });
    const child = sessions.start({
      id: "child",
      description: "child",
      agentId: "explorer",
      brief: "b",
      parentSessionId: actor.id,
    });
    const sibling = sessions.start({
      id: "sibling",
      description: "sibling",
      agentId: "explorer",
      brief: "b",
    });
    for (const session of [child, sibling]) {
      fleetRecords.register(session.id);
      sessions.complete(session.id, `${session.id} done`);
    }
    const wait = createWaitAgentsTool({
      sessions,
      fleetRecords,
      authority: {
        actorId: actor.id,
        tier: "nested-orchestrator",
        getNodes: () => sessions.list(),
      },
    });

    const own = await callTool(wait, { targets: [child.id], timeout_ms: 1000 });
    expect(own.timed_out).toBe(false);
    const ownResults = own.results as { agent_id: string; status: string; report?: string }[];
    expect(ownResults[0]).toEqual({ agent_id: child.id, status: "done", report: "child done" });

    if (wait.kind !== "full") throw new Error("expected full tool");
    const denied = await wait.handler(
      {
        id: "wait-denied",
        name: "wait_agents",
        arguments: { targets: [sibling.id], timeout_ms: 0 },
      },
      new AbortController().signal,
    );
    expect(denied.isError).toBe(true);
    expect(String(denied.content)).toContain("outside its subtree");
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

    // Soft interrupt leaves the run in flight; the mailbox overlay is what
    // makes wait terminal (same path interrupt_agent takes).
    expect(deps.sessions.interruptOne(id).ok).toBe(true);
    deps.fleetRecords.interrupt(id);
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
    // Mirror interrupt_agent: soft interrupt alone projects as running while
    // in-flight, so the mailbox must flip for wait to see "interrupted".
    fleetRecords.interrupt(worker.id);
    fleetRecords.interrupt(worker.id);

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

  test("projects question and question_id while awaiting_director", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      void params.askDirectorPort
        ?.register({
          question: "which file should I edit?",
          questionId: "ask-1",
        })
        .catch(() => {});
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const list = createListAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned = await callTool(spawn, {
      description: "need a path",
      prompt: "do it",
      intent: "explore",
    });
    await callTool(wait, { targets: [spawned.agent_id], timeout_ms: 5000 });
    if (list.kind !== "full") throw new Error("expected full tool");
    const raw = await list.handler(
      { id: "list-ask-1", name: "list_agents", arguments: {} },
      new AbortController().signal,
    );
    const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content);
    const parsed = JSON.parse(content) as {
      agents: {
        agent_id: string;
        status: string;
        collected: boolean;
        description?: string;
        question?: string;
        question_id?: string;
      }[];
    };
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.agent_id).toBe(spawned.agent_id as string);
    expect(parsed.agents[0]!.status).toBe("awaiting_director");
    expect(parsed.agents[0]!.collected).toBe(false);
    expect(parsed.agents[0]!.description).toBe("need a path");
    expect(parsed.agents[0]!.question).toBe("which file should I edit?");
    expect(parsed.agents[0]!.question_id).toBe("ask-1");
    expect(list.definition.description).toContain("question_id");
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

describe("spawn_agent dispatch contracts", () => {
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
    expect(captured[0]!.tier).toBe("nested-orchestrator");
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
    expect(captured[0]!.tier).toBe("nested-orchestrator");
  });

  const FAIL_CLOSED_CRITERIA =
    "Error: spawn_agent requires non-empty success_criteria for implement/review dispatches (and their default directors).";

  const pluginReviewer = {
    id: "plugin-reviewer",
    capabilities: { mode: "allow" as const, tools: ["read_file"] },
    systemPromptRole: "You are the plugin reviewer.",
  };

  interface DispatchContractCase {
    name: string;
    args: Record<string, unknown>;
    outcome: "error" | "running";
    spawnAllowlist?: string[];
    profiles?: NonNullable<AgentFleetDeps["profiles"]>;
  }

  test.each<DispatchContractCase>([
    {
      name: "intent=implement without success_criteria",
      args: { description: "build", prompt: "ship it", intent: "implement" },
      outcome: "error" as const,
    },
    {
      name: "intent=review without success_criteria",
      args: { description: "review", prompt: "critique it", intent: "review" },
      outcome: "error" as const,
    },
    {
      name: "default implement director without success_criteria when intent is omitted",
      args: {
        description: "build",
        prompt: "ship it",
        agent: INTENT_DEFAULT_DIRECTOR.implement,
      },
      outcome: "error" as const,
    },
    {
      name: "default review director without success_criteria",
      args: {
        description: "review",
        prompt: "critique it",
        agent: INTENT_DEFAULT_DIRECTOR.review,
      },
      outcome: "error" as const,
    },
    {
      name: "intent=explore without success_criteria",
      args: { description: "look", prompt: "find it", intent: "explore" },
      outcome: "running" as const,
    },
    {
      name: "agent=intern without success_criteria",
      args: { description: "chore", prompt: "run it", agent: "intern" },
      outcome: "running" as const,
    },
    {
      name: "agent=greybeard without intent and without success_criteria",
      args: { description: "arch", prompt: "judge this", agent: "greybeard" },
      outcome: "running" as const,
    },
    {
      name: "implement with non-empty success_criteria",
      args: {
        description: "build",
        prompt: "ship it",
        intent: "implement",
        success_criteria: ["typecheck green"],
      },
      outcome: "running" as const,
    },
    {
      name: "whitespace-only success_criteria for implement",
      args: {
        description: "build",
        prompt: "ship it",
        intent: "implement",
        success_criteria: ["  ", ""],
      },
      outcome: "error" as const,
    },
    {
      name: "default implement director with intent=explore without success_criteria",
      args: {
        description: "build",
        prompt: "ship it",
        agent: INTENT_DEFAULT_DIRECTOR.implement,
        intent: "explore",
      },
      outcome: "error" as const,
    },
    {
      name: "intent=implement with agent=explorer without success_criteria",
      args: {
        description: "look",
        prompt: "find it",
        agent: "explorer",
        intent: "implement",
      },
      outcome: "error" as const,
    },
    {
      name: "intent=review with agent=explorer without success_criteria",
      args: {
        description: "look",
        prompt: "find it",
        agent: "explorer",
        intent: "review",
      },
      outcome: "error" as const,
    },
    {
      name: "plugin profile with intent=implement without success_criteria",
      args: {
        description: "profile job",
        prompt: "do it",
        agent: "plugin-reviewer",
        intent: "implement",
      },
      outcome: "error" as const,
      profiles: [pluginReviewer],
    },
    {
      name: "plugin profile with intent=review without success_criteria",
      args: {
        description: "profile job",
        prompt: "do it",
        agent: "plugin-reviewer",
        intent: "review",
      },
      outcome: "error" as const,
      profiles: [pluginReviewer],
    },
    {
      name: "intent=review with non-empty success_criteria",
      args: {
        description: "review",
        prompt: "critique it",
        intent: "review",
        success_criteria: ["find defects"],
      },
      outcome: "running" as const,
    },
    {
      name: "allowlisted default review director without success_criteria is criteria error",
      args: {
        description: "review",
        prompt: "critique it",
        agent: INTENT_DEFAULT_DIRECTOR.review,
      },
      outcome: "error" as const,
      spawnAllowlist: ["intern", "explorer", INTENT_DEFAULT_DIRECTOR.review],
    },
    {
      name: "intent=plan without success_criteria",
      args: { description: "plan", prompt: "outline it", intent: "plan" },
      outcome: "running" as const,
    },
  ])("dispatch contract: $name", async (row) => {
    const deps = makeDeps(
      async () => ({ report: "ok" }),
      row.profiles !== undefined ? { profiles: row.profiles } : {},
    );
    if (row.spawnAllowlist !== undefined) {
      deps.spawnAllowlist = row.spawnAllowlist;
    }
    const spawn = createSpawnAgentTool(deps);
    if (row.outcome === "error") {
      const raw = await callToolRaw(spawn, row.args);
      expect(raw.isError).toBe(true);
      expect(raw.content).toBe(FAIL_CLOSED_CRITERIA);
      expect(raw.content).not.toContain("allowlist");
      return;
    }
    const result = await callTool(spawn, row.args);
    expect(result.status).toBe("running");
  });
});

describe("ask_director wait handshake", () => {
  function readyHandles(): {
    close: (deadlineMs?: number) => Promise<void>;
    interrupt: () => void;
    followup: (message: string) => Promise<string>;
    deliver: (message: string) => void;
  } {
    return {
      close: async () => {},
      interrupt: () => {},
      followup: async () => "",
      deliver: () => {
        throw new Error("soft send_input must not deliver while an ask is pending");
      },
    };
  }

  test("wait returns awaiting_director with question; re-wait same question_id; after resolve, running then done", async () => {
    const gate = deferred<RunSubAgentResult>();
    let answerP: Promise<string> | undefined;
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.(readyHandles());
      answerP = params.askDirectorPort?.register({
        question: "which file should I edit?",
        questionId: "ask-1",
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
      description: "need a path",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    const waited = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(waited.timed_out).toBe(false);
    const first = (waited.results as Record<string, unknown>[])[0]!;
    expect(first.status).toBe("awaiting_director");
    expect(first.question).toBe("which file should I edit?");
    expect(first.question_id).toBe("ask-1");
    expect(first.description).toBe("need a path");
    expect(deps.fleetRecords.peek(id)?.collected).not.toBe(true);

    const rewait = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(rewait.timed_out).toBe(false);
    const again = (rewait.results as Record<string, unknown>[])[0]!;
    expect(again.status).toBe("awaiting_director");
    expect(again.question_id).toBe("ask-1");

    await callTool(sendInput, { target: id, message: "edit src/foo.ts" });
    expect(await answerP).toBe("edit src/foo.ts");

    const after = await callTool(wait, { targets: [id], timeout_ms: 50 });
    expect(after.timed_out).toBe(true);
    expect((after.results as { status: string }[])[0]!.status).toBe("running");

    gate.resolve({ report: "done" });
    const done = await callTool(wait, { targets: [id], timeout_ms: 5000 });
    expect(done.timed_out).toBe(false);
    expect((done.results as { status: string }[])[0]!.status).toBe("done");
  });

  test("mode=all unblocks on any ask", async () => {
    const firstGate = deferred<RunSubAgentResult>();
    const secondGate = deferred<RunSubAgentResult>();
    let n = 0;
    const deps = makeDeps(async (params) => {
      n += 1;
      params.onAgentReady?.({
        close: async () => {},
        interrupt: () => {},
        followup: async () => "",
        deliver: () => {},
      });
      if (n === 1) {
        void params.askDirectorPort
          ?.register({
            question: "which file?",
            questionId: "ask-1",
          })
          .catch(() => {
            // Session settlement rejects an unanswered ask; this test does not await it.
          });
        return firstGate.promise;
      }
      return secondGate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const asking = await callTool(spawn, {
      description: "asking",
      prompt: "do it",
      intent: "explore",
    });
    const running = await callTool(spawn, {
      description: "running",
      prompt: "do it",
      intent: "explore",
    });
    const waited = await callTool(wait, {
      targets: [asking.agent_id, running.agent_id],
      mode: "all",
      timeout_ms: 5000,
    });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string }[];
    expect(results.find((r) => r.agent_id === asking.agent_id)?.status).toBe("awaiting_director");
    expect(results.find((r) => r.agent_id === running.agent_id)?.status).toBe("running");
    firstGate.resolve({ report: "a" });
    secondGate.resolve({ report: "b" });
  });

  test("isPayload/tombstone does not eat asking workers", () => {
    const sessions = createSubAgentSessionStore();
    const mailbox = createFleetMailbox(sessions);
    for (let i = 0; i < MAX_FLEET_RECORDS; i++) {
      const id = `done-${i}`;
      sessions.start({ id, description: `d${i}`, agentId: "a", brief: "b" });
      sessions.complete(id, "report");
      mailbox.register(id);
    }
    sessions.start({ id: "asking", description: "need answer", agentId: "a", brief: "b" });
    sessions.markRunning("asking");
    mailbox.register("asking");
    expect(
      sessions.registerAsk("asking", {
        question: "which file?",
        questionId: "ask-1",
        resolve: () => {},
        reject: () => {},
      }),
    ).toBe(true);
    sessions.start({ id: "extra", description: "e", agentId: "a", brief: "b" });
    sessions.complete("extra", "extra");
    mailbox.register("extra");

    const snap = mailbox.peek("asking");
    expect(snap?.status).toBe("awaiting_director");
    expect(snap?.tombstoned).not.toBe(true);
    expect(snap?.question).toBe("which file?");
    expect(snap?.questionId).toBe("ask-1");
  });

  test("hasUncollectedTerminal is false for a session with a pending ask", () => {
    const sessions = createSubAgentSessionStore();
    const mailbox = createFleetMailbox(sessions);
    sessions.start({ id: "asking", description: "need answer", agentId: "a", brief: "b" });
    sessions.markRunning("asking");
    mailbox.register("asking");
    expect(
      sessions.registerAsk("asking", {
        question: "which file?",
        questionId: "ask-1",
        resolve: () => {},
        reject: () => {},
      }),
    ).toBe(true);
    expect(mailbox.peek("asking")?.status).toBe("awaiting_director");
    expect(mailbox.hasUncollectedTerminal("asking")).toBe(false);
  });

  test("registerAsk failure rejects the constructed Promise without a cap slot", async () => {
    const gate = deferred<RunSubAgentResult>();
    let port: RunSubAgentParams["askDirectorPort"];
    const deps = makeDeps(async (params) => {
      params.onAgentReady?.(readyHandles());
      port = params.askDirectorPort;
      return gate.promise;
    });
    const spawn = createSpawnAgentTool(deps);
    const spawned = await callTool(spawn, {
      description: "need a path",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(port).toBeDefined();
    deps.sessions.complete(id, "done");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => port!.register({ question: "late?", questionId: "ask-1" })).toThrow(
        "could not register",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      gate.resolve({ report: "done" });
    }
  });
});

describe("admission queue", () => {
  test("20 concurrent spawns admit or queue without error", async () => {
    const gate = deferred<RunSubAgentResult>();
    let started = 0;
    const deps = makeDeps(async () => {
      started += 1;
      return gate.promise;
    });
    deps.admission = createAdmissionQueue({ capacity: 2 });
    const spawn = createSpawnAgentTool(deps);
    const results: { agent_id: string; status: string }[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await callTool(spawn, {
        description: `job-${i}`,
        prompt: "do it",
        intent: "explore",
      });
      results.push({ agent_id: result.agent_id as string, status: result.status as string });
    }
    expect(results).toHaveLength(20);
    expect(results.every((r) => typeof r.agent_id === "string" && r.agent_id.length > 0)).toBe(
      true,
    );
    expect(results.filter((r) => r.status === "running")).toHaveLength(2);
    expect(results.filter((r) => r.status === "queued")).toHaveLength(18);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);

    const list = createListAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    if (list.kind !== "full") throw new Error("expected full tool");
    const raw = await list.handler(
      { id: "list-q", name: "list_agents", arguments: {} },
      new AbortController().signal,
    );
    const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content);
    const parsed = JSON.parse(content) as { agents: { status: string }[] };
    expect(parsed.agents.filter((a) => a.status === "queued")).toHaveLength(18);
    expect(parsed.agents.filter((a) => a.status === "running")).toHaveLength(2);

    const queuedId = results.find((r) => r.status === "queued")!.agent_id;
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const waited = await callTool(wait, { targets: [queuedId], timeout_ms: 50 });
    expect(waited.timed_out).toBe(true);
    const waitResults = waited.results as { agent_id: string; status: string }[];
    expect(waitResults).toEqual([{ agent_id: queuedId, status: "queued" }]);

    gate.resolve({ report: "ok" });
    await Promise.all(
      results.map((r) => waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, r.agent_id)),
    );
  });

  test("nested children bypass a full window", async () => {
    let started = 0;
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => {
      started += 1;
      return gate.promise;
    });
    deps.admission = createAdmissionQueue({ capacity: 0 });
    deps.parentSessionId = "parent-1";
    const spawn = createSpawnAgentTool(deps);
    const result = await callTool(spawn, {
      description: "nested",
      prompt: "do it",
      intent: "explore",
    });
    expect(result.status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    gate.resolve({ report: "ok" });
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, result.agent_id as string);
  });

  test("close_agent of a queued spawn does not start the run", async () => {
    const gate = deferred<RunSubAgentResult>();
    let started = 0;
    const deps = makeDeps(async () => {
      started += 1;
      return gate.promise;
    });
    deps.admission = createAdmissionQueue({ capacity: 1 });
    const spawn = createSpawnAgentTool(deps);
    const first = await callTool(spawn, {
      description: "holder",
      prompt: "hold",
      intent: "explore",
    });
    const queued = await callTool(spawn, {
      description: "queued",
      prompt: "wait",
      intent: "explore",
    });
    expect(first.status).toBe("running");
    expect(queued.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);

    const close = createCloseAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    if (close.kind !== "full") throw new Error("expected full tool");
    await close.handler(
      { id: "close-q", name: "close_agent", arguments: { target: queued.agent_id } },
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    expect(deps.sessions.get(queued.agent_id as string)?.lifecycleStatus).toBe("shutdown");
    expect(deps.fleetRecords.peek(queued.agent_id as string)?.status).toBe("interrupted");

    gate.resolve({ report: "ok" });
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, first.agent_id as string);
  });

  test("interrupt_agent of a queued spawn does not start the run", async () => {
    const gate = deferred<RunSubAgentResult>();
    let started = 0;
    const deps = makeDeps(async () => {
      started += 1;
      return gate.promise;
    });
    deps.admission = createAdmissionQueue({ capacity: 1 });
    const spawn = createSpawnAgentTool(deps);
    const first = await callTool(spawn, {
      description: "holder",
      prompt: "hold",
      intent: "explore",
    });
    const queued = await callTool(spawn, {
      description: "queued",
      prompt: "wait",
      intent: "explore",
    });
    expect(first.status).toBe("running");
    expect(queued.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);

    const interrupt = createInterruptAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    if (interrupt.kind !== "full") throw new Error("expected full tool");
    await interrupt.handler(
      { id: "int-q", name: "interrupt_agent", arguments: { target: queued.agent_id } },
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    expect(deps.sessions.get(queued.agent_id as string)?.lifecycleStatus).toBe("interrupted");
    expect(deps.fleetRecords.peek(queued.agent_id as string)?.status).toBe("interrupted");

    gate.resolve({ report: "ok" });
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, first.agent_id as string);
  });

  test("interrupt_agent of an admitted spawn without a handle does not start leftover work", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = makeDeps(async () => gate.promise);
    const spawn = createSpawnAgentTool(deps);
    const result = await callTool(spawn, {
      description: "job",
      prompt: "do it",
      intent: "explore",
    });
    expect(result.status).toBe("running");
    expect(deps.sessions.get(result.agent_id as string)?.lifecycleStatus).toBe("pending_init");

    const interrupt = createInterruptAgentTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    if (interrupt.kind !== "full") throw new Error("expected full tool");
    const raw = await interrupt.handler(
      { id: "int-setup", name: "interrupt_agent", arguments: { target: result.agent_id } },
      new AbortController().signal,
    );
    expect(raw.content).toContain('"status":"interrupted"');
    expect(deps.sessions.get(result.agent_id as string)?.lifecycleStatus).toBe("interrupted");
    expect(deps.fleetRecords.peek(result.agent_id as string)?.status).toBe("interrupted");
    gate.resolve({ report: "ok" });
  });

  test("sessions.cancel of a queued spawn makes wait_agents report interrupted, not queued", async () => {
    const gate = deferred<RunSubAgentResult>();
    let started = 0;
    const deps = makeDeps(async () => {
      started += 1;
      return gate.promise;
    });
    deps.admission = createAdmissionQueue({ capacity: 1 });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const first = await callTool(spawn, {
      description: "holder",
      prompt: "hold",
      intent: "explore",
    });
    const queued = await callTool(spawn, {
      description: "queued",
      prompt: "wait",
      intent: "explore",
    });
    expect(first.status).toBe("running");
    expect(queued.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(1);
    const queuedId = queued.agent_id as string;

    const startedAt = Date.now();
    expect(deps.sessions.cancel(queuedId)).toBe(true);
    const waited = await callTool(wait, { targets: [queuedId], timeout_ms: 200 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(200);
    expect(waited.timed_out).toBe(false);
    const results = waited.results as { agent_id: string; status: string }[];
    expect(results).toEqual([{ agent_id: queuedId, status: "interrupted" }]);
    expect(started).toBe(1);

    gate.resolve({ report: "ok" });
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, first.agent_id as string);
  });

  test("start() threads fleet admission onto RunSubAgentParams", async () => {
    let captured: RunSubAgentParams | undefined;
    const deps = makeDeps(async (params) => {
      captured = params;
      return { report: "ok" };
    });
    const spawn = createSpawnAgentTool(deps);
    const result = await callTool(spawn, {
      description: "job",
      prompt: "do it",
      intent: "explore",
    });
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, result.agent_id as string);
    expect(captured?.admission).toBe(deps.admission);
  });

  test("lowering capacity does not cancel in-flight work", async () => {
    const gate = deferred<RunSubAgentResult>();
    let started = 0;
    const admission = createAdmissionQueue({ capacity: 2 });
    const deps = makeDeps(async () => {
      started += 1;
      return gate.promise;
    });
    deps.admission = admission;
    const spawn = createSpawnAgentTool(deps);
    const a = await callTool(spawn, { description: "a", prompt: "do it", intent: "explore" });
    const b = await callTool(spawn, { description: "b", prompt: "do it", intent: "explore" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);
    admission.setCapacity(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);
    expect(deps.sessions.get(a.agent_id as string)?.status).toBe("running");
    expect(deps.sessions.get(b.agent_id as string)?.status).toBe("running");
    gate.resolve({ report: "ok" });
    await Promise.all([
      waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, a.agent_id as string),
      waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, b.agent_id as string),
    ]);
  });
});
