import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { projectKeyFor, projectRootFor, projectSessionsRoot, projectsRoot } from "./project-key.js";
import { initTemporaryGitRepo } from "../../tests/helpers/temporary-git-repo.js";

let root = "";

beforeEach(async () => {
  root = join(tmpdir(), `corbits-project-key-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function initGitRepo(dir: string): void {
  initTemporaryGitRepo(dir);
}

async function commitReadme(dir: string): Promise<void> {
  await writeFile(join(dir, "README"), "x");
  execFileSync("git", ["add", "README"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

test("projectKeyFor is stable across calls for the same path", () => {
  const a = projectKeyFor(root);
  const b = projectKeyFor(root);
  expect(a).toBe(b);
  expect(a).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/);
});

test("projectKeyFor shares nested dirs under the same git toplevel", async () => {
  initGitRepo(root);
  await commitReadme(root);

  const nested = join(root, "nested", "deep");
  await mkdir(nested, { recursive: true });
  expect(projectRootFor(nested)).toBe(projectRootFor(root));
  expect(projectRootFor(root)).toBe(realpathSync(root));
  expect(projectKeyFor(nested)).toBe(projectKeyFor(root));
});

test("linked worktrees have distinct project roots and keys from main and each other", async () => {
  initGitRepo(root);
  await commitReadme(root);

  const wtA = join(root, "..", `wt-a-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const wtB = join(root, "..", `wt-b-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    execFileSync("git", ["worktree", "add", "--detach", wtA, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["worktree", "add", "--detach", wtB, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });

    expect(projectRootFor(wtA)).not.toBe(projectRootFor(root));
    expect(projectRootFor(wtB)).not.toBe(projectRootFor(root));
    expect(projectRootFor(wtA)).not.toBe(projectRootFor(wtB));
    expect(projectRootFor(wtA)).toBe(realpathSync(wtA));
    expect(projectRootFor(wtB)).toBe(realpathSync(wtB));
    expect(projectKeyFor(wtA)).not.toBe(projectKeyFor(root));
    expect(projectKeyFor(wtB)).not.toBe(projectKeyFor(root));
    expect(projectKeyFor(wtA)).not.toBe(projectKeyFor(wtB));
  } finally {
    for (const wt of [wtA, wtB]) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt], {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        await rm(wt, { recursive: true, force: true });
      }
    }
  }
});

test("projectSessionsRoot lives under ~/.corbits/projects/<key>", () => {
  const home = join(root, "home");
  const key = projectKeyFor(root);
  expect(projectsRoot(home)).toBe(join(home, ".corbits", "projects"));
  expect(projectSessionsRoot(root, home)).toBe(join(home, ".corbits", "projects", key));
});
