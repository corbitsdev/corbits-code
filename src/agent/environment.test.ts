import { expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { gatherEnvironment } from "./environment.js";

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

test("gatherEnvironment reports a non-git directory without throwing", async () => {
  const env = await gatherEnvironment(tmpdir());
  expect(env.cwd).toBe(tmpdir());
  // tmpdir is not expected to be a git work tree on CI or dev machines.
  expect(typeof env.isGitRepo).toBe("boolean");
});
