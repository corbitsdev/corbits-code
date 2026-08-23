import { afterAll, test, expect, mock } from "bun:test";
import type { ToolDefinition, ToolCall } from "@intx/types/runtime";
import { TOOL_NAMES } from "@intx/tools-posix";

const mockDispose = mock(async () => {});

const mockPosixTools = {
  definitions: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "write_file",
      description: "Write a file",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "edit_file",
      description: "Edit a file",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "delete_file",
      description: "Delete a file",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ] as ToolDefinition[],
  run: mock(async (_call: ToolCall, _signal: AbortSignal) => ({
    callId: "test",
    content: "ok",
    isError: false,
  })),
  dispose: mockDispose,
};

// mock.module replaces the shared module cache for the whole test process, so
// every other file that imports these modules runs against the mock until it
// is put back. Capture the real modules up front and restore them in
// afterAll so this file's mocking is invisible outside its own tests. Bun
// mutates the imported namespace object in place when a module is mocked, so
// each capture is shallow-copied immediately -- holding onto the live
// namespace instead would silently turn into the mocked exports as soon as
// mock.module below runs, making the "restore" a no-op.
const realToolsPosix = { ...(await import("@intx/tools-posix")) };
const realPosixToolPlugins = { ...(await import("../../../src/agent/posix-tool-plugins.js")) };
const realMcpClient = { ...(await import("../../../src/mcp/client.js")) };
const realMcpPlugin = { ...(await import("../../../src/mcp/plugin.js")) };
const realPathEscapePlugin = { ...(await import("../../../src/plugins/path-escape-plugin.js")) };
const realAuthzPlugin = { ...(await import("../../../src/plugins/authz-plugin.js")) };
const realVerifyPlugin = { ...(await import("../../../src/plugins/verify-plugin.js")) };
const realPermissionPlugin = { ...(await import("../../../src/plugins/permission-plugin.js")) };
const realSecretGuardPlugin = { ...(await import("../../../src/plugins/secret-guard-plugin.js")) };
const realShellGuardPlugin = { ...(await import("../../../src/plugins/shell-guard-plugin.js")) };
const realReadFileGuardPlugin = {
  ...(await import("../../../src/plugins/read-file-guard-plugin.js")),
};
const realEditFileLineRange = { ...(await import("../../../src/plugins/edit-file-line-range.js")) };
const realDirector = { ...(await import("../../../src/agent/director.js")) };

mock.module("@intx/tools-posix", () => ({
  createPosixTools: () => mockPosixTools,
  TOOL_NAMES,
}));

mock.module("../../../src/agent/posix-tool-plugins.js", () => ({
  buildCorePosixToolPlugins: () => [],
}));

const mockConnectMCPServer = mock(async (config: { name: string }) => ({
  ok: false as const,
  serverName: config.name,
  error: "not connected",
}));

mock.module("../../../src/mcp/client.js", () => ({
  ...realMcpClient,
  connectMCPServer: mockConnectMCPServer,
}));

mock.module("../../../src/mcp/plugin.js", () => ({
  mcpClientToAgentTools: () => [],
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
  gateToolCall: async (
    _gate: unknown,
    call: ToolCall,
    signal: AbortSignal,
    next: (call: ToolCall, signal: AbortSignal) => Promise<unknown>,
  ) => next(call, signal),
}));

mock.module("../../../src/plugins/secret-guard-plugin.js", () => ({
  secretGuardPlugin: () => ({}),
}));

mock.module("../../../src/plugins/shell-guard-plugin.js", () => ({
  shellGuardPlugin: () => ({}),
  advertiseShellGuardTimeout: (defs: ToolDefinition[]) => defs,
  DEFAULT_SHELL_TIMEOUT_MS: 15_000,
}));

mock.module("../../../src/plugins/read-file-guard-plugin.js", () => ({
  readFileGuardPlugin: () => ({}),
}));

mock.module("../../../src/plugins/edit-file-line-range.js", () => ({
  advertiseEditFileLineRange: (defs: ToolDefinition[]) => defs,
}));

mock.module("../../../src/agent/director.js", () => ({
  askOperatorDefinition: {
    name: "ask_operator",
    description: "Ask operator",
    inputSchema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition,
  presentDefinition: {
    name: "present",
    description: "Present structured output",
    inputSchema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition,
  advanceWorkflowDefinition: {
    name: "advance_workflow",
    description: "Advance workflow",
    inputSchema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition,
  createChatDirector: mock(() => ({})),
}));

afterAll(() => {
  mock.module("@intx/tools-posix", () => realToolsPosix);
  mock.module("../../../src/agent/posix-tool-plugins.js", () => realPosixToolPlugins);
  mock.module("../../../src/mcp/client.js", () => realMcpClient);
  mock.module("../../../src/mcp/plugin.js", () => realMcpPlugin);
  mock.module("../../../src/plugins/path-escape-plugin.js", () => realPathEscapePlugin);
  mock.module("../../../src/plugins/authz-plugin.js", () => realAuthzPlugin);
  mock.module("../../../src/plugins/verify-plugin.js", () => realVerifyPlugin);
  mock.module("../../../src/plugins/permission-plugin.js", () => realPermissionPlugin);
  mock.module("../../../src/plugins/secret-guard-plugin.js", () => realSecretGuardPlugin);
  mock.module("../../../src/plugins/shell-guard-plugin.js", () => realShellGuardPlugin);
  mock.module("../../../src/plugins/read-file-guard-plugin.js", () => realReadFileGuardPlugin);
  mock.module("../../../src/plugins/edit-file-line-range.js", () => realEditFileLineRange);
  mock.module("../../../src/agent/director.js", () => realDirector);
});

const { createAgentToolset } = await import("../../../src/agent/tools.js");

const fakePermissionGate = {
  evaluate: mock(async () => ({ allowed: true as const })),
  preApprove: mock(() => {}),
  registerMcpClient: mock(() => {}),
  unregisterMcpServer: mock(() => {}),
  getSkipPermissions: () => false,
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
  expect(await callPresent(toolset, { type: "text", text: "Hi" })).toBe("Rendered.");
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
  expect(names).toContain("ask_operator");
  // Primary Skywalker mounts product mutation tools for DIY tiny/bounded edits.
  expect(names).toContain("write_file");
  expect(names).toContain("edit_file");
  expect(names).toContain("delete_file");
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

  const result = await callOperator(toolset, {
    question: "Which approach?",
    options: ["A", "B", "C"],
  });

  expect(capturedQuestion).toBe("Which approach?");
  expect(capturedOptions).toEqual(["A", "B", "C"]);
  expect(result).toBe("B");
});

test("operator tool pre-approves the declared command for run_shell when an option is chosen", async () => {
  fakePermissionGate.preApprove.mockClear();

  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  await callOperator(toolset, {
    question: "What would you like to install?",
    options: ["Project dependencies"],
    command: "bun install",
  });

  expect(fakePermissionGate.preApprove).toHaveBeenCalledWith("run_shell", "bun install");
  expect(fakePermissionGate.preApprove).toHaveBeenCalledTimes(1);
});

test("operator tool does not pre-approve anything when no command is declared", async () => {
  fakePermissionGate.preApprove.mockClear();

  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  await callOperator(toolset, { question: "Which approach?", options: ["A", "B"] });

  expect(fakePermissionGate.preApprove).not.toHaveBeenCalled();
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

  expect(await callOperator(toolset, { question: "Empty?", options: [] })).toMatch(
    /requires at least one option/,
  );
});

test("operator tool returns error for out-of-range index", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 99 }),
  });

  expect(await callOperator(toolset, { question: "Pick one", options: ["X"] })).toMatch(
    /invalid selection/,
  );
});

const subAgentDeps = {
  provider: () => ({
    providerName: "test",
    baseURL: "http://localhost",
    apiKey: "k",
    model: "m",
  }),
  getWorkdirBase: () => "/tmp",
  profiles: () => [],
};

test("default session registers task and search_agents", async () => {
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
    sessionMode: "orchestrator",
    subAgent: subAgentDeps,
  });
  const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
  expect(names).toContain("task");
  expect(names).toContain("search_agents");
});

test("headless MCP connection does not wait for interactive OAuth", async () => {
  mockConnectMCPServer.mockClear();
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: fakePermissionGate,
    onOperatorGate: async () => ({ kind: "cancel" }),
    mcpServers: [{ name: "granola", url: "https://example.test/mcp" }],
    mcpServersSource: "global",
  });

  await toolset.connectMCP({
    interactiveAuth: false,
    onStatus: () => {},
    onToolsChanged: () => {},
  });

  expect(mockConnectMCPServer).toHaveBeenCalledTimes(1);
  expect(mockConnectMCPServer.mock.calls[0]?.[1]?.onAuthURL).toBeUndefined();
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
