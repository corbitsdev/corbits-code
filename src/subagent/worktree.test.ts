import { describe, expect, test } from "bun:test";

import {
  cleanupSubAgentWorktree,
  createSubAgentWorktree,
  WorktreeError,
  type WorktreeExec,
} from "./worktree.js";

function recordingExec(
  responses: Record<string, { stdout?: string; error?: Error }>,
): { exec: WorktreeExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: WorktreeExec = async (args) => {
    calls.push(args);
    // Prefer a two-arg key so `rev-parse --show-toplevel` and `rev-parse HEAD`
    // can return different fixtures; fall back to the verb alone.
    const key2 = args.slice(0, 2).join(" ");
    const key1 = args[0]!;
    const response = responses[key2] ?? responses[key1];
    if (response?.error !== undefined) throw response.error;
    return { stdout: response?.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("createSubAgentWorktree", () => {
  test("creates a detached worktree at HEAD when repoCwd is a git repo", async () => {
    const { exec, calls } = recordingExec({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      worktree: { stdout: "" },
      "rev-parse HEAD": { stdout: "abc123def456\n" },
      stash: { stdout: "" },
    });
    const result = await createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result.path).toBe("/repo/.worktrees/abc");
    expect(result.stashBaseline).toEqual([]);
    expect(result.headAtCreate).toBe("abc123def456");
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["worktree", "add", "--detach", "/repo/.worktrees/abc", "HEAD"],
      ["rev-parse", "HEAD"],
      ["stash", "list"],
    ]);
  });

  test("captures the current stash list as a baseline", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      worktree: { stdout: "" },
      "rev-parse HEAD": { stdout: "abc123\n" },
      stash: { stdout: "stash@{0}: WIP on main: abc1234 pre-existing stash\n" },
    });
    const result = await createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result.stashBaseline).toEqual(["stash@{0}: WIP on main: abc1234 pre-existing stash"]);
  });

  test("records a null stash baseline when stash list fails at create", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      worktree: { stdout: "" },
      "rev-parse HEAD": { stdout: "abc123\n" },
      stash: { error: new Error("stash failed") },
    });
    const result = await createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result.stashBaseline).toBeNull();
  });

  test("fails closed when repoCwd is not a git repository", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { error: new Error("not a git repository") },
    });
    await expect(createSubAgentWorktree("/not-a-repo", "/tmp/wt", exec)).rejects.toThrow(
      WorktreeError,
    );
  });

  test("fails closed when worktree add fails", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      worktree: { error: new Error("worktree already exists") },
    });
    await expect(createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec)).rejects.toThrow(
      WorktreeError,
    );
  });
});

describe("cleanupSubAgentWorktree", () => {
  test("removes a clean worktree with no new stash entries", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "" },
      stash: { stdout: "" },
      worktree: { stdout: "" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result).toEqual({ status: "removed", path: "/repo/.worktrees/abc" });
    expect(calls).toEqual([
      ["status", "--porcelain", "--ignored"],
      ["stash", "list"],
      ["worktree", "remove", "/repo/.worktrees/abc"],
    ]);
  });

  test("preserves a worktree containing only gitignored output", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "!! dist/output.txt\n" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("uncommitted changes");
    }
    expect(calls.some((call) => call[0] === "worktree")).toBe(false);
  });

  test("preserves a dirty worktree instead of removing it", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: " M src/index.ts\n" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result.status).toBe("preserved");
    expect(result).toMatchObject({ path: "/repo/.worktrees/abc" });
    if (result.status === "preserved") {
      expect(result.notice).toContain("uncommitted changes");
    }
    // Never runs `worktree remove` against a dirty tree.
    expect(calls.some((call) => call[0] === "worktree")).toBe(false);
  });

  test("preserves the worktree when status cannot be checked", async () => {
    const { exec } = recordingExec({
      status: { error: new Error("no such directory") },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result.status).toBe("preserved");
  });

  test("preserves the worktree when removal fails", async () => {
    const { exec } = recordingExec({
      status: { stdout: "" },
      stash: { stdout: "" },
      worktree: { error: new Error("worktree is locked") },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("could not be removed automatically");
    }
  });

  test("preserves a clean worktree that created a new stash entry", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "" },
      stash: { stdout: "stash@{0}: WIP on (no branch): abc1234 sub-agent work\n" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("stash entry");
      expect(result.notice).toContain("stash@{0}");
    }
    expect(calls.some((call) => call[0] === "worktree")).toBe(false);
  });

  test("does not flag a stash entry that predates this worktree", async () => {
    const preexisting = "stash@{0}: WIP on main: abc1234 unrelated older stash";
    const { exec } = recordingExec({
      status: { stdout: "" },
      stash: { stdout: `${preexisting}\n` },
      worktree: { stdout: "" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [preexisting] },
      exec,
    );
    expect(result).toEqual({ status: "removed", path: "/repo/.worktrees/abc" });
  });

  test("preserves when stash list fails at cleanup", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "" },
      stash: { error: new Error("stash list failed") },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [] },
      exec,
    );
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("could not inspect the stash list");
    }
    expect(calls.some((call) => call[0] === "worktree")).toBe(false);
  });

  test("preserves when stash baseline was unknown at create", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: null },
      exec,
    );
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("stash baseline could not be recorded");
    }
    expect(calls.some((call) => call[0] === "worktree")).toBe(false);
  });

  test("preserves when HEAD advanced on a clean detached worktree", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "" },
      "rev-parse HEAD": { stdout: "newcommit99\n" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [], headAtCreate: "oldcommit00" },
      exec,
    );
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("HEAD advanced");
    }
    expect(calls.some((call) => call[0] === "worktree")).toBe(false);
  });

  test("removes when HEAD is unchanged and the tree is clean", async () => {
    const { exec } = recordingExec({
      status: { stdout: "" },
      "rev-parse HEAD": { stdout: "samehead\n" },
      stash: { stdout: "" },
      worktree: { stdout: "" },
    });
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      { stashBaseline: [], headAtCreate: "samehead" },
      exec,
    );
    expect(result).toEqual({ status: "removed", path: "/repo/.worktrees/abc" });
  });
});
