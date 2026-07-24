import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBlobReader } from "@intx/types/runtime";
import { createPosixTools } from "@intx/tools-posix";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";
import { createCompositeBlobReader, createLazyBlobReader } from "./lazy-blob-reader.js";

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
});