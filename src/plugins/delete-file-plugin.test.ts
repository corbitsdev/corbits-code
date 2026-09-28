import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { deleteFilePlugin } from "./delete-file-plugin.js";
import { pathEscapePlugin } from "./path-escape-plugin.js";
import { createPermissionGate } from "../permission/gate.js";
import { permissionPlugin } from "./permission-plugin.js";

function call(path: unknown): ToolCall {
  return { id: "delete-call", name: "delete_file", arguments: { path } };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function linkExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("deleteFilePlugin", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "corbits-delete-file-"));
  });

  afterEach(async () => {
    await chmod(cwd, 0o700).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  });

  function handler(): (
    call: ToolCall,
    signal: AbortSignal,
  ) => Promise<ToolResult> {
    const tool = deleteFilePlugin(cwd).tools?.[0];
    if (tool === undefined)
      throw new Error("delete_file tool was not registered");
    return tool.handler;
  }

  test("deletes an existing file with an explicit outcome", async () => {
    const path = join(cwd, "old.txt");
    await writeFile(path, "old");

    const result = await handler()(
      call("old.txt"),
      new AbortController().signal,
    );

    // Match on the parts that matter (callId, deletion message, removed
    // content) rather than the exact hunk header text, which is a
    // formatChangeDiff implementation detail covered by change-diff.test.ts.
    expect(result.callId).toBe("delete-call");
    expect(String(result.content)).toContain("old.txt");
    expect(String(result.content)).toContain("-old");
    expect(await exists(path)).toBe(false);
  });

  test("reports an absent file as a successful no-op", async () => {
    const result = await handler()(
      call("missing.txt"),
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.callId).toBe("delete-call");
    expect(String(result.content).length).toBeGreaterThan(0);
  });

  test("refuses to delete directories", async () => {
    await mkdir(join(cwd, "folder"));

    const result = await handler()(
      call("folder"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content).length).toBeGreaterThan(0);
    expect(await exists(join(cwd, "folder"))).toBe(true);
  });

  test("restricted paths are blocked before deletion", async () => {
    const outside = await mkdtemp(join(tmpdir(), "corbits-delete-outside-"));
    const path = join(outside, "keep.txt");
    await writeFile(path, "keep");
    const next = handler();
    const guarded = pathEscapePlugin(cwd).middleware?.(next) ?? next;

    const result = await guarded(call(path), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(String(result.content).length).toBeGreaterThan(0);
    expect(await exists(path)).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  test("refuses files reached through a directory symlink outside the workspace", async () => {
    const outside = await mkdtemp(
      join(tmpdir(), "corbits-delete-symlink-outside-"),
    );
    const path = join(outside, "keep.txt");
    await writeFile(path, "keep");
    await symlink(outside, join(cwd, "linked-outside"));

    const result = await handler()(
      call("linked-outside/keep.txt"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content).length).toBeGreaterThan(0);
    expect(await exists(path)).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  test("deletes a dangling symlink inside cwd (CL-6729)", async () => {
    const link = join(cwd, "broken-link");
    await symlink(join(cwd, "does-not-exist.txt"), link);
    expect(await linkExists(link)).toBe(true);

    const result = await handler()(
      call("broken-link"),
      new AbortController().signal,
    );

    expect(result.isError ?? false).toBe(false);
    expect(String(result.content)).toContain("broken-link");
    expect(await linkExists(link)).toBe(false);
  });

  test("deletes a link with an outside referent without touching the referent (CL-6729)", async () => {
    const outside = await mkdtemp(
      join(tmpdir(), "corbits-delete-link-referent-"),
    );
    const referent = join(outside, "keep.txt");
    await writeFile(referent, "keep");
    const link = join(cwd, "outside-link");
    await symlink(referent, link);
    expect(await linkExists(link)).toBe(true);

    const result = await handler()(
      call("outside-link"),
      new AbortController().signal,
    );

    expect(result.isError ?? false).toBe(false);
    expect(String(result.content)).toContain("outside-link");
    expect(await linkExists(link)).toBe(false);
    expect(await readFile(referent, "utf8")).toBe("keep");
    await rm(outside, { recursive: true, force: true });
  });

  test("allowOutside deletes a file outside the working directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "corbits-delete-yolo-"));
    const path = join(outside, "gone.txt");
    await writeFile(path, "gone");
    const tool = deleteFilePlugin(cwd, { allowOutside: true }).tools?.[0];
    if (tool === undefined)
      throw new Error("delete_file tool was not registered");

    const result = await tool.handler(call(path), new AbortController().signal);

    expect(result.callId).toBe("delete-call");
    expect(String(result.content)).toContain(`Deleted file: ${path}`);
    expect(String(result.content)).toContain("-gone");
    expect(await exists(path)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  test("allowOutside getter is resolved per call", async () => {
    const outside = await mkdtemp(
      join(tmpdir(), "corbits-delete-yolo-getter-"),
    );
    const path = join(outside, "gone.txt");
    await writeFile(path, "gone");
    let allow = false;
    const tool = deleteFilePlugin(cwd, { allowOutside: () => allow })
      .tools?.[0];
    if (tool === undefined)
      throw new Error("delete_file tool was not registered");

    const blocked = await tool.handler(
      call(path),
      new AbortController().signal,
    );
    expect(blocked.isError).toBe(true);
    expect(String(blocked.content).length).toBeGreaterThan(0);
    expect(await exists(path)).toBe(true);

    allow = true;
    const result = await tool.handler(call(path), new AbortController().signal);
    expect(result.callId).toBe("delete-call");
    expect(String(result.content)).toContain(path);
    expect(String(result.content)).toContain("-gone");
    expect(await exists(path)).toBe(false);
    await rm(outside, { recursive: true, force: true });
  });

  test("permission denial prevents deletion", async () => {
    const path = join(cwd, "keep.txt");
    await writeFile(path, "keep");
    const next = handler();
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
      cwd,
      requestApproval: async () => ({ allow: false }),
    });
    const guarded = permissionPlugin(gate).middleware?.(next) ?? next;

    const result = await guarded(
      call("keep.txt"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content).length).toBeGreaterThan(0);
    expect(await exists(path)).toBe(true);
  });

  test("deletes a file in a registered sibling worktree (CL-6729)", async () => {
    const sibling = await mkdtemp(join(tmpdir(), "corbits-delete-sibling-"));
    const path = join(sibling, "old.txt");
    await writeFile(path, "old");
    const roots = [await realpath(sibling)];
    const tool = deleteFilePlugin(cwd, { rootsProvider: () => roots })
      .tools?.[0];
    if (tool === undefined)
      throw new Error("delete_file tool was not registered");

    const result = await tool.handler(call(path), new AbortController().signal);

    expect(result.isError ?? false).toBe(false);
    expect(String(result.content)).toContain("old.txt");
    expect(await exists(path)).toBe(false);
    await rm(sibling, { recursive: true, force: true });
  });

  test("still refuses a genuinely outside file when roots are registered (CL-6729)", async () => {
    const sibling = await mkdtemp(
      join(tmpdir(), "corbits-delete-sibling-keep-"),
    );
    const outside = await mkdtemp(join(tmpdir(), "corbits-delete-outside-"));
    const path = join(outside, "keep.txt");
    await writeFile(path, "keep");
    const roots = [await realpath(sibling)];
    const tool = deleteFilePlugin(cwd, { rootsProvider: () => roots })
      .tools?.[0];
    if (tool === undefined)
      throw new Error("delete_file tool was not registered");

    const result = await tool.handler(call(path), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(String(result.content).length).toBeGreaterThan(0);
    expect(await exists(path)).toBe(true);
    await rm(sibling, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("preserves filesystem failure details", async () => {
    const path = join(cwd, "locked.txt");
    await writeFile(path, "keep");
    await chmod(cwd, 0o500);

    const result = await handler()(
      call("locked.txt"),
      new AbortController().signal,
    );
    await chmod(cwd, 0o700);

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(
      /EACCES|EPERM|permission denied|operation not permitted/i,
    );
    expect(await exists(path)).toBe(true);
  });
});
