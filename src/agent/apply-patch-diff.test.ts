import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

async function makeApplyPatch(
  cwd: string,
  options: { skipPermissions?: boolean } = {},
): Promise<AgentTool[]> {
  const gate = createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: options.skipPermissions ?? true,
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
    readRawFile: createCodexReadRawFile(cwd, gate),
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

describe("apply_patch Update File refuses reads outside the sanctioned workspace (CL-6966 follow-up)", () => {
  // Insertion-only hunk (no context to match): the shape that makes an
  // unauthorized raw read exploitable rather than merely wrong, since it
  // requires no content match to "succeed" and hands the read content
  // straight to write_file via Move to.
  const insertionOnlyMoveInput = (path: string, moveTo: string) =>
    [
      "*** Begin Patch",
      `*** Update File: ${path}`,
      `*** Move to: ${moveTo}`,
      "@@",
      "+",
      "*** End Patch",
    ].join("\n");

  test("../ traversal out of the workspace is refused", async () => {
    const parent = await mkdtemp(join(tmpdir(), "apply-patch-cl6966-parent-"));
    const cwd = join(parent, "workspace");
    await mkdir(cwd);
    try {
      await writeFile(join(parent, "victim.txt"), "outside secret\n");
      const tools = await makeApplyPatch(cwd, { skipPermissions: false });

      const result = await invokeApplyPatch(
        tools,
        insertionOnlyMoveInput("../victim.txt", "leaked.txt"),
      );

      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/escapes working directory/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a symlinked directory leading outside the workspace is refused", async () => {
    const parent = await mkdtemp(join(tmpdir(), "apply-patch-cl6966-symlink-"));
    const cwd = join(parent, "workspace");
    const outside = join(parent, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    try {
      await writeFile(join(outside, "victim.txt"), "outside secret\n");
      await symlink(outside, join(cwd, "escape-link"));
      const tools = await makeApplyPatch(cwd, { skipPermissions: false });

      const result = await invokeApplyPatch(
        tools,
        insertionOnlyMoveInput("escape-link/victim.txt", "leaked.txt"),
      );

      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/escapes working directory/i);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a secret-guard path (.env) is refused even with skipPermissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "apply-patch-cl6966-secret-"));
    try {
      await writeFile(join(cwd, ".env"), "API_KEY=super-secret\n");
      // skipPermissions: true (yolo) — secret-guard has no bypass, unlike containment.
      const tools = await makeApplyPatch(cwd, { skipPermissions: true });

      const result = await invokeApplyPatch(tools, insertionOnlyMoveInput(".env", "leaked.txt"));

      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/sensitive file/i);
      // The secret must never have reached the workspace under a new name.
      expect(await Bun.file(join(cwd, "leaked.txt")).exists()).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("../ traversal to a secret file is refused (secret-guard applies to relative paths too)", async () => {
    const parent = await mkdtemp(join(tmpdir(), "apply-patch-cl6966-secret-parent-"));
    const cwd = join(parent, "workspace");
    await mkdir(cwd);
    try {
      await writeFile(join(parent, ".env"), "API_KEY=super-secret\n");
      const tools = await makeApplyPatch(cwd, { skipPermissions: false });

      const result = await invokeApplyPatch(tools, insertionOnlyMoveInput("../.env", "leaked.txt"));

      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
      expect(await Bun.file(join(cwd, "leaked.txt")).exists()).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
