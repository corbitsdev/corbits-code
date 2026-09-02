import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPathRestriction } from "./path-restriction.js";
import { projectSessionsRoot } from "../session/project-key.js";
import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";

let cwd = "";
let home = "";

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  cwd = join(tmpdir(), `corbits-path-rest-${stamp}`);
  home = join(tmpdir(), `corbits-path-rest-home-${stamp}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("legacy .agent-state: reads allow, writes restricted", () => {
  const r = createPathRestriction(cwd, () => [], home);
  expect(r.isRestricted(".agent-state/run.json", false)).toBe(false);
  expect(r.isRestricted(".agent-state/run.json", true)).toBe(true);
});

test("global projects session root: reads allow, writes restricted", () => {
  const r = createPathRestriction(cwd, () => [], home);
  const globalRun = join(projectSessionsRoot(cwd, home), "sess-1", "run.json");
  expect(r.isRestricted(globalRun, false)).toBe(false);
  expect(r.isRestricted(globalRun, true)).toBe(true);
});

test("other paths under home remain outside-workspace restricted", () => {
  const r = createPathRestriction(cwd, () => [], home);
  const other = join(home, ".corbits", "settings.json");
  expect(r.isRestricted(other, false)).toBe(true);
  expect(r.isRestricted(other, true)).toBe(true);
});

test("workspace-relative paths are unrestricted", () => {
  const r = createPathRestriction(cwd, () => [], home);
  expect(r.isRestricted("src/index.ts", false)).toBe(false);
  expect(r.isRestricted("src/index.ts", true)).toBe(false);
});

test("an empty-string root does not turn containment into allow-all", () => {
  // Regression for CL-6700: root + sep === sep when root is "", which every
  // absolute path starts with. A sensitive absolute path resolved against
  // a provider that yields "" roots must still be denied.
  const r = createPathRestriction(cwd, () => [""], home);
  expect(r.isRestricted("/etc/passwd", false)).toBe(true);
  expect(r.isRestricted("/etc/passwd", true)).toBe(true);
});

test('a root of exactly "/" is not the same bug: it is not an allow-all prefix', () => {
  // Documents the non-bug: "/" + sep is "//", which "/etc/passwd" does not
  // start with, so an unrelated absolute path stays outside the workspace.
  const r = createPathRestriction(cwd, () => ["/"], home);
  expect(r.isRestricted("/etc/passwd", false)).toBe(true);
});

test("a directory sharing a string prefix with the workspace root is still restricted", async () => {
  // "<cwd>baz" shares a string prefix with cwd but is a distinct sibling
  // directory outside the workspace — the boundary check must not leak into
  // it via naive string prefixing.
  const prefixSibling = `${cwd}baz`;
  await mkdir(prefixSibling, { recursive: true });
  const r = createPathRestriction(cwd, () => [], home);

  expect(r.isRestricted(prefixSibling, false)).toBe(true);
  expect(r.isRestricted(join(prefixSibling, "file.txt"), false)).toBe(true);
});

test("a cache entry cannot combine an outside realpath with an inside verdict", async () => {
  const insideDir = join(cwd, "inside-race");
  const outsideDir = join(home, "outside-race");
  await mkdir(insideDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const link = join(cwd, "race-link");
  await symlink(outsideDir, link);
  const target = join(link, "file.txt");

  const r = createPathRestriction(cwd, () => [], home);
  let retargeted = false;
  await withMockedModuleDuring(
    "node:fs",
    (realFS: typeof import("node:fs")) => ({
      ...realFS,
      realpathSync: (path: Parameters<typeof realFS.realpathSync>[0]) => {
        const realpath = realFS.realpathSync(path);
        if (!retargeted && path === link) {
          realFS.unlinkSync(link);
          realFS.symlinkSync(insideDir, link);
          retargeted = true;
        }
        return realpath;
      },
    }),
    async () => {
      expect(r.isRestricted(target, false)).toBe(true);
    },
  );

  await rm(link);
  await symlink(outsideDir, link);
  expect(r.isRestricted(target, false)).toBe(true);
});

test("symlink retarget invalidates cache: inside-allowed → outside-restricted (CL-6708)", async () => {
  // Create a symlink pointing inside the workspace
  const insideDir = join(cwd, "inside");
  await mkdir(insideDir, { recursive: true });
  const link = join(cwd, "link");
  await symlink(insideDir, link);

  const r = createPathRestriction(cwd, () => [], home);
  const target = join(link, "file.txt");

  // First check: symlink points inside, so path is unrestricted
  expect(r.isRestricted(target, false)).toBe(false);

  // Retarget symlink to point outside the workspace
  await rm(link);
  const outsideDir = join(home, "outside");
  await mkdir(outsideDir, { recursive: true });
  await symlink(outsideDir, link);

  // Second check: same lexical path, but now restricted due to retarget
  expect(r.isRestricted(target, false)).toBe(true);
});
