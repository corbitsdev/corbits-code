/**
 * Mount coverage for Codex: no advertised apply_patch/shell/update_plan,
 * engines stay posix-named, hidden aliases dispatch without dual-publish.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import * as posixModule from "@intx/tools-posix";

import { BUILD_TOOLS, DOCS_TOOLS } from "./directors/tool-sets.js";
import { foldFileToolNames } from "./tool-aliases.js";
import {
  ADVERTISED_TOOL_NAMES,
  advertisedTools,
  CORE_TOOL_NAMES,
} from "./tool-search.js";

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
    expect(names).not.toContain("shell");
    expect(names).not.toContain("update_plan");
    await toolset.dispose();
  });

  test("Codex createAgentToolset keeps engines posix-named and projects wire names by profile", async () => {
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
    const gptAdvertised = advertisedTools(
      toolset.dynamicRunner.currentDefinitions(),
      [],
      foldFileToolNames(ADVERTISED_TOOL_NAMES, "gpt"),
      "gpt",
    ).map((d) => d.name);
    expect(gptAdvertised).toContain("shell");
    expect(gptAdvertised).toContain("apply_patch");
    expect(gptAdvertised).toContain("update_plan");
    expect(gptAdvertised).not.toContain("write");
    expect(gptAdvertised).not.toContain("bash");
    await toolset.dispose();
  });

  test("update_plan hidden-dispatches through manage_tasks without a proxy mount", async () => {
    // Unstubbed createPosixTools (real temp dir): update_plan used to call
    // runTool("manage_tasks", ...), which forwards onto posixTools.run and
    // fails with "unknown tool: manage_tasks" — posixTools has no
    // manage_tasks handler. Exercises the real createAgentToolset mount
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

  test("wire names from every profile dispatch onto the mounted engines", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-codex-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const toolset = await createAgentToolset({
      cwd,
      permissionGate: {
        check: async () => ({ allowed: true }),
        getSkipPermissions: () => false,
      } as never,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      isCodex: true,
    });
    const call = (name: string, args: Record<string, unknown>) =>
      toolset.dynamicRunner.run(
        { id: name, name, arguments: args },
        new AbortController().signal,
      );
    const patched = await call("apply_patch", {
      input: "*** Begin Patch\n*** Add File: made.txt\n+hi\n*** End Patch",
    });
    expect(patched.isError).toBeFalsy();
    expect(readFileSync(join(cwd, "made.txt"), "utf8")).toBe("hi\n");
    const todo = await call("todowrite", {
      action: "create",
      tasks: [{ id: "t1", title: "x", status: "todo" }],
    });
    expect(todo.isError).toBeFalsy();
    await toolset.dispose();
  });

  test("BUILD_TOOLS and DOCS_TOOLS omit apply_patch; CORE_TOOL_NAMES does not list it", () => {
    expect(BUILD_TOOLS).not.toContain("apply_patch");
    expect(DOCS_TOOLS).not.toContain("apply_patch");
    expect(CORE_TOOL_NAMES).not.toContain("apply_patch");
  });
});
