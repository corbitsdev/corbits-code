import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createFleetRecords, createSpawnAgentTool } from "./agent-fleet.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createPermissionGate } from "../permission/gate.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";
import type { Telemetry } from "../telemetry/index.js";

const run = promisify(execFile);

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

function telemetryCapture() {
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    installationId: "test",
    capture: (event, properties = {}) => events.push({ event, properties }),
    captureIntentional: () => false,
    flush: async () => {},
    discard: () => {},
  };
  return { telemetry, events };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-spawn-wt-"));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "seed.txt"), "seed");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("spawn_agent worktree isolation", () => {
  test("propagates a fresh worktree path as the worker cwd", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let captured: RunSubAgentParams | undefined;
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
      sessions: createSubAgentSessionStore(),
      fleetRecords: createFleetRecords(),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");
    const result = await tool.handler(
      {
        id: "c1",
        name: "spawn_agent",
        arguments: { description: "Isolated job", prompt: "Do the work", intent: "explore" },
      },
      new AbortController().signal,
    );
    expect(typeof result.content === "string" ? result.content : "").toContain("running");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(captured?.cwd).toBeDefined();
    expect(captured?.cwd).not.toBe(repo);
    expect(captured?.cwd?.startsWith(workdirBase)).toBe(true);
  });

  test("fails closed when the dispatcher cwd is not a git repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "corbits-not-a-repo-"));
    tempDirs.push(notARepo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let ran = false;
    const { telemetry, events } = telemetryCapture();
    const sessions = createSubAgentSessionStore();
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: notARepo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      telemetry,
      run: async () => {
        ran = true;
        return { report: "no" };
      },
      sessions,
      fleetRecords: createFleetRecords(),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");
    const result = await tool.handler(
      {
        id: "c2",
        name: "spawn_agent",
        arguments: { description: "bad", prompt: "Do the work", intent: "explore" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(ran).toBe(false);
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]?.status).toBe("failed");
    expect(events.filter((event) => event.event === "subagent_start")).toHaveLength(1);
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({
      status: "failed",
      stop_reason: "setup_error",
      model: "test-model",
      turn_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      tool_call_count: 0,
      tool_error_count: 0,
    });
    expect(typeof ends[0]?.properties.duration_ms).toBe("number");
  });

  test("pairs pre-progress cancellation with a cancelled terminal event", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const { telemetry, events } = telemetryCapture();
    const sessions = createSubAgentSessionStore();
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => repo,
      provider,
      telemetry,
      run: async (params) => {
        params.onRunSettled?.({
          turn_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          tool_call_count: 0,
          tool_error_count: 0,
          error_count: 1,
          duration_ms: 1,
          model: "test-model",
          terminal_reason: "cancelled",
        });
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
      sessions,
      fleetRecords: createFleetRecords(),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      {
        id: "cancelled-spawn",
        name: "spawn_agent",
        arguments: { description: "cancelled", prompt: "Do the work", intent: "explore" },
      },
      new AbortController().signal,
    );

    expect(result.isError).not.toBe(true);
    await waitFor(() => events.some((event) => event.event === "subagent_end"));
    expect(sessions.list()[0]?.status).toBe("cancelled");
    expect(events.filter((event) => event.event === "subagent_start")).toHaveLength(1);
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
  });

  test("defers worktree cleanup while the session is retained for followup", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    const settle = deferred<RunSubAgentResult>();
    let workerCwd: string | undefined;
    const sessions = createSubAgentSessionStore();
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async (params) => {
        workerCwd = params.cwd;
        params.onAgentReady?.({
          close: async () => {},
          interrupt: () => {},
          followup: async () => "",
          deliver: () => {},
        });
        return settle.promise;
      },
      sessions,
      fleetRecords: createFleetRecords(),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");
    const spawned = await tool.handler(
      {
        id: "retain-wt",
        name: "spawn_agent",
        arguments: { description: "keep alive", prompt: "Do the work", intent: "explore" },
      },
      new AbortController().signal,
    );
    const content = typeof spawned.content === "string" ? spawned.content : "";
    const agentId = (JSON.parse(content) as { agent_id: string }).agent_id;

    settle.resolve({ report: "## Summary\nDone.", agentRetained: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(workerCwd).toBeDefined();
    expect(await pathExists(workerCwd!)).toBe(true);

    await sessions.closeOne(agentId, 1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await pathExists(workerCwd!)).toBe(false);
  });

  test("defers worktree cleanup while the session is interrupted for followup", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    const settle = deferred<RunSubAgentResult>();
    let workerCwd: string | undefined;
    let settlementCount = 0;
    let settlementWasFrozen = false;
    const { telemetry, events } = telemetryCapture();
    const sessions = createSubAgentSessionStore();
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      telemetry,
      run: async (params) => {
        workerCwd = params.cwd;
        params.onAgentReady?.({
          close: async () => {},
          interrupt: () => {},
          followup: async () => "",
          deliver: () => {},
        });
        const result = await settle.promise;
        const summary = Object.freeze({
          turn_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          tool_call_count: 0,
          tool_error_count: 0,
          error_count: 0,
          duration_ms: 1,
          model: "test-model",
          terminal_reason: "cancelled" as const,
        });
        settlementCount += 1;
        settlementWasFrozen = Object.isFrozen(summary);
        params.onRunSettled?.(summary);
        return result;
      },
      sessions,
      fleetRecords: createFleetRecords(),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");
    const spawned = await tool.handler(
      {
        id: "interrupt-wt",
        name: "spawn_agent",
        arguments: { description: "interrupt me", prompt: "Do the work", intent: "explore" },
      },
      new AbortController().signal,
    );
    const content = typeof spawned.content === "string" ? spawned.content : "";
    const agentId = (JSON.parse(content) as { agent_id: string }).agent_id;

    settle.resolve({
      report: "## Summary\nStopped.\n## Findings\npartial\n## Blockers\ninterrupted\n## Paths\n",
      stopReason: "cancelled",
      interrupted: true,
    });
    await waitFor(() => events.some((event) => event.event === "subagent_end"));

    expect(settlementCount).toBe(1);
    expect(settlementWasFrozen).toBe(true);
    expect(sessions.get(agentId)?.lifecycleStatus).toBe("interrupted");
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({
      status: "interrupted",
      stop_reason: "cancelled",
    });
    expect(workerCwd).toBeDefined();
    expect(await pathExists(workerCwd!)).toBe(true);

    await sessions.closeOne(agentId, 1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await pathExists(workerCwd!)).toBe(false);
  });

  test("reclaims the worktree immediately when the agent is not retained", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let workerCwd: string | undefined;
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async (params) => {
        workerCwd = params.cwd;
        // Salvage / non-persist path: no agentRetained flag.
        return { report: "## Summary\nSalvaged." };
      },
      sessions: createSubAgentSessionStore(),
      fleetRecords: createFleetRecords(),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");
    await tool.handler(
      {
        id: "no-retain-wt",
        name: "spawn_agent",
        arguments: { description: "one shot", prompt: "Do the work", intent: "explore" },
      },
      new AbortController().signal,
    );
    await waitFor(() => workerCwd !== undefined);
    if (workerCwd === undefined) throw new Error("worker cwd was not captured");
    const completedWorkerCwd = workerCwd;
    await waitFor(async () => !(await pathExists(completedWorkerCwd)));

    expect(await pathExists(completedWorkerCwd)).toBe(false);
  });
});
