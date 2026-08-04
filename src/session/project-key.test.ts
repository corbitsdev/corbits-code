import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  projectKeyFor,
  projectRootFor,
  projectSessionsRoot,
  projectsRoot,
} from "./project-key.js";

let root = "";

beforeEach(async () => {
  root = join(tmpdir(), `corbits-project-key-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("projectKeyFor is stable across calls for the same path", () => {
  const a = projectKeyFor(root);
  const b = projectKeyFor(root);
  expect(a).toBe(b);
  expect(a).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}$/);
});

test("projectKeyFor uses shared git common dir so worktrees match main", async () => {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
  await writeFile(join(root, "README"), "x");
  execFileSync("git", ["add", "README"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

  const nested = join(root, "nested", "deep");
  await mkdir(nested, { recursive: true });
  expect(projectRootFor(nested)).toBe(projectRootFor(root));
  expect(projectKeyFor(nested)).toBe(projectKeyFor(root));

  const wt = join(root, "..", `wt-${Date.now()}`);
  try {
    execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(projectRootFor(wt)).toBe(projectRootFor(root));
    expect(projectKeyFor(wt)).toBe(projectKeyFor(root));
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      await rm(wt, { recursive: true, force: true });
    }
  }
});


test("projectSessionsRoot lives under ~/.corbits/projects/<key>", () => {
  const home = join(root, "home");
  const key = projectKeyFor(root);
  expect(projectsRoot(home)).toBe(join(home, ".corbits", "projects"));
  expect(projectSessionsRoot(root, home)).toBe(join(home, ".corbits", "projects", key));
});
