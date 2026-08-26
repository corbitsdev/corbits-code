import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTaskTool } from "./task-tool.js";
import type { RunSubAgentParams } from "./types.js";
import { createPermissionGate } from "../permission/gate.js";
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

async function callTask(
  tool: ReturnType<typeof createTaskTool>,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    { id: "call-1", name: "task", arguments: args },
    new AbortController().signal,
  );
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-worktree-"));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "seed.txt"), "seed");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createTaskTool worktree isolation", () => {
  test("propagates a fresh worktree path as the sub-agent's cwd, cleaned up when unchanged", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });

    const result = await callTask(tool, {
      description: "Isolated job",
      prompt: "Do the work",
      intent: "explore",
    });

    expect(result).toContain("done");
    expect(captured?.cwd).toBeDefined();
    expect(captured?.cwd).not.toBe(repo);
    expect(captured?.cwd?.startsWith(workdirBase)).toBe(true);

    // Unchanged worktree is removed automatically: `git worktree list` no
    // longer reports it as a registered worktree of the repo.
    const { stdout } = await run("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(captured!.cwd);
  });

  test("shares the dispatcher cwd when worktree isolation is not requested", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });

    await callTask(tool, { description: "Shared job", prompt: "Do the work", intent: "explore" });

    expect(captured?.cwd).toBe(repo);
  });

  test("fails closed and never dispatches when the dispatcher cwd is not a git repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "corbits-not-a-repo-"));
    tempDirs.push(notARepo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let ran = false;
    const { telemetry, events } = telemetryCapture();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: notARepo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      telemetry,
      run: async () => {
        ran = true;
        return { report: "done" };
      },
    });

    const result = await callTask(tool, {
      description: "Blocked job",
      prompt: "Do the work",
      intent: "explore",
    });

    expect(result).toContain("Error:");
    expect(result).toContain("not inside a git repository");
    expect(ran).toBe(false);
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
    const tool = createTaskTool({
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
    });

    const result = await callTask(tool, {
      description: "cancelled job",
      prompt: "Do the work",
      intent: "explore",
    });

    expect(result).toContain("cancelled by operator");
    expect(events.filter((event) => event.event === "subagent_start")).toHaveLength(1);
    const ends = events.filter((event) => event.event === "subagent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.properties).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
  });

  test("preserves a worktree the sub-agent left dirty, with a notice in the report", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let worktreePath: string | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async (params) => {
        worktreePath = params.cwd;
        // Simulate the sub-agent leaving uncommitted work behind.
        await writeFile(join(params.cwd, "new-file.txt"), "unfinished work");
        return { report: "done" };
      },
    });

    const result = await callTask(tool, {
      description: "Dirty job",
      prompt: "Do the work",
      intent: "explore",
    });

    expect(result).toContain("done");
    expect(result).toContain("uncommitted changes and was left in place");
    expect(worktreePath).toBeDefined();
    const contents = await readFile(join(worktreePath!, "new-file.txt"), "utf8");
    expect(contents).toBe("unfinished work");

    const { stdout } = await run("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).toContain(worktreePath!);
  });

  test("preserves a worktree the sub-agent left stashed, with a notice naming the stash", async () => {
    const repo = await makeRepo();
    tempDirs.push(repo);
    const workdirBase = await mkdtemp(join(tmpdir(), "corbits-workdir-"));
    tempDirs.push(workdirBase);

    let worktreePath: string | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: repo,
      getWorkdirBase: () => workdirBase,
      provider,
      useWorktree: true,
      run: async (params) => {
        worktreePath = params.cwd;
        // Simulate the sub-agent stashing mid-task: `git status` reports
        // clean afterward even though the work is not actually gone — it is
        // parked in the repo's shared refs/stash.
        await writeFile(join(params.cwd, "wip.txt"), "half-finished change");
        await run("git", ["add", "."], { cwd: params.cwd });
        await run("git", ["stash"], { cwd: params.cwd });
        return { report: "done" };
      },
    });

    const result = await callTask(tool, {
      description: "Stashing job",
      prompt: "Do the work",
      intent: "explore",
    });

    expect(result).toContain("done");
    expect(result).toContain("stash");
    expect(worktreePath).toBeDefined();

    // The worktree itself is preserved rather than silently removed —
    // `git status` alone would have called this clean.
    const { stdout } = await run("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).toContain(worktreePath!);

    // The stash entry the sub-agent created is still recoverable.
    const { stdout: stashList } = await run("git", ["stash", "list"], { cwd: repo });
    expect(stashList).toContain("stash@{0}");
  });
});
