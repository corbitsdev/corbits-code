import { test, expect, mock, spyOn } from "bun:test";
import * as lspModule from "@intx/tools-lsp";
import * as posixModule from "@intx/tools-posix";
import { LSP_TOOL_DEFINITION } from "@intx/tools-lsp";

const mockPlugin = { tools: [], middleware: undefined, dispose: async () => {} };

test("createAgentToolset calls createLSPPlugin with correct args", async () => {
  const createLSPPluginSpy = spyOn(lspModule, "createLSPPlugin").mockReturnValue(mockPlugin);

  // createPosixTools needs to be a no-op for this test
  spyOn(posixModule, "createPosixTools").mockReturnValue({
    definitions: [],
    run: async () => ({ output: "" }),
    dispose: async () => {},
  } as unknown as ReturnType<typeof posixModule.createPosixTools>);

  const { createAgentToolset } = await import("../../src/agent-tools.js");
  const permissionGate = { check: async () => ({ allowed: true }) } as never;

  await createAgentToolset({
    cwd: "/test/cwd",
    permissionGate,
    onOperatorGate: async () => 0,
  });

  expect(createLSPPluginSpy).toHaveBeenCalledWith({ cwd: "/test/cwd", minSeverity: 1 });

  createLSPPluginSpy.mockRestore();
});

test("allDefinitions includes the lsp tool", async () => {
  expect(LSP_TOOL_DEFINITION.name).toBe("lsp");
});
