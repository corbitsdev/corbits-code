import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import { createToolRunner } from "@intx/agent";
import type { AgentTool } from "@intx/agent";

import { createCodexToolProxies, type CodexRunTool } from "./codex-tool-proxies.js";
import { createCodexReadRawFile } from "./codex-read-raw-file.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";
import { createPermissionGate } from "../permission/gate.js";

/**
 * apply_patch forwards each op through the same posixTools.run chain the rest
 * of the agent uses (see tools.ts), so verify-plugin's and delete-file-plugin's
 * diffs surface here too without any apply_patch-specific plumbing.
 */
async function invokeApplyPatch(tools: AgentTool[], input: string) {
  const runner = createToolRunner(tools);
  return runner.run(
    { id: "call-1", name: "apply_patch", arguments: { input } },
    new AbortController().signal,
  );
}

async function makeApplyPatch(cwd: string): Promise<AgentTool[]> {
  const gate = createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    auto: false,
    cwd,
  });
  const posixTools = createPosixTools({
    cwd,
    plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
  });
  const runTool: CodexRunTool = async (name, args) => {
    const result = await posixTools.run(
      { id: "codex-proxy", name, arguments: args },
      new AbortController().signal,
    );
    return {
      content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
      ...(result.isError === true ? { isError: true } : {}),
    };
  };
  // Real production path (CL-6966): Update File matches patch context against
  // raw file content, not read_file's cat -n formatted output.
  return createCodexToolProxies({
    isCodex: true,
    runTool,
    readRawFile: createCodexReadRawFile(cwd),
    runManageTasks: async () => ({ content: "ok" }),
  });
}

describe("apply_patch Update File matches raw content, not read_file's numbered output (CL-6966)", () => {
  test("multi-hunk Update File succeeds through the real production path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "apply-patch-cl6966-"));
    try {
      await writeFile(
        join(cwd, "app.py"),
        "def greet():\n    print('hi')\n\n\ndef farewell():\n    print('bye')\n",
      );
      const tools = await makeApplyPatch(cwd);
      const input = [
        "*** Begin Patch",
        "*** Update File: app.py",
        "@@ def greet():",
        "-    print('hi')",
        "+    print('hello')",
        "@@ def farewell():",
        "-    print('bye')",
        "+    print('goodbye')",
        "*** End Patch",
      ].join("\n");

      const result = await invokeApplyPatch(tools, input);

      expect(result.isError).not.toBe(true);
      const written = await Bun.file(join(cwd, "app.py")).text();
      expect(written).toBe(
        "def greet():\n    print('hello')\n\n\ndef farewell():\n    print('goodbye')\n",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("Update File shows the diff", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "apply-patch-diff-"));
    try {
      await writeFile(join(cwd, "a.txt"), "line1\nworld\nline3\n");
      const tools = await makeApplyPatch(cwd);
      const input = [
        "*** Begin Patch",
        "*** Update File: a.txt",
        "@@",
        " line1",
        "-world",
        "+universe",
        " line3",
        "*** End Patch",
      ].join("\n");

      const result = await invokeApplyPatch(tools, input);

      expect(result.isError).not.toBe(true);
      expect(String(result.content)).toContain("-world");
      expect(String(result.content)).toContain("+universe");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("Delete File shows the removed content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "apply-patch-diff-"));
    try {
      await writeFile(join(cwd, "gone.txt"), "bye\n");
      const tools = await makeApplyPatch(cwd);
      const input = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"].join("\n");

      const result = await invokeApplyPatch(tools, input);

      expect(result.isError).not.toBe(true);
      expect(String(result.content)).toContain("-bye");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("Add File shows the added content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "apply-patch-diff-"));
    try {
      const tools = await makeApplyPatch(cwd);
      const input = ["*** Begin Patch", "*** Add File: new.txt", "+hello", "*** End Patch"].join(
        "\n",
      );

      const result = await invokeApplyPatch(tools, input);

      expect(result.isError).not.toBe(true);
      expect(String(result.content)).toContain("+hello");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
