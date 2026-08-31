import { test, expect, mock } from "bun:test";
import type { ToolDefinition, ToolCall } from "@intx/types/runtime";
import { TOOL_NAMES } from "@intx/tools-posix";
import { createPermissionGate } from "../../../src/permission/gate.js";
import type { PermissionGate } from "../../../src/permission/gate.js";
import { withMockedModule } from "../../helpers/mock-module.js";

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

// withMockedModule captures each real module and registers its own afterAll
// restore, so none of these mocks can outlive this file (Bun runs every test
// file in one process, and an un-restored mock.module silently replaces the
// real module for every file that runs after this one).
await withMockedModule(import.meta.resolve("@intx/tools-posix"), () => ({
  createPosixTools: () => mockPosixTools,
  TOOL_NAMES,
}));

await withMockedModule(import.meta.resolve("../../../src/agent/posix-tool-plugins.js"), () => ({
  buildCorePosixToolPlugins: () => [],
}));

const mockConnectMCPServer = mock(
  async (
    config: { name: string },
    _options?: import("../../../src/mcp/client.js").MCPConnectOptions,
  ) => ({
    ok: false as const,
    serverName: config.name,
    error: "not connected",
  }),
);

await withMockedModule(
  import.meta.resolve("../../../src/mcp/client.js"),
  (real: typeof import("../../../src/mcp/client.js")) => ({
    ...real,
    connectMCPServer: mockConnectMCPServer,
  }),
);

await withMockedModule(import.meta.resolve("../../../src/mcp/plugin.js"), () => ({
  mcpClientToAgentTools: () => [],
}));

await withMockedModule(import.meta.resolve("../../../src/plugins/path-escape-plugin.js"), () => ({
  pathEscapePlugin: () => ({}),
}));

await withMockedModule(import.meta.resolve("../../../src/plugins/authz-plugin.js"), () => ({
  authzPlugin: () => ({}),
}));

await withMockedModule(import.meta.resolve("../../../src/plugins/verify-plugin.js"), () => ({
  verifyPlugin: () => ({}),
}));

await withMockedModule(import.meta.resolve("../../../src/plugins/permission-plugin.js"), () => ({
  permissionPlugin: () => ({}),
  gateToolCall: async (
    _gate: unknown,
    call: ToolCall,
    signal: AbortSignal,
    next: (call: ToolCall, signal: AbortSignal) => Promise<unknown>,
  ) => next(call, signal),
}));

await withMockedModule(import.meta.resolve("../../../src/plugins/secret-guard-plugin.js"), () => ({
  secretGuardPlugin: () => ({}),
}));

await withMockedModule(import.meta.resolve("../../../src/plugins/shell-guard-plugin.js"), () => ({
  shellGuardPlugin: () => ({}),
  advertiseShellGuardTimeout: (defs: ToolDefinition[]) => defs,
}));

await withMockedModule(
  import.meta.resolve("../../../src/plugins/read-file-guard-plugin.js"),
  () => ({
    readFileGuardPlugin: () => ({}),
  }),
);

await withMockedModule(import.meta.resolve("../../../src/plugins/edit-file-line-range.js"), () => ({
  advertiseEditFileLineRange: (defs: ToolDefinition[]) => defs,
}));

await withMockedModule(import.meta.resolve("../../../src/agent/director.js"), () => ({
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
  submitOutputDefinition: {
    name: "submit_output",
    description: "Submit output",
    inputSchema: { type: "object", properties: {}, required: [] },
  } as ToolDefinition,
  createChatDirector: mock(() => ({})),
}));

const { createAgentToolset } = await import("../../../src/agent/tools.js");

const fakePermissionGate: PermissionGate = {
  evaluate: mock(async () => ({ allowed: true as const })),
  getApprovals: () => [],
  reset: () => {},
  getSessionApprovals: () => [],
  removeSessionApproval: () => {},
  setSeededApprovals: () => {},
  getAuto: () => false,
  setAuto: () => {},
  getSkipPermissions: () => false,
  setSkipPermissions: () => {},
  setProviderIdentity: () => {},
  registerMcpClient: mock(() => {}),
  unregisterMcpServer: mock(() => {}),
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
  // apply_patch is Codex-only and stripped on primary even when mounted.
  expect(names).not.toContain("apply_patch");
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

test("selecting Reject does not mint a shell grant even when command is declared", async () => {
  const gate = createPermissionGate({
    approvals: [],
    interactive: true,
    skipPermissions: false,
  });
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: gate,
    onOperatorGate: async () => ({ kind: "option", index: 1 }),
  });

  const chosen = await callOperator(toolset, {
    question: "Install dependencies?",
    options: ["Allow", "Reject"],
    command: "bun install",
  });

  expect(chosen).toBe("Reject");
  expect(gate.getSessionApprovals()).toEqual([]);
});

test("clarification choices do not mint shell grants", async () => {
  const gate = createPermissionGate({
    approvals: [],
    interactive: true,
    skipPermissions: false,
  });
  const toolset = await createAgentToolset({
    cwd: "/fake",
    permissionGate: gate,
    onOperatorGate: async () => ({ kind: "option", index: 0 }),
  });

  const chosen = await callOperator(toolset, {
    question: "Install dependencies?",
    options: ["Allow", "Reject"],
    command: "bun install",
  });

  expect(chosen).toBe("Allow");
  expect(gate.getSessionApprovals()).toEqual([]);
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
