import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBlobReader } from "@intx/types/runtime";
import { createPosixTools, composeMiddleware } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";
import { createCompositeBlobReader, createLazyBlobReader } from "./lazy-blob-reader.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { editFileLineRangePlugin } from "../plugins/edit-file-line-range-plugin.js";

type ToolHandlerLike = (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;

/**
 * editFileLineRangePlugin never calls `next` for start_line/end_line edits (it
 * writes and returns directly), so verifyPlugin only observes those calls when
 * it sits earlier in the plugin array (composeMiddleware wraps outer-to-inner
 * in array order). Identify each plugin's middleware by a string unique to its
 * implementation rather than assuming array indices.
 */
function findMiddlewareIndex(
  plugins: ReturnType<typeof buildCorePosixToolPlugins>,
  marker: string,
): number {
  return plugins.findIndex((plugin) => plugin.middleware?.toString().includes(marker) === true);
}

describe("buildCorePosixToolPlugins", () => {
  test("applies permission gate and result truncation like the main agent stack", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const path = join(cwd, "big.txt");
      await writeFile(path, "x".repeat(90_000), "utf8");

      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: false,
        auto: false,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });
      const outPath = join(cwd, "out.txt");
      const denied = await runner.run(
        { id: "1", name: "write_file", arguments: { path: outPath, content: "nope" } },
        new AbortController().signal,
      );
      expect(denied.isError).toBe(true);
      expect(String(denied.content)).toContain("Blocked by permission policy");

      const allowGate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const allowedRunner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: allowGate }),
      });
      const allowed = await allowedRunner.run(
        { id: "2", name: "read_file", arguments: { path } },
        new AbortController().signal,
      );
      expect(allowed.isError).not.toBe(true);
      // The read-file guard caps the read before result-truncation would run,
      // so a 90KB single line comes back line-truncated and bounded.
      expect(String(allowed.content)).toContain("line truncated at 2000 chars");
      expect(Buffer.byteLength(String(allowed.content), "utf8")).toBeLessThan(4096);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reads bounded tool-output spills when session blob reader is wired", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-tool-output-"));
    try {
      const encoder = new TextEncoder();
      const backing = createBlobReader({
        async readBlob(key: string) {
          if (key === "spill1") return encoder.encode("hello-spill");
          throw new Error(`missing ${key}`);
        },
      });
      const blobReader = createLazyBlobReader(() => backing);
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        blobReader,
        plugins: buildCorePosixToolPlugins({
          cwd,
          permissionGate: gate,
          readFileGuard: { blobReader },
        }),
      });
      const result = await runner.run(
        {
          id: "to1",
          name: "read_file",
          arguments: { path: "tool-output:///spill1" },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeFalsy();
      expect(String(result.content)).toContain("hello-spill");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("child composite blob reader re-reads parent tool-output URIs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-composite-blob-"));
    try {
      const encoder = new TextEncoder();
      // Mirrors runSubAgent wiring: child store bound after agent create, parent
      // always available so brief-handed tool-output:// URIs resolve (CL-4323).
      let childReader: ReturnType<typeof createBlobReader> | undefined;
      const parentReader = createBlobReader({
        async readBlob(key: string) {
          if (key === "parent-mcp-skill") return encoder.encode("parent-skill-body-tail");
          throw new Error(`Blob not found for key: ${JSON.stringify(key)}`);
        },
      });
      const blobReader = createCompositeBlobReader(
        () => childReader,
        () => parentReader,
      );
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        blobReader,
        plugins: buildCorePosixToolPlugins({
          cwd,
          permissionGate: gate,
          readFileGuard: { blobReader },
        }),
      });

      // Parent spill before child store is bound.
      const fromParent = await runner.run(
        {
          id: "p1",
          name: "read_file",
          arguments: { path: "tool-output:///parent-mcp-skill" },
        },
        new AbortController().signal,
      );
      expect(fromParent.isError).toBeFalsy();
      expect(String(fromParent.content)).toContain("parent-skill-body-tail");

      childReader = createBlobReader({
        async readBlob(key: string) {
          if (key === "child-local") return encoder.encode("child-own-spill");
          throw new Error(`Blob not found for key: ${JSON.stringify(key)}`);
        },
      });

      // Still falls through to parent after child is bound.
      const stillParent = await runner.run(
        {
          id: "p2",
          name: "read_file",
          arguments: { path: "tool-output:///parent-mcp-skill" },
        },
        new AbortController().signal,
      );
      expect(stillParent.isError).toBeFalsy();
      expect(String(stillParent.content)).toContain("parent-skill-body-tail");

      const fromChild = await runner.run(
        {
          id: "c1",
          name: "read_file",
          arguments: { path: "tool-output:///child-local" },
        },
        new AbortController().signal,
      );
      expect(fromChild.isError).toBeFalsy();
      expect(String(fromChild.content)).toContain("child-own-spill");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("verifyPlugin wraps editFileLineRangePlugin so line-range edits are still verified (CL-4405)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const plugins = buildCorePosixToolPlugins({ cwd, permissionGate: gate });

      const verifyIndex = findMiddlewareIndex(plugins, "Edit verification failed");
      const editRangeIndex = findMiddlewareIndex(plugins, "runEditFileLineRange");

      expect(verifyIndex).toBeGreaterThanOrEqual(0);
      expect(editRangeIndex).toBeGreaterThanOrEqual(0);
      expect(verifyIndex).toBeLessThan(editRangeIndex);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a real line-range edit_file call verifies as success through the wired plugin chain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const path = join(cwd, "test.txt");
      await writeFile(path, "a\nb\nc\n");

      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        cwd,
      });
      const runner = createPosixTools({
        cwd,
        plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
      });

      const result = await runner.run(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, start_line: 2, end_line: 2, new_string: "B" },
        },
        new AbortController().signal,
      );

      expect(result.isError).not.toBe(true);
      const final = await readFile(path, "utf8");
      expect(final).toBe("a\nB\nc\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("verifyPlugin still catches a genuine line-range mismatch caused by a concurrent write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-posix-plugins-"));
    try {
      const path = join(dir, "test.txt");
      await writeFile(path, "a\nb\nc\n");

      // Stands in for another actor mutating the file between verifyPlugin's
      // before-snapshot and editFileLineRangePlugin's own read, so the edit
      // lands against a baseline verify never saw.
      const concurrentWriterMiddleware =
        (next: ToolHandlerLike): ToolHandlerLike =>
        async (call, signal) => {
          await writeFile(path, "z\ny\nx\n");
          return next(call, signal);
        };

      const base: ToolHandlerLike = async (call) => ({ callId: call.id, content: "unreachable" });
      const verifyMiddleware = verifyPlugin().middleware;
      const editRangeMiddleware = editFileLineRangePlugin().middleware;
      if (verifyMiddleware === undefined || editRangeMiddleware === undefined) {
        throw new Error("expected verifyPlugin and editFileLineRangePlugin to expose middleware");
      }
      const composed = composeMiddleware(
        [verifyMiddleware, concurrentWriterMiddleware, editRangeMiddleware],
        base,
      );

      const result = await composed(
        {
          id: "call-1",
          name: "edit_file",
          arguments: { path, start_line: 2, end_line: 2, new_string: "B" },
        },
        new AbortController().signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/content mismatch after replacement/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});