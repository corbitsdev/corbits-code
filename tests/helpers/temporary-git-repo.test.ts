import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTemporaryGitRepo } from "./temporary-git-repo.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "corbits-temp-git-"));
  tempRoots.push(dir);
  return dir;
}

function rejectingHostConfig(root: string): { configPath: string; env: NodeJS.ProcessEnv } {
  const hooksDir = join(root, "host-hooks");
  mkdirSync(hooksDir);
  const preCommit = join(hooksDir, "pre-commit");
  writeFileSync(preCommit, "#!/bin/sh\necho 'host hook rejected fixture commit' >&2\nexit 1\n");
  chmodSync(preCommit, 0o755);
  const configPath = join(root, "host-gitconfig");
  writeFileSync(configPath, `[core]\n\thooksPath = ${hooksDir}\n`);
  return {
    configPath,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  };
}

function gitStatus(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return {
    status: proc.exitCode ?? 1,
    stderr: proc.stderr.toString(),
  };
}

test("a naive fixture commit fails when the host config points at a rejecting hook", () => {
  const root = tempRoot();
  const { env } = rejectingHostConfig(root);
  const repo = join(root, "naive");
  mkdirSync(repo);
  execFileSync("git", ["init"], { cwd: repo, env, stdio: "ignore" });
  execFileSync("git", ["config", "--local", "user.email", "t@t.test"], {
    cwd: repo,
    env,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "--local", "user.name", "t"], {
    cwd: repo,
    env,
    stdio: "ignore",
  });
  const commit = gitStatus(repo, ["commit", "--allow-empty", "-m", "init"], env);
  expect(commit.status).not.toBe(0);
  expect(commit.stderr).toContain("host hook rejected fixture commit");
});

test("initTemporaryGitRepo fixture commit succeeds under a rejecting host hooksPath", () => {
  const root = tempRoot();
  const { configPath, env } = rejectingHostConfig(root);
  const before = readFileSync(configPath, "utf8");
  const repo = join(root, "hermetic");
  mkdirSync(repo);

  initTemporaryGitRepo(repo);

  const commit = gitStatus(repo, ["commit", "--allow-empty", "-m", "init"], env);
  expect(commit.status).toBe(0);
  expect(commit.stderr).not.toContain("host hook rejected fixture commit");
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, env, stdio: "ignore" });
  expect(readFileSync(configPath, "utf8")).toBe(before);
});

test("initTemporaryGitRepo sets local identity and core.hooksPath without touching global config", () => {
  const root = tempRoot();
  const { configPath, env } = rejectingHostConfig(root);
  const before = readFileSync(configPath, "utf8");
  const repo = join(root, "local-only");
  mkdirSync(repo);

  initTemporaryGitRepo(repo);

  const email = execFileSync("git", ["config", "--local", "--get", "user.email"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  const name = execFileSync("git", ["config", "--local", "--get", "user.name"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  const hooksPath = execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  expect(email).toBe("t@t.test");
  expect(name).toBe("t");
  expect(hooksPath.length).toBeGreaterThan(0);
  expect(readFileSync(configPath, "utf8")).toBe(before);
});
