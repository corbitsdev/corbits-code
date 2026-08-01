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
    const key = args[0]!;
    const response = responses[key];
    if (response?.error !== undefined) throw response.error;
    return { stdout: response?.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("createSubAgentWorktree", () => {
  test("creates a detached worktree at HEAD when repoCwd is a git repo", async () => {
    const { exec, calls } = recordingExec({
      "rev-parse": { stdout: "/repo\n" },
      worktree: { stdout: "" },
    });
    const result = await createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result.path).toBe("/repo/.worktrees/abc");
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["worktree", "add", "--detach", "/repo/.worktrees/abc", "HEAD"],
    ]);
  });

  test("fails closed when repoCwd is not a git repository", async () => {
    const { exec } = recordingExec({
      "rev-parse": { error: new Error("not a git repository") },
    });
    await expect(createSubAgentWorktree("/not-a-repo", "/tmp/wt", exec)).rejects.toThrow(
      WorktreeError,
    );
  });

  test("fails closed when worktree add fails", async () => {
    const { exec } = recordingExec({
      "rev-parse": { stdout: "/repo\n" },
      worktree: { error: new Error("worktree already exists") },
    });
    await expect(createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec)).rejects.toThrow(
      WorktreeError,
    );
  });
});

describe("cleanupSubAgentWorktree", () => {
  test("removes a clean worktree", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "" },
      worktree: { stdout: "" },
    });
    const result = await cleanupSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result).toEqual({ status: "removed", path: "/repo/.worktrees/abc" });
    expect(calls).toEqual([
      ["status", "--porcelain", "--ignored"],
      ["worktree", "remove", "/repo/.worktrees/abc"],
    ]);
  });

  test("preserves a worktree containing only gitignored output", async () => {
    const { exec, calls } = recordingExec({
      status: { stdout: "!! dist/output.txt\n" },
    });
    const result = await cleanupSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
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
    const result = await cleanupSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
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
    const result = await cleanupSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result.status).toBe("preserved");
  });

  test("preserves the worktree when removal fails", async () => {
    const { exec } = recordingExec({
      status: { stdout: "" },
      worktree: { error: new Error("worktree is locked") },
    });
    const result = await cleanupSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec);
    expect(result.status).toBe("preserved");
    if (result.status === "preserved") {
      expect(result.notice).toContain("could not be removed automatically");
    }
  });
});
