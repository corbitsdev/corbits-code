import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import { createToolRunner } from "@intx/agent";
import type { AgentTool } from "@intx/agent";

import { createCodexToolProxies, type CodexRunTool } from "./codex-tool-proxies.js";
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
  const posixTools = createPosixTools({ cwd, plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }) });
  const runTool: CodexRunTool = async (name, args) => {
    // read_file's real tool output is cat -n formatted (line numbers), which
    // is not the raw content applyUpdateHunks needs — in production this
    // means Update File hunks generally fail to match context (filed as
    // CL-6966, Urgent; not this issue's bug to fix). This stub bypasses that
    // known defect by returning raw content, so the "Update File shows the
    // diff" test below is NOT proof that apply_patch Update works end to end
    // — it only proves the diff-surfacing added here is correct once the op
    // succeeds. Add File / Delete File below do not depend on read_file and
    // are real, unstubbed coverage.
    if (name === "read_file") {
      const path = String((args as { path?: unknown }).path ?? "");
      try {
        return { content: await readFile(join(cwd, path), "utf8") };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }
    const result = await posixTools.run(
      { id: "codex-proxy", name, arguments: args },
      new AbortController().signal,
    );
    return {
      content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
      ...(result.isError === true ? { isError: true } : {}),
    };
  };
  return createCodexToolProxies({
    isCodex: true,
    runTool,
    runManageTasks: async () => ({ content: "ok" }),
  });
}

describe("apply_patch surfaces the changed region", () => {
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
      const input = [
        "*** Begin Patch",
        "*** Add File: new.txt",
        "+hello",
        "*** End Patch",
      ].join("\n");

      const result = await invokeApplyPatch(tools, input);

      expect(result.isError).not.toBe(true);
      expect(String(result.content)).toContain("+hello");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
