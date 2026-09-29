import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listWorktreeRoots, listWorktreeRootsSync } from "./worktree-roots.js";
import { GIT_FATAL, captureStderr } from "../../testkit/capture-stderr.js";

let restoreStderr: (() => void) | undefined;

afterEach(() => {
  restoreStderr?.();
  restoreStderr = undefined;
});

describe("listWorktreeRoots stderr", () => {
  test("listWorktreeRootsSync does not leak git fatal on a non-repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "corbits-nogit-sync-"));
    const cap = captureStderr();
    restoreStderr = cap.restore;
    const roots = listWorktreeRootsSync(dir);
    expect(roots).toEqual([]);
    expect(cap.output()).not.toContain(GIT_FATAL);
  });

  test("listWorktreeRoots does not leak git fatal on a non-repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "corbits-nogit-async-"));
    const cap = captureStderr();
    restoreStderr = cap.restore;
    const roots = await listWorktreeRoots(dir);
    expect(roots).toEqual([]);
    expect(cap.output()).not.toContain(GIT_FATAL);
  });
});
