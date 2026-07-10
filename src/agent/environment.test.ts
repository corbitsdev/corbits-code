import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { gatherEnvironment } from "./environment.js";

const run = promisify(execFile);

test("gatherEnvironment reports cwd, platform, and date", async () => {
  const date = new Date(2026, 5, 5);
  const env = await gatherEnvironment(process.cwd(), date);
  expect(env.cwd).toBe(process.cwd());
  expect(env.platform.length).toBeGreaterThan(0);
  expect(env.date).toBe(date);
});

test("gatherEnvironment detects this repository as a git work tree", async () => {
  const env = await gatherEnvironment(process.cwd());
  expect(env.isGitRepo).toBe(true);
  expect(env.gitBranch).toBeDefined();
  expect(env.topLevel).toContain("src/");
});

test("gatherEnvironment gathers branch and dirty status from the same work tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intercode-env-"));
  try {
    await run("git", ["init"], { cwd: dir });
    await run("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    await run("git", ["checkout", "-b", "trunk"], { cwd: dir });
    await writeFile(join(dir, "seed.txt"), "seed");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "seed"], { cwd: dir });
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

test("gatherEnvironment reports a non-git directory without throwing", async () => {
  const env = await gatherEnvironment(tmpdir());
  expect(env.cwd).toBe(tmpdir());
  // tmpdir is not expected to be a git work tree on CI or dev machines.
  expect(typeof env.isGitRepo).toBe("boolean");
});
