import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall } from "@intx/types/runtime";

import { isAutoAllowedShellCall } from "./classify.js";
import {
  createPathRestriction,
  resolveWorkspacePath,
} from "./path-restriction.js";

let cwd = "";
let worktree = "";
let evilWorktree = "";
let outside = "";
let home = "";

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

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

  const autoAllowed = isAutoAllowedShellCall(
    shellCall(`cat ${target}`),
    cwd,
    rootsProvider,
  );
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  // In-workspace path: restriction clears it and auto-allow agrees.
  expect(restricted).toBe(false);
  expect(autoAllowed).toBe(true);
});

test("a path genuinely outside the workspace and its worktrees is refused by both", () => {
  const rootsProvider = () => [realpathSync(worktree)];
  const target = join(outside, "secret.txt");

  const autoAllowed = isAutoAllowedShellCall(
    shellCall(`cat ${target}`),
    cwd,
    rootsProvider,
  );
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  expect(autoAllowed).toBe(false);
  expect(restricted).toBe(true);
});

test("a prefix-spoofing sibling directory is refused by both", () => {
  const rootsProvider = () => [realpathSync(worktree)];
  const target = join(evilWorktree, "file.txt");

  const autoAllowed = isAutoAllowedShellCall(
    shellCall(`cat ${target}`),
    cwd,
    rootsProvider,
  );
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

  const autoAllowed = isAutoAllowedShellCall(
    shellCall(`cat ${target}`),
    cwd,
    rootsProvider,
  );
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  const restricted = restriction.isRestricted(target, false);

  expect(autoAllowed).toBe(false);
  expect(restricted).toBe(true);
});

test("a dangling symlink under cwd pointing outside denies a child path, and stays denied after the outside target is created (CL-6715)", async () => {
  // The dangling link's name is not an ordinary missing tail segment:
  // realpath fails on the link itself, not on the not-yet-existing child.
  const rootsProvider = () => [];
  const link = join(cwd, "dangling-link");
  const outsideTarget = join(outside, "not-created-yet");
  await symlink(outsideTarget, link);
  const target = join(link, "child.txt");

  expect(
    resolveWorkspacePath(
      cwd,
      join("dangling-link", "child.txt"),
      rootsProvider,
    ),
  ).toBeUndefined();

  const restriction = createPathRestriction(cwd, rootsProvider, home);
  expect(restriction.isRestricted(target, false)).toBe(true);
  expect(restriction.isRestricted(target, true)).toBe(true);

  // Creating the outside target later does not legitimize the path: still
  // ordinary outside-symlink denial, re-checked once the target exists.
  await mkdir(outsideTarget, { recursive: true });
  await writeFile(join(outsideTarget, "child.txt"), "s");
  expect(
    resolveWorkspacePath(
      cwd,
      join("dangling-link", "child.txt"),
      rootsProvider,
    ),
  ).toBeUndefined();
});

test("a symlink loop under cwd is denied by resolveWorkspacePath (CL-6715)", async () => {
  const rootsProvider = () => [];
  const linkA = join(cwd, "loop-a");
  const linkB = join(cwd, "loop-b");
  await symlink(linkB, linkA);
  await symlink(linkA, linkB);

  expect(
    resolveWorkspacePath(cwd, join("loop-a", "child.txt"), rootsProvider),
  ).toBeUndefined();
  expect(resolveWorkspacePath(cwd, "loop-a", rootsProvider)).toBeUndefined();
});

test("resolveWorkspacePath returns the canonical target so a later symlink retarget cannot redirect a write (CL-6712 TOCTOU)", async () => {
  // Resolve to the canonical real path, not the lexical path through the
  // symlink: a caller that remembered the lexical path would follow a later
  // retarget instead of the location that was actually approved.
  const rootsProvider = () => [];
  const realTarget = join(cwd, "real-target");
  await mkdir(realTarget, { recursive: true });
  const link = join(cwd, "link");
  await symlink(realTarget, link);

  const resolved = resolveWorkspacePath(
    cwd,
    join("link", "note.txt"),
    rootsProvider,
  );
  expect(resolved).toBe(join(realpathSync(realTarget), "note.txt"));

  // Retarget the symlink outside, as an attacker would between check and write.
  await rm(link);
  await symlink(outside, link);

  // The captured canonical path never traverses "link" again, so the
  // retarget cannot redirect it.
  expect(resolved).not.toContain(outside);

  // A fresh check against the now-retargeted symlink correctly sees the
  // escape and denies it.
  const restriction = createPathRestriction(cwd, rootsProvider, home);
  expect(restriction.isRestricted(join(link, "note.txt"), true)).toBe(true);
});
