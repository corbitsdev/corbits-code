/**
 * Mount coverage for Codex tool proxies (apply_patch, shell, update_plan):
 * primary strip of apply_patch, allowlists, and build-shaped capability filter
 * retention.
 *
 * runSubAgent has no standalone toolset-factory export to import directly (the
 * mount is inline in runSubAgent's tool-assembly), so the subagent mount path
 * is covered here via the same allowDeleteFromCapabilities /
 * allowShellFromCapabilities calls runSubAgent makes against a leaf
 * capability filter, feeding createCodexToolProxies exactly as run.ts does.
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
import { CORE_TOOL_NAMES } from "./tool-search.js";

afterEach(() => {
  spyOn(posixModule, "createPosixTools").mockRestore();
});

describe("Codex tool proxy mount", () => {
  test("non-Codex createAgentToolset does not advertise proxies on primary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-codex-mount-"));
    spyOn(posixModule, "createPosixTools").mockReturnValue({
      definitions: [],
      run: async () => ({ id: "x", content: "" }),
      dispose: async () => {},
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

  test("Codex createAgentToolset strips apply_patch on primary; keeps shell/update_plan", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-codex-mount-"));
    spyOn(posixModule, "createPosixTools").mockReturnValue({
      definitions: [],
      run: async () => ({ id: "x", content: "" }),
      dispose: async () => {},
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
      isCodex: true,
    });
    const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(names).not.toContain("apply_patch");
    // Primary DIY product writes remain mounted.
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("delete_file");
    // shell / update_plan are not product-mutation tools (same classification
    // as run_shell / manage_tasks), so the primary apply_patch strip does not
    // remove them — they stay mounted on primary, mirroring run_shell.
    expect(names).toContain("shell");
    expect(names).toContain("update_plan");
    await toolset.dispose();
  });

  test("BUILD_TOOLS and DOCS_TOOLS include apply_patch; CORE_TOOL_NAMES does not", () => {
    expect(BUILD_TOOLS).toContain("apply_patch");
    expect(DOCS_TOOLS).toContain("apply_patch");
    expect(CORE_TOOL_NAMES).not.toContain("apply_patch");
  });

  test("capability include-filter keeps proxies for build-shaped allowlists", () => {
    const proxies = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "ok" }),
    });
    expect(proxies.map((t) => t.definition.name)).toEqual([
      "apply_patch",
      "shell",
      "update_plan",
    ]);

    const allow = new Set<string>(BUILD_TOOLS);
    const kept = proxies.filter((t) => allow.has(t.definition.name));
    expect(kept.map((t) => t.definition.name)).toEqual(["apply_patch", "shell", "update_plan"]);

    const docsAllow = new Set<string>(DOCS_TOOLS);
    const docsKept = proxies.filter((t) => docsAllow.has(t.definition.name));
    expect(docsKept.map((t) => t.definition.name)).toEqual(["apply_patch", "update_plan"]);
  });

  test("runSubAgent-shaped mount: docs capability filter denies shell, keeps update_plan", () => {
    // Mirrors run.ts: allowDelete / allowShell are derived from the leaf
    // capability filter before createCodexToolProxies runs. update_plan is
    // never gated by it (manage_tasks is unconditionally mounted for every
    // sub-agent), so it stays regardless of the allowlist shape.
    const docsCapabilities = { mode: "allow" as const, tools: DOCS_TOOLS };
    const proxies = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "ok" }),
      allowDelete: allowDeleteFromCapabilities(docsCapabilities),
      allowShell: allowShellFromCapabilities(docsCapabilities),
    });
    expect(proxies.map((t) => t.definition.name)).toEqual([
      "apply_patch",
      "shell",
      "update_plan",
    ]);

    const docsAllow = new Set<string>(DOCS_TOOLS);
    const docsKept = proxies.filter((t) => docsAllow.has(t.definition.name));
    expect(docsKept.map((t) => t.definition.name)).toEqual(["apply_patch", "update_plan"]);
  });

  test("non-Codex runSubAgent-shaped mount produces no proxies at all", () => {
    const proxies = createCodexToolProxies({
      isCodex: false,
      runTool: async () => ({ content: "ok" }),
      allowDelete: allowDeleteFromCapabilities({ mode: "allow", tools: BUILD_TOOLS }),
      allowShell: allowShellFromCapabilities({ mode: "allow", tools: BUILD_TOOLS }),
    });
    expect(proxies).toEqual([]);
  });
});
