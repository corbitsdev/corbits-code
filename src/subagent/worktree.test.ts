import { describe, expect, test } from "bun:test";

import {
  cleanupSubAgentWorktree,
  createSubAgentWorktree,
  WorktreeError,
  type WorktreeExec,
} from "./worktree.js";
import { defined } from "../../testkit/defined.js";

function recordingExec(
  responses: Record<string, { stdout?: string; error?: Error }>,
): {
  exec: WorktreeExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: WorktreeExec = async (args) => {
    calls.push(args);
    // Prefer a two-arg key so `rev-parse --show-toplevel` and `rev-parse HEAD`
    // can return different fixtures; fall back to the verb alone.
    const key2 = args.slice(0, 2).join(" ");
    const key1 = defined(args[0]);
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
    const result = await createSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      exec,
    );
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
    const result = await createSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      exec,
    );
    expect(result.stashBaseline).toEqual([
      "stash@{0}: WIP on main: abc1234 pre-existing stash",
    ]);
  });

  test("records a null stash baseline when stash list fails at create", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      worktree: { stdout: "" },
      "rev-parse HEAD": { stdout: "abc123\n" },
      stash: { error: new Error("stash failed") },
    });
    const result = await createSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      exec,
    );
    expect(result.stashBaseline).toBeNull();
  });

  test("fails closed when repoCwd is not a git repository", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { error: new Error("not a git repository") },
    });
    await expect(
      createSubAgentWorktree("/not-a-repo", "/tmp/wt", exec),
    ).rejects.toThrow(WorktreeError);
  });

  test("fails closed when worktree add fails", async () => {
    const { exec } = recordingExec({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      worktree: { error: new Error("worktree already exists") },
    });
    await expect(
      createSubAgentWorktree("/repo", "/repo/.worktrees/abc", exec),
    ).rejects.toThrow(WorktreeError);
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

  interface PreserveCase {
    name: string;
    responses: Record<string, { stdout?: string; error?: Error }>;
    stashBaseline: string[] | null;
    headAtCreate?: string;
    notice: string[];
    // Most preserved cases never reach `worktree remove`; the removal-failure
    // case does (and fails), so it opts out of the no-call assertion.
    noWorktreeCall?: boolean;
  }

  test.each<PreserveCase>([
    {
      name: "a worktree containing only gitignored output",
      responses: { status: { stdout: "!! dist/output.txt\n" } },
      stashBaseline: [],
      notice: ["uncommitted changes"],
    },
    {
      name: "a dirty worktree",
      responses: { status: { stdout: " M src/index.ts\n" } },
      stashBaseline: [],
      notice: ["uncommitted changes"],
    },
    {
      name: "status cannot be checked",
      responses: { status: { error: new Error("no such directory") } },
      stashBaseline: [],
      notice: [],
    },
    {
      name: "removal fails",
      responses: {
        status: { stdout: "" },
        stash: { stdout: "" },
        worktree: { error: new Error("worktree is locked") },
      },
      stashBaseline: [],
      notice: ["could not be removed automatically"],
      noWorktreeCall: false,
    },
    {
      name: "a clean worktree created a new stash entry",
      responses: {
        status: { stdout: "" },
        stash: {
          stdout: "stash@{0}: WIP on (no branch): abc1234 sub-agent work\n",
        },
      },
      stashBaseline: [],
      notice: ["stash entry", "stash@{0}"],
    },
    {
      name: "stash list fails at cleanup",
      responses: {
        status: { stdout: "" },
        stash: { error: new Error("stash list failed") },
      },
      stashBaseline: [],
      notice: ["could not inspect the stash list"],
    },
    {
      name: "stash baseline was unknown at create",
      responses: { status: { stdout: "" } },
      stashBaseline: null,
      notice: ["stash baseline could not be recorded"],
    },
    {
      name: "HEAD advanced on a clean detached worktree",
      responses: {
        status: { stdout: "" },
        "rev-parse HEAD": { stdout: "newcommit99\n" },
      },
      stashBaseline: [],
      headAtCreate: "oldcommit00",
      notice: ["HEAD advanced"],
    },
  ])("preserves when $name", async (testCase) => {
    const { exec, calls } = recordingExec(testCase.responses);
    const result = await cleanupSubAgentWorktree(
      "/repo",
      "/repo/.worktrees/abc",
      {
        stashBaseline: testCase.stashBaseline,
        ...(testCase.headAtCreate !== undefined
          ? { headAtCreate: testCase.headAtCreate }
          : {}),
      },
      exec,
    );
    expect(result).toMatchObject({
      status: "preserved",
      path: "/repo/.worktrees/abc",
    });
    if (result.status === "preserved") {
      for (const needle of testCase.notice) {
        expect(result.notice).toContain(needle);
      }
    }
    if (testCase.noWorktreeCall !== false) {
      expect(calls.some((call) => call[0] === "worktree")).toBe(false);
    }
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
