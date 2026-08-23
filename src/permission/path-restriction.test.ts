import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createPathRestriction } from "./path-restriction.js";
import { projectSessionsRoot } from "../session/project-key.js";

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
