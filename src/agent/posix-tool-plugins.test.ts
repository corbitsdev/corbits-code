import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPosixTools } from "@intx/tools-posix";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";

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
});