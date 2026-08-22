/**
 * Mount coverage for Codex apply_patch proxies: primary strip, allowlists,
 * and build-shaped capability filter retention.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import * as posixModule from "@intx/tools-posix";

import { createCodexToolProxies } from "./codex-tool-proxies.js";
import { BUILD_TOOLS, DOCS_TOOLS } from "./directors/tool-sets.js";
import { CORE_TOOL_NAMES } from "./tool-search.js";

afterEach(() => {
  spyOn(posixModule, "createPosixTools").mockRestore();
});

describe("Codex apply_patch mount", () => {
  test("non-Codex createAgentToolset does not advertise apply_patch on primary", async () => {
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
    await toolset.dispose();
  });

  test("Codex createAgentToolset strips apply_patch on primary after mount", async () => {
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
    await toolset.dispose();
  });

  test("BUILD_TOOLS and DOCS_TOOLS include apply_patch; CORE_TOOL_NAMES does not", () => {
    expect(BUILD_TOOLS).toContain("apply_patch");
    expect(DOCS_TOOLS).toContain("apply_patch");
    expect(CORE_TOOL_NAMES).not.toContain("apply_patch");
  });

  test("capability include-filter keeps apply_patch for build-shaped allowlists", () => {
    const proxies = createCodexToolProxies({
      isCodex: true,
      runTool: async () => ({ content: "ok" }),
    });
    expect(proxies.map((t) => t.definition.name)).toEqual(["apply_patch"]);

    const allow = new Set<string>(BUILD_TOOLS);
    const kept = proxies.filter((t) => allow.has(t.definition.name));
    expect(kept.map((t) => t.definition.name)).toContain("apply_patch");

    const docsAllow = new Set<string>(DOCS_TOOLS);
    const docsKept = proxies.filter((t) => docsAllow.has(t.definition.name));
    expect(docsKept.map((t) => t.definition.name)).toContain("apply_patch");
  });
});
