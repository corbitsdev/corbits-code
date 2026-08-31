/**
 * `bin/git-push-scoped` must never write to global git config: not on a
 * normal push, not when two pushes race, and not when one is killed
 * mid-flight. Every test runs against an isolated HOME/GIT_CONFIG_GLOBAL
 * so a bug here can never touch the real machine's config.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initTemporaryGitRepo } from "../helpers/temporary-git-repo.js";

const SCRIPT = join(import.meta.dir, "../../bin/git-push-scoped");

let root: string;
let globalConfigPath: string;
let fakeBinDir: string;
let env: NodeJS.ProcessEnv;

function run(args: string[], opts: { cwd?: string } = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn(SCRIPT, args, { cwd: opts.cwd ?? root, env, stdio: "ignore" });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function initBareRemote(name: string): string {
  const path = join(root, name);
  mkdirSync(path);
  spawnSync("git", ["init", "--bare", "-q", path]);
  return path;
}

// node:child_process.spawnSync is used only for synchronous test setup below.
import { spawnSync } from "node:child_process";

function initWorkingRepo(name: string, remotePath: string): string {
  const path = join(root, name);
  mkdirSync(path);
  initTemporaryGitRepo(path, { initArgs: ["-q", "-b", "main"] });
  writeFileSync(join(path, "file.txt"), name);
  spawnSync("git", ["-C", path, "add", "file.txt"]);
  spawnSync("git", ["-C", path, "commit", "-q", "-m", "initial commit"]);
  spawnSync("git", ["-C", path, "remote", "add", "origin", remotePath]);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-push-scoped-"));

  // Isolated global config: a known sentinel that must never change.
  globalConfigPath = join(root, "global-gitconfig");
  writeFileSync(globalConfigPath, "[user]\n\tname = Sentinel\n\temail = sentinel@example.com\n");

  // Stub `gh` on PATH so the script's `command -v gh` check passes without
  // depending on a real GitHub CLI install or credentials.
  fakeBinDir = join(root, "fakebin");
  mkdirSync(fakeBinDir);
  const ghStub = join(fakeBinDir, "gh");
  writeFileSync(ghStub, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(ghStub, 0o755);

  env = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${fakeBinDir}:${process.env.PATH}`,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git-push-scoped", () => {
  it("pushes successfully without writing to global git config", async () => {
    const before = readFileSync(globalConfigPath, "utf8");
    const remote = initBareRemote("remote.git");
    const work = initWorkingRepo("work", remote);

    const { code } = await run(["origin", "main"], { cwd: work });

    expect(code).toBe(0);
    expect(readFileSync(globalConfigPath, "utf8")).toBe(before);
  });

  it("leaves global config untouched when two pushes race", async () => {
    const before = readFileSync(globalConfigPath, "utf8");
    const remoteA = initBareRemote("remote-a.git");
    const remoteB = initBareRemote("remote-b.git");
    const workA = initWorkingRepo("work-a", remoteA);
    const workB = initWorkingRepo("work-b", remoteB);

    const [resultA, resultB] = await Promise.all([
      run(["origin", "main"], { cwd: workA }),
      run(["origin", "main"], { cwd: workB }),
    ]);

    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);
    expect(readFileSync(globalConfigPath, "utf8")).toBe(before);
  });

  it("leaves global config untouched when killed mid-flight", async () => {
    const before = readFileSync(globalConfigPath, "utf8");
    const remote = initBareRemote("remote-slow.git");
    const work = initWorkingRepo("work-slow", remote);

    // A pre-receive hook that sleeps gives us a reliable window to kill the
    // push while it is in flight.
    const hookPath = join(remote, "hooks", "pre-receive");
    writeFileSync(hookPath, "#!/usr/bin/env bash\nsleep 5\n");
    chmodSync(hookPath, 0o755);

    const child = spawn(SCRIPT, ["origin", "main"], { cwd: work, env, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill("SIGKILL");
    const { signal } = await exited;

    expect(signal).toBe("SIGKILL");
    expect(readFileSync(globalConfigPath, "utf8")).toBe(before);
  });
});
