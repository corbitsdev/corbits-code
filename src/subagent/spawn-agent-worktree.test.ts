import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSpawnAgentTool, type AgentFleetDeps } from "./agent-fleet.js";
import { isLiveWaitStatus, projectWaitStatus } from "./lifecycle.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";
import type { Telemetry } from "../telemetry/index.js";
import { initTemporaryGitRepo } from "../testkit/temporary-git-repo.js";
import { defined } from "../testkit/defined.js";
import {
  callFleetToolRaw,
  createFleetDeps,
  deferred,
  spawnAgentId,
} from "./fleet-test-harness.js";
import { pollUntil } from "./run-test-harness.js";

const run = promisify(execFile);

function telemetryCapture() {
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    installationId: "test",
    capture: (event, properties = {}) => events.push({ event, properties }),
    captureIntentional: () => false,
    flush: async () => undefined,
    discard: () => undefined,
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

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await tempDir("corbits-spawn-wt-");
  initTemporaryGitRepo(dir);
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

function worktreeDeps(
  runWorker: (params: RunSubAgentParams) => Promise<RunSubAgentResult>,
  opts: {
    cwd: string;
    workdirBase: string;
    telemetry?: Telemetry;
    useWorktree?: boolean;
  },
): AgentFleetDeps {
  const deps = createFleetDeps(runWorker, { cwd: opts.cwd });
  deps.getWorkdirBase = () => opts.workdirBase;
  if (opts.useWorktree === true) deps.useWorktree = true;
  if (opts.telemetry !== undefined) deps.telemetry = opts.telemetry;
  return deps;
}

function spawnWorker(deps: AgentFleetDeps, description: string) {
  return callFleetToolRaw(createSpawnAgentTool(deps), {
    description,
    prompt: "Do the work",
    intent: "explore",
  });
}

function spawnWorkerId(deps: AgentFleetDeps, description: string) {
  return spawnAgentId(createSpawnAgentTool(deps), {
    description,
    prompt: "Do the work",
    intent: "explore",
  });
}

const readyHandles = {
  close: async () => undefined,
  interrupt: () => undefined,
  followup: async () => "",
  deliver: () => undefined,
};

async function expectWorktreeReclaimed(
  sessions: AgentFleetDeps["sessions"],
  agentId: string,
  workerCwd: string | undefined,
): Promise<void> {
  expect(workerCwd).toBeDefined();
  expect(await pathExists(defined(workerCwd))).toBe(true);

  await sessions.closeOne(agentId, 1000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await pathExists(defined(workerCwd))).toBe(false);
}

describe("spawn_agent worktree isolation", () => {
  test("propagates a fresh worktree path as the worker cwd", async () => {
    const repo = await makeRepo();
    const workdirBase = await tempDir("corbits-workdir-");

    let captured: RunSubAgentParams | undefined;
    const deps = worktreeDeps(
      async (params) => {
        captured = params;
        return { report: "done" };
      },
      { cwd: repo, workdirBase, useWorktree: true },
    );
    const result = await spawnWorker(deps, "Isolated job");
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("running");
    await pollUntil(() => captured?.cwd !== undefined);
    expect(captured?.cwd).toBeDefined();
    expect(captured?.cwd).not.toBe(repo);
    expect(captured?.cwd?.startsWith(workdirBase)).toBe(true);
  });

  test("fails closed when the dispatcher cwd is not a git repository", async () => {
    const notARepo = await tempDir("corbits-not-a-repo-");
    const workdirBase = await tempDir("corbits-workdir-");

    let ran = false;
    const { telemetry, events } = telemetryCapture();
    const deps = worktreeDeps(
      async () => {
        ran = true;
        return { report: "no" };
      },
      { cwd: notARepo, workdirBase, telemetry, useWorktree: true },
    );
    const result = await spawnWorker(deps, "bad");
    expect(result.isError).not.toBe(true);
    await pollUntil(() => deps.sessions.list()[0]?.status === "failed");
    expect(ran).toBe(false);
    expect(deps.sessions.list()).toHaveLength(1);
    expect(deps.sessions.list()[0]?.status).toBe("failed");
    expect(
      events.filter((event) => event.event === "subagent_start"),
    ).toHaveLength(1);
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
    const { telemetry, events } = telemetryCapture();
    const deps = worktreeDeps(
      async (params) => {
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
      { cwd: repo, workdirBase: repo, telemetry },
    );
    const result = await spawnWorker(deps, "cancelled");

    expect(result.isError).not.toBe(true);
    await pollUntil(() =>
      events.some((event) => event.event === "subagent_end"),
    );
    expect(deps.sessions.list()[0]?.status).toBe("cancelled");
    expect(
      events.filter((event) => event.event === "subagent_start"),
    ).toHaveLength(1);
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
  });

  test("defers worktree cleanup while the session is retained for followup", async () => {
    const repo = await makeRepo();
    const workdirBase = await tempDir("corbits-workdir-");

    const settle = deferred<RunSubAgentResult>();
    let workerCwd: string | undefined;
    const deps = worktreeDeps(
      async (params) => {
        workerCwd = params.cwd;
        params.onAgentReady?.(readyHandles);
        return settle.promise;
      },
      { cwd: repo, workdirBase, useWorktree: true },
    );
    const agentId = await spawnWorkerId(deps, "keep alive");

    settle.resolve({ report: "## Summary\nDone.", agentRetained: true });
    await pollUntil(() => workerCwd !== undefined);

    await expectWorktreeReclaimed(deps.sessions, agentId, workerCwd);
  });

  test("defers worktree cleanup while the session is interrupted for followup", async () => {
    const repo = await makeRepo();
    const workdirBase = await tempDir("corbits-workdir-");

    const settle = deferred<RunSubAgentResult>();
    let workerCwd: string | undefined;
    let settlementCount = 0;
    let settlementWasFrozen = false;
    const { telemetry, events } = telemetryCapture();
    const deps = worktreeDeps(
      async (params) => {
        workerCwd = params.cwd;
        params.onAgentReady?.(readyHandles);
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
          terminal_reason: "interrupted" as const,
        });
        settlementCount += 1;
        settlementWasFrozen = Object.isFrozen(summary);
        params.onRunSettled?.(summary);
        return result;
      },
      { cwd: repo, workdirBase, telemetry, useWorktree: true },
    );
    const agentId = await spawnWorkerId(deps, "interrupt me");

    await pollUntil(
      () => deps.sessions.get(agentId)?.lifecycleStatus === "running",
    );
    expect(deps.sessions.interruptOne(agentId).ok).toBe(true);
    settle.resolve({
      report:
        "## Summary\nStopped.\n## Findings\npartial\n## Blockers\ninterrupted\n## Paths\n",
      stopReason: "interrupted",
      interrupted: true,
    });
    await pollUntil(() =>
      events.some((event) => event.event === "subagent_end"),
    );

    expect(settlementCount).toBe(1);
    expect(settlementWasFrozen).toBe(true);
    expect(deps.sessions.get(agentId)?.lifecycleStatus).toBe("interrupted");
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({
      status: "interrupted",
      stop_reason: "interrupted",
    });
    await expectWorktreeReclaimed(deps.sessions, agentId, workerCwd);
  });

  test("reclaims the worktree immediately when the agent is not retained", async () => {
    const repo = await makeRepo();
    const workdirBase = await tempDir("corbits-workdir-");

    let workerCwd: string | undefined;
    const deps = worktreeDeps(
      async (params) => {
        workerCwd = params.cwd;
        // Salvage / non-persist path: no agentRetained flag.
        return { report: "## Summary\nSalvaged." };
      },
      { cwd: repo, workdirBase, useWorktree: true },
    );
    await spawnWorker(deps, "one shot");
    await pollUntil(() => workerCwd !== undefined);
    const completedWorkerCwd = defined(workerCwd);
    await pollUntil(async () => !(await pathExists(completedWorkerCwd)));

    expect(await pathExists(completedWorkerCwd)).toBe(false);
  });

  test("interrupt during worktree setup settles the run instead of stranding it", async () => {
    const repo = await makeRepo();
    const workdirBase = await tempDir("corbits-workdir-");

    let started = 0;
    const { telemetry, events } = telemetryCapture();
    const deps = worktreeDeps(
      async () => {
        started += 1;
        return { report: "ok" };
      },
      { cwd: repo, workdirBase, telemetry, useWorktree: true },
    );
    const { sessions, fleetRecords: mailbox } = deps;
    const agentId = await spawnWorkerId(deps, "interrupted setup");

    // CL-7787: the fleet admitted the spawn and marked a run in flight, then
    // suspended on worktree creation — the interrupt lands in exactly that
    // window, before any run handle exists.
    expect(sessions.isRunInFlight(agentId)).toBe(true);
    expect(sessions.interruptOne(agentId).ok).toBe(true);

    // Once the worktree resolves, the stranded run must settle through the
    // normal terminal path: wait status leaves "running", the fleet goes dry
    // so mail drives fire, and run() never starts leftover work.
    await pollUntil(
      () =>
        mailbox.peek(agentId) !== undefined &&
        !isLiveWaitStatus(defined(mailbox.peek(agentId)).status),
    );
    expect(started).toBe(0);
    expect(sessions.isRunInFlight(agentId)).toBe(false);
    const snap = defined(sessions.get(agentId));
    expect(snap.lifecycleStatus).toBe("interrupted");
    expect(
      projectWaitStatus(snap.lifecycle, sessions.isRunInFlight(agentId)),
    ).toBe("interrupted");
    expect(mailbox.peek(agentId)?.status).toBe("interrupted");
    // The fleet is dry: no session projects a live wait status, so mail
    // drives fire.
    expect(
      sessions
        .list()
        .every(
          (s) =>
            !isLiveWaitStatus(
              projectWaitStatus(s.lifecycle, s.runInFlight === true),
            ),
        ),
    ).toBe(true);
    await pollUntil(() =>
      events.some((event) => event.event === "subagent_end"),
    );
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({ status: "interrupted" });
  });
});
