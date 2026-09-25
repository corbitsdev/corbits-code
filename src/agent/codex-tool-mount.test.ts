/**
 * Mount coverage for Codex: no advertised apply_patch/shell/update_plan,
 * engines stay posix-named, hidden aliases dispatch without dual-publish.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import * as posixModule from "@intx/tools-posix";

import {
  allowDeleteFromCapabilities,
  allowShellFromCapabilities,
  createCodexToolProxies,
} from "./codex-tool-proxies.js";
import { BUILD_TOOLS, DOCS_TOOLS } from "./directors/tool-sets.js";
import { advertisedTools, CORE_TOOL_NAMES } from "./tool-search.js";

afterEach(() => {
  spyOn(posixModule, "createPosixTools").mockRestore();
});

describe("Codex tool proxy mount", () => {
  test("non-Codex createAgentToolset does not advertise proxies on primary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-codex-mount-"));
    spyOn(posixModule, "createPosixTools").mockReturnValue({
      definitions: [],
      run: async () => ({ id: "x", content: "" }),
      dispose: async () => undefined,
    } as unknown as ReturnType<typeof posixModule.createPosixTools>);

    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;

    const toolset = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      isCodex: false,
    });
    const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(names).not.toContain("apply_patch");
    expect(names).not.toContain("shell");
    expect(names).not.toContain("update_plan");
    await toolset.dispose();
  });

  test("Codex createAgentToolset does not advertise apply_patch/shell/update_plan", async () => {
    // Unstubbed createPosixTools: write_file / edit_file / delete_file come from
    // the real posix + delete-file plugin mount. An empty stub would hide them
    // and make the DIY-remains assertion meaningless.
    const cwd = mkdtempSync(join(tmpdir(), "corbits-codex-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;

    const toolset = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      isCodex: true,
    });
    const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(names).not.toContain("apply_patch");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("delete_file");
    expect(names).toContain("run_shell");
    expect(names).not.toContain("shell");
    expect(names).not.toContain("update_plan");
    const advertised = advertisedTools(
      toolset.dynamicRunner.currentDefinitions(),
    ).map((d) => d.name);
    expect(advertised).toContain("bash");
    expect(advertised).not.toContain("run_shell");
    expect(advertised).not.toContain("shell");
    expect(advertised).not.toContain("apply_patch");
    expect(advertised).not.toContain("update_plan");
    await toolset.dispose();
  });

  test("update_plan hidden-dispatches through manage_tasks without a proxy mount", async () => {
    // Unstubbed createPosixTools (real temp dir): update_plan used to call
    // runTool("manage_tasks", ...), which forwards onto posixTools.run and
    // fails with "unknown tool: manage_tasks" — posixTools has no
    // manage_tasks handler. This exercises the real createAgentToolset mount
    // (src/agent/tools.ts) end to end, not a mock recorder, so it would have
    // caught that dead dispatch.
    const cwd = mkdtempSync(join(tmpdir(), "corbits-codex-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;

    const toolset = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      isCodex: true,
    });
    const result = await toolset.dynamicRunner.run(
      {
        id: "call-1",
        name: "update_plan",
        arguments: {
          plan: [{ step: "Do the thing", status: "in_progress" }],
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    await toolset.dispose();
  });

  test("BUILD_TOOLS and DOCS_TOOLS omit apply_patch; CORE_TOOL_NAMES does not list it", () => {
    expect(BUILD_TOOLS).not.toContain("apply_patch");
    expect(DOCS_TOOLS).not.toContain("apply_patch");
    expect(CORE_TOOL_NAMES).not.toContain("apply_patch");
  });

  test("capability include-filter no longer keeps Codex proxy names", () => {
    const proxies = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "ok" }),
      readRawFile: async () => ({ content: "ok" }),
      runManageTasks: async () => ({ content: "ok" }),
    });
    expect(proxies.map((t) => t.definition.name)).toEqual([
      "apply_patch",
      "shell",
      "update_plan",
    ]);

    const allow = new Set<string>(BUILD_TOOLS);
    const kept = proxies.filter((t) => allow.has(t.definition.name));
    expect(kept).toEqual([]);

    const docsAllow = new Set<string>(DOCS_TOOLS);
    const docsKept = proxies.filter((t) => docsAllow.has(t.definition.name));
    expect(docsKept).toEqual([]);
  });

  test("runSubAgent-shaped allowlists do not keep Codex proxy names", () => {
    const docsAllow = new Set<string>(DOCS_TOOLS);
    const proxies = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "ok" }),
      readRawFile: async () => ({ content: "ok" }),
      runManageTasks: async () => ({ content: "ok" }),
      allowDelete: allowDeleteFromCapabilities({
        mode: "allow",
        tools: DOCS_TOOLS,
      }),
      allowShell: allowShellFromCapabilities({
        mode: "allow",
        tools: DOCS_TOOLS,
      }),
    });
    const docsKept = proxies.filter((t) => docsAllow.has(t.definition.name));
    expect(docsKept).toEqual([]);
  });

  test("non-Codex runSubAgent-shaped mount produces no proxies at all", () => {
    const proxies = createCodexToolProxies({
      isCodex: false,
      runTool: async () => ({ content: "ok" }),
      readRawFile: async () => ({ content: "ok" }),
      runManageTasks: async () => ({ content: "ok" }),
      allowDelete: allowDeleteFromCapabilities({
        mode: "allow",
        tools: BUILD_TOOLS,
      }),
      allowShell: allowShellFromCapabilities({
        mode: "allow",
        tools: BUILD_TOOLS,
      }),
    });
    expect(proxies).toEqual([]);
  });
});
