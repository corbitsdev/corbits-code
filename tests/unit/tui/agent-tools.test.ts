import { test, expect, mock } from "bun:test";
import type { ToolDefinition, ToolCall } from "@intx/types/runtime";

const mockDispose = mock(async () => {});

const mockPosixTools = {
  definitions: [
    { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "write_file", description: "Write a file", inputSchema: { type: "object", properties: {}, required: [] } },
  ] as ToolDefinition[],
  run: mock(async (_call: ToolCall, _signal: AbortSignal) => ({
    callId: "test",
    content: "ok",
    isError: false,
  })),
  dispose: mockDispose,
};

mock.module("@intx/tools-posix", () => ({
  createPosixTools: () => mockPosixTools,
}));

mock.module("../../../src/plugins/path-escape-plugin.js", () => ({
  pathEscapePlugin: () => ({}),
}));

mock.module("../../../src/plugins/authz-plugin.js", () => ({
  authzPlugin: () => ({}),
}));

mock.module("../../../src/plugins/verify-plugin.js", () => ({
  verifyPlugin: () => ({}),
}));

mock.module("../../../src/plugins/permission-plugin.js", () => ({
  permissionPlugin: () => ({}),
}));

mock.module("../../../src/plugins/secret-guard-plugin.js", () => ({
  secretGuardPlugin: () => ({}),
}));

mock.module("../../../src/web/plugin.js", () => ({
  webToolsPlugin: () => ({}),
}));

mock.module("../../../src/director.js", () => ({
  askOperatorDefinition: {
    name: "ask_operator",
    description: "Ask operator",
    inputSchema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition,
  createChatDirector: mock(() => ({})),
  createCodingDirector: mock(() => ({})),
}));

const { createAgentToolset } = await import("../../../src/tui/agent-tools.js");

const fakePermissionGate = {
  evaluate: mock(async () => ({ allowed: true as const })),
};

test("allDefinitions contains posix tool names plus ask_operator", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => 0,
  });

  const names = toolset.allDefinitions.map((d) => d.name);
  expect(names).toContain("read_file");
  expect(names).toContain("write_file");
  expect(names).toContain("ask_operator");
});

test("onOperatorGate callback is invoked when the operator tool handler is called", async () => {
  let capturedQuestion = "";
  let capturedOptions: string[] = [];

  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async (question, options) => {
      capturedQuestion = question;
      capturedOptions = options;
      return 1;
    },
  });

  const operatorTool = toolset.tools.find((t) => t.definition.name === "ask_operator");
  expect(operatorTool).toBeDefined();

  const result = await (operatorTool as { definition: ToolDefinition; handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string> }).handler(
    { question: "Which approach?", options: ["A", "B", "C"] },
    new AbortController().signal,
  );

  expect(capturedQuestion).toBe("Which approach?");
  expect(capturedOptions).toEqual(["A", "B", "C"]);
  expect(result).toBe("B");
});

test("operator tool returns error when no options are provided", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => 0,
  });

  const operatorTool = toolset.tools.find((t) => t.definition.name === "ask_operator");
  expect(operatorTool).toBeDefined();

  const result = await (operatorTool as { definition: ToolDefinition; handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string> }).handler(
    { question: "Empty?", options: [] },
    new AbortController().signal,
  );

  expect(result).toMatch(/requires at least one option/);
});

test("operator tool returns error for out-of-range index", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => 99,
  });

  const operatorTool = toolset.tools.find((t) => t.definition.name === "ask_operator");
  expect(operatorTool).toBeDefined();

  const result = await (operatorTool as { definition: ToolDefinition; handler: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string> }).handler(
    { question: "Pick one", options: ["X"] },
    new AbortController().signal,
  );

  expect(result).toMatch(/invalid selection/);
});

test("dispose calls posixTools.dispose", async () => {
  mockDispose.mockClear();

  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => 0,
  });

  await toolset.dispose();
  expect(mockDispose).toHaveBeenCalledTimes(1);
});
