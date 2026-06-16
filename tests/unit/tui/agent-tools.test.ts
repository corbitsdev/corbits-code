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

mock.module("../../../src/agent/director.js", () => ({
  askOperatorDefinition: {
    name: "ask_operator",
    description: "Ask operator",
    inputSchema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition,
  createChatDirector: mock(() => ({})),
  createCodingDirector: mock(() => ({})),
}));

const { createAgentToolset } = await import("../../../src/agent/tools.js");

const fakePermissionGate = {
  evaluate: mock(async () => ({ allowed: true as const })),
};

const callOperator = async (
  toolset: Awaited<ReturnType<typeof createAgentToolset>>,
  args: Record<string, unknown>,
): Promise<string> => {
  const result = await toolset.dynamicRunner.run(
    { id: "op", name: "ask_operator", arguments: args },
    new AbortController().signal,
  );
  return String(result.content);
};

const callPresent = async (
  toolset: Awaited<ReturnType<typeof createAgentToolset>>,
  view: unknown,
): Promise<string> => {
  const result = await toolset.dynamicRunner.run(
    { id: "p", name: "present", arguments: { view } },
    new AbortController().signal,
  );
  return String(result.content);
};

test("present validates the view spec and gives self-correcting errors", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });
  expect(toolset.dynamicRunner.currentDefinitions().map((d) => d.name)).toContain("present");
  expect(await callPresent(toolset, { type: "heading", value: "Hi" })).toBe("Rendered.");
  expect(await callPresent(toolset, { type: "chart" })).toMatch(/Invalid view spec/);
});

test("dynamicRunner contains posix tool names plus ask_operator", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
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
      return { kind: "option", index: 1 };
    },
  });

  const result = await callOperator(toolset, { question: "Which approach?", options: ["A", "B", "C"] });

  expect(capturedQuestion).toBe("Which approach?");
  expect(capturedOptions).toEqual(["A", "B", "C"]);
  expect(result).toBe("B");
});

test("operator tool returns the operator's free-form answer", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "custom", text: "use the second one but tweak the tone" }),
  });

  const result = await callOperator(toolset, { question: "Which approach?", options: ["A", "B"] });
  expect(result).toBe("use the second one but tweak the tone");
});

test("operator tool tells the agent to proceed when the operator dismisses the question", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "cancel" }),
  });

  const result = await callOperator(toolset, { question: "Which approach?", options: ["A", "B"] });
  expect(result).toMatch(/dismissed the question/);
});

test("operator tool returns error when no options are provided", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  expect(await callOperator(toolset, { question: "Empty?", options: [] })).toMatch(/requires at least one option/);
});

test("operator tool returns error for out-of-range index", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 99 }),
  });

  expect(await callOperator(toolset, { question: "Pick one", options: ["X"] })).toMatch(/invalid selection/);
});

test("dispose calls posixTools.dispose", async () => {
  mockDispose.mockClear();

  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  await toolset.dispose();
  expect(mockDispose).toHaveBeenCalledTimes(1);
});
