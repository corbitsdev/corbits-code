import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listWorktreeRoots, listWorktreeRootsSync } from "./worktree-roots.js";

const GIT_FATAL = "fatal: not a git repository";

function captureStderr(): { output: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let wrote = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    wrote += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return {
    output: () => wrote,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

let restoreStderr: (() => void) | undefined;

afterEach(() => {
  restoreStderr?.();
  restoreStderr = undefined;
});

describe("listWorktreeRoots stderr", () => {
  test("listWorktreeRootsSync does not leak git fatal on a non-repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "corbits-nogit-sync-"));
    const cap = captureStderr();
    restoreStderr = cap.restore;
    const roots = listWorktreeRootsSync(dir);
    expect(roots).toEqual([]);
    expect(cap.output()).not.toContain(GIT_FATAL);
  });

  test("listWorktreeRoots does not leak git fatal on a non-repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "corbits-nogit-async-"));
    const cap = captureStderr();
    restoreStderr = cap.restore;
    const roots = await listWorktreeRoots(dir);
    expect(roots).toEqual([]);
    expect(cap.output()).not.toContain(GIT_FATAL);
  });

  test("listWorktreeRootsSync still lists sibling worktrees inside a repo", () => {
    const base = mkdtempSync(join(tmpdir(), "corbits-git-sync-"));
    const repo = join(base, "repo");
    const worktree = join(base, "secondary");
    mkdirSync(repo);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-b", "main");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    );
    git("worktree", "add", worktree);

    const roots = listWorktreeRootsSync(repo);
    expect(roots).toContain(realpathSync(worktree));
    expect(roots).not.toContain(realpathSync(repo));
  });
});
