import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initTemporaryGitRepo } from "../helpers/temporary-git-repo.js";

const repoRoot = join(import.meta.dirname, "../..");
const scopeScript = join(repoRoot, "scripts/verify-corbits-only-scope.sh");

async function runScopeScript(
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", scopeScript], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function initGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited.then(
      (code) => {
        if (code !== 0) throw new Error(`git ${args.join(" ")} failed with ${code}`);
      },
    );
  initTemporaryGitRepo(dir);
  await writeFile(join(dir, "README.md"), "ok\n");
  await run(["add", "README.md"]);
  await run(["commit", "-m", "init"]);
}

test("verify-corbits-only-scope passes on clean corbits-only tree", async () => {
  const { exitCode, stdout } = await runScopeScript(repoRoot);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("OK: no forbidden path changes detected.");
});

test("verify-corbits-only-scope fails on untracked vendor path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-guard-"));
  try {
    await initGitRepo(dir);
    await mkdir(join(dir, "vendor"), { recursive: true });
    await writeFile(join(dir, "vendor", "touch.txt"), "x\n");
    const { exitCode, stdout } = await runScopeScript(dir);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SCOPE VIOLATION");
    expect(stdout).toContain("vendor/touch.txt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-corbits-only-scope passes on empty change set in fresh repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scope-guard-clean-"));
  try {
    await initGitRepo(dir);
    const { exitCode, stdout } = await runScopeScript(dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: no forbidden path changes detected.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
