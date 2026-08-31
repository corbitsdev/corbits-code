import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { gatherEnvironment, getGitBranch } from "./environment.js";
import { initTemporaryGitRepo } from "../../tests/helpers/temporary-git-repo.js";

const run = promisify(execFile);

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

test("gatherEnvironment reports cwd, platform, and date", async () => {
  const date = new Date(2026, 5, 5);
  const env = await gatherEnvironment(process.cwd(), date);
  expect(env.cwd).toBe(process.cwd());
  expect(env.platform.length).toBeGreaterThan(0);
  expect(env.date).toBe(date);
});

test("gatherEnvironment detects a git work tree and lists its top level", async () => {
  // A purpose-built repo rather than the checkout this run happens to sit in:
  // a runner may check out a detached HEAD, which has no branch name.
  const dir = await mkdtemp(join(tmpdir(), "corbits-env-repo-"));
  try {
    initTemporaryGitRepo(dir);
    await run("git", ["checkout", "-b", "trunk"], { cwd: dir });
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "seed.ts"), "export const seed = 1;\n");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "seed"], { cwd: dir });

    const env = await gatherEnvironment(dir);
    expect(env.isGitRepo).toBe(true);
    expect(env.gitBranch).toBe("trunk");
    expect(env.topLevel).toContain("src/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherEnvironment gathers branch and dirty status from the same work tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corbits-env-"));
  try {
    initTemporaryGitRepo(dir);
    await run("git", ["checkout", "-b", "trunk"], { cwd: dir });
    await writeFile(join(dir, "seed.txt"), "seed");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "seed"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "one");
    await writeFile(join(dir, "b.txt"), "two");

    const env = await gatherEnvironment(dir);

    // Both the branch call and the status call must survive being run
    // concurrently, so assert each independently reported result is present.
    expect(env.isGitRepo).toBe(true);
    expect(env.gitBranch).toBe("trunk");
    expect(env.gitDirtyCount).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getGitBranch returns the branch name via the injected git runner", async () => {
  const branch = await getGitBranch("/repo", async (cwd, args) => {
    expect(cwd).toBe("/repo");
    expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    return "feature/example-branch";
  });
  expect(branch).toBe("feature/example-branch");
});

test("getGitBranch returns null when the git runner reports failure", async () => {
  expect(await getGitBranch("/not-a-repo", async () => null)).toBe(null);
});

test("getGitBranch returns null for detached HEAD", async () => {
  expect(await getGitBranch("/repo", async () => "HEAD")).toBe(null);
});

test("getGitBranch returns null for empty output", async () => {
  expect(await getGitBranch("/repo", async () => "")).toBe(null);
});

test("gatherEnvironment reports a non-git directory without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corbits-env-bare-"));
  try {
    const env = await gatherEnvironment(dir);
    expect(env.cwd).toBe(dir);
    expect(env.isGitRepo).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getGitBranch does not leak git fatal stderr on a non-repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corbits-env-branch-nogit-"));
  const cap = captureStderr();
  restoreStderr = cap.restore;
  try {
    expect(await getGitBranch(dir)).toBe(null);
    expect(cap.output()).not.toContain(GIT_FATAL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gatherEnvironment does not leak git fatal stderr on a non-repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corbits-env-gather-nogit-"));
  const cap = captureStderr();
  restoreStderr = cap.restore;
  try {
    const env = await gatherEnvironment(dir);
    expect(env.isGitRepo).toBe(false);
    expect(env.gitBranch).toBeUndefined();
    expect(cap.output()).not.toContain(GIT_FATAL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
