import { describe, test, expect } from "bun:test";
import { mcpClientToAgentTools } from "./plugin.js";
import { createPermissionGate } from "../permission/gate.js";
import { CREDENTIAL_REDACTION } from "../plugins/tool-result-secret-scrub.js";
import type { MCPClient } from "./client.js";

function fakeClient(reply: string): MCPClient {
  return {
    serverName: "acme",
    tools: [
      {
        name: "fetch_secret",
        description: "returns a value",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    call: async () => reply,
    close: async () => undefined,
  };
}

describe("mcpClientToAgentTools", () => {
  test("scrubs a credential-shaped MCP result the same as built-in tools", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      cwd: process.cwd(),
    });
    const client = fakeClient("here is the key: sk-live-abc123xyz789012345678");
    const [tool] = mcpClientToAgentTools(client, gate);
    expect(tool?.kind).toBe("full");
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      { id: "c1", name: "mcp__acme__fetch_secret", arguments: {} },
      new AbortController().signal,
    );

    expect(result.content).toContain(CREDENTIAL_REDACTION);
    expect(result.content).not.toContain("sk-live-abc123");
  });

  test("truncates an oversized MCP result the same as built-in tools", async () => {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      cwd: process.cwd(),
    });
    const huge = "x".repeat(90_000);
    const client = fakeClient(huge);
    const [tool] = mcpClientToAgentTools(client, gate);
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      { id: "c2", name: "mcp__acme__fetch_secret", arguments: {} },
      new AbortController().signal,
    );

    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBeLessThan(huge.length);
    expect(result.content).toContain("output truncated");
  });
});
