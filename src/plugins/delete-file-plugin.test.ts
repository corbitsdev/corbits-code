import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

describe("deleteFilePlugin", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "corbits-delete-file-"));
  });

  afterEach(async () => {
    await chmod(cwd, 0o700).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  });

  function handler(): (call: ToolCall, signal: AbortSignal) => Promise<ToolResult> {
    const tool = deleteFilePlugin(cwd).tools?.[0];
    if (tool === undefined) throw new Error("delete_file tool was not registered");
    return tool.handler;
  }

  test("deletes an existing file with an explicit outcome", async () => {
    const path = join(cwd, "old.txt");
    await writeFile(path, "old");

    const result = await handler()(call("old.txt"), new AbortController().signal);

    expect(result).toEqual({ callId: "delete-call", content: "Deleted file: old.txt" });
    expect(await exists(path)).toBe(false);
  });

  test("reports an absent file as a successful no-op", async () => {
    const result = await handler()(call("missing.txt"), new AbortController().signal);

    expect(result).toEqual({ callId: "delete-call", content: "File already absent: missing.txt (no action needed)" });
  });

  test("refuses to delete directories", async () => {
    await mkdir(join(cwd, "folder"));

    const result = await handler()(call("folder"), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("is a directory");
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
    expect(result.content).toContain("escapes working directory");
    expect(await exists(path)).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  test("refuses files reached through a directory symlink outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "corbits-delete-symlink-outside-"));
    const path = join(outside, "keep.txt");
    await writeFile(path, "keep");
    await symlink(outside, join(cwd, "linked-outside"));

    const result = await handler()(call("linked-outside/keep.txt"), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("resolves outside the working directory");
    expect(await exists(path)).toBe(true);
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
      cwd,
      requestApproval: async () => ({ allow: false }),
    });
    const guarded = permissionPlugin(gate).middleware?.(next) ?? next;

    const result = await guarded(call("keep.txt"), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Operator declined");
    expect(await exists(path)).toBe(true);
  });

  test("preserves filesystem failure details", async () => {
    const path = join(cwd, "locked.txt");
    await writeFile(path, "keep");
    await chmod(cwd, 0o500);

    const result = await handler()(call("locked.txt"), new AbortController().signal);
    await chmod(cwd, 0o700);

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/EACCES|EPERM|permission denied|operation not permitted/i);
    expect(await exists(path)).toBe(true);
  });
});
