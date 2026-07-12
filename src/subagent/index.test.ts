import { describe, expect, test } from "bun:test";

import { createPermissionGate } from "../permission/gate.js";
import { createTaskTool, type RunSubAgentParams } from "./index.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

function callTask(tool: ReturnType<typeof createTaskTool>, args: Record<string, unknown>): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

describe("createTaskTool", () => {
  test("does not forward a parent turn limit to sub-agents", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      maxTurns: 25,
      run: async (params) => {
        captured = params;
        return "done";
      },
    } as Parameters<typeof createTaskTool>[0] & { maxTurns: number });

    const result = await callTask(tool, { description: "Investigate", prompt: "Do the work" });

    expect(result).toContain("done");
    expect(captured).toBeDefined();
    expect(captured).not.toHaveProperty("maxTurns");
  });

  test("forwards sandbox deps (permission gate and inherited MCP tools) to runSubAgent", async () => {
    const inherited = [{
      definition: { name: "mcp__srv__tool", description: "Test MCP tool", inputSchema: {} },
      kind: "string" as const,
      handler: async () => "ok",
    }];
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      inheritMcpTools: () => inherited,
      run: async (params) => {
        captured = params;
        return "done";
      },
    });

    await callTask(tool, { description: "MCP parity", prompt: "check tools" });

    expect(captured?.permissionGate).toBe(testPermissionGate);
    expect(captured?.inheritMcpTools?.()).toEqual(inherited);
  });
});
