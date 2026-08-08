import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall } from "@intx/types/runtime";

import { isAutoAllowedShellCall } from "./classify.js";
import { createPathRestriction } from "./path-restriction.js";

let cwd = "";
let worktree = "";
let evilWorktree = "";
let outside = "";
let home = "";

const shellCall = (command: string): ToolCall => ({ id: "c", name: "run_shell", arguments: { command } });

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-containment-${stamp}`);
  worktree = join(tmpdir(), `corbits-containment-wt1-${stamp}`);
  evilWorktree = join(tmpdir(), `corbits-containment-wt1-${stamp}-evil`);
  outside = join(tmpdir(), `corbits-containment-outside-${stamp}`);
  home = join(tmpdir(), `corbits-containment-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await mkdir(evilWorktree, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(join(worktree, "sub"), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
  await rm(evilWorktree, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("a path in a registered sibling worktree gets the same verdict from auto-allow and restriction", () => {
  const rootsProvider = () => [realpathSync(worktree)];
  const target = join(worktree, "sub", "file.txt");

  const autoAllowed = isAutoAllowedShellCall(shellCall(`cat ${target}`), cwd, rootsProvider);
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  // The worktree path is inside the workspace boundary: restriction must
  // clear it (not restricted), and auto-allow must agree.
  expect(restricted).toBe(false);
  expect(autoAllowed).toBe(true);
});

test("a path genuinely outside the workspace and its worktrees is refused by both", () => {
  const rootsProvider = () => [realpathSync(worktree)];
  const target = join(outside, "secret.txt");

  const autoAllowed = isAutoAllowedShellCall(shellCall(`cat ${target}`), cwd, rootsProvider);
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  expect(autoAllowed).toBe(false);
  expect(restricted).toBe(true);
});

test("a prefix-spoofing sibling directory is refused by both", () => {
  const rootsProvider = () => [realpathSync(worktree)];
  const target = join(evilWorktree, "file.txt");

  const autoAllowed = isAutoAllowedShellCall(shellCall(`cat ${target}`), cwd, rootsProvider);
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  expect(autoAllowed).toBe(false);
  expect(restricted).toBe(true);
});

test("a symlink pointing outside the workspace is refused, even for a not-yet-existing target under it", async () => {
  const rootsProvider = () => [];
  const link = join(cwd, "link");
  await symlink(outside, link);
  await writeFile(join(outside, "secret.txt"), "s");
  const target = join(link, "secret.txt");

  const autoAllowed = isAutoAllowedShellCall(shellCall(`cat ${target}`), cwd, rootsProvider);
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  expect(autoAllowed).toBe(false);
  expect(restricted).toBe(true);
});
