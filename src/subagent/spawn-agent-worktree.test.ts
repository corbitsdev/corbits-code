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
    const tool = createSpawnAgentTool({
      permissionGate: testPermissionGate,
      cwd: notARepo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async () => {
        ran = true;
        return { report: "no" };
      },
      sessions: createSubAgentSessionStore(),
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
      interrupted: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(workerCwd).toBeDefined();
    expect(await pathExists(workerCwd!)).toBe(false);
  });
});
