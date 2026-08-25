import { describe, test, expect } from "bun:test";
import { mcpClientToAgentTools } from "./plugin.js";
import { createPermissionGate } from "../permission/gate.js";
import { MAX_RESULT_CHARS, spillBlobKey } from "../plugins/result-truncation-plugin.js";
import { toolOutputAbsolutePath } from "../plugins/tool-result-materialize.js";
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

function fakeBlobStore() {
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    blobs,
    writeBlob: async (key: string, bytes: Uint8Array, contentType: string) => {
      blobs.set(key, { bytes, contentType });
    },
  };
}

function skipGate() {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    cwd: process.cwd(),
  });
}

describe("mcpClientToAgentTools", () => {
  test("scrubs a credential-shaped MCP result the same as built-in tools", async () => {
    const gate = skipGate();
    const client = fakeClient("here is the key: sk-live-abc123abcdefghijklmnopqrst");
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
    const gate = skipGate();
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

  test("pretty-spills oversized minified JSON with contextDir in the notice", async () => {
    const gate = skipGate();
    const store = fakeBlobStore();
    const contextDir = "/tmp/session/context";

    const obj: Record<string, string> = {};
    for (let i = 0; i < 400; i++) {
      obj[`key_${i}`] = `value_${i}_${"x".repeat(20)}`;
    }
    const minified = JSON.stringify(obj);
    expect(minified.length).toBeGreaterThan(MAX_RESULT_CHARS);
    const pretty = JSON.stringify(obj, null, 2);

    const client = fakeClient(minified);
    const [tool] = mcpClientToAgentTools(client, gate, {
      getBlobWriter: () => store.writeBlob,
      getContextDir: () => contextDir,
    });
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      { id: "c-mcp-json", name: "mcp__acme__fetch_secret", arguments: {} },
      new AbortController().signal,
    );

    const key = spillBlobKey("c-mcp-json");
    const entry = store.blobs.get(key);
    expect(entry).toBeDefined();
    expect(entry?.contentType).toBe("application/json");
    expect(new TextDecoder().decode(entry!.bytes)).toBe(pretty);

    const uri = `tool-output:///${key}`;
    const abs = toolOutputAbsolutePath(contextDir, key, "application/json");
    expect(result.content).toContain(uri);
    expect(result.content).toContain(abs);
    expect(result.content).toContain("application/json");
    expect(result.content).toContain("output truncated");
  });

  test("scrubs escaped secrets after oversized JSON pretty materialization", async () => {
    const gate = skipGate();
    const store = fakeBlobStore();
    const escapedSecret = `sk-\\u006cive-${"b".repeat(24)}`;
    const minified = `{"secret":"${escapedSecret}","pad":"${"x".repeat(MAX_RESULT_CHARS)}"}`;
    expect(minified).not.toContain("sk-live-");

    const client = fakeClient(minified);
    const [tool] = mcpClientToAgentTools(client, gate, {
      getBlobWriter: () => store.writeBlob,
    });
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      {
        id: "c-mcp-json-secret",
        name: "mcp__acme__fetch_secret",
        arguments: {},
      },
      new AbortController().signal,
    );

    const spilled = new TextDecoder().decode(
      store.blobs.get(spillBlobKey("c-mcp-json-secret"))!.bytes,
    );
    expect(result.content).toContain(CREDENTIAL_REDACTION);
    expect(result.content).not.toContain("sk-live-");
    expect(spilled).toContain(CREDENTIAL_REDACTION);
    expect(spilled).not.toContain("sk-live-");
    expect(spilled).not.toContain(escapedSecret);
  });

  test("spills oversized plain text under :full and names contextDir path", async () => {
    const gate = skipGate();
    const store = fakeBlobStore();
    const contextDir = "/session/context";
    const huge = "z".repeat(MAX_RESULT_CHARS + 500);
    const client = fakeClient(huge);
    const [tool] = mcpClientToAgentTools(client, gate, {
      getBlobWriter: () => store.writeBlob,
      getContextDir: () => contextDir,
    });
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      { id: "c-mcp-txt", name: "mcp__acme__fetch_secret", arguments: {} },
      new AbortController().signal,
    );

    const key = spillBlobKey("c-mcp-txt");
    const entry = store.blobs.get(key);
    expect(entry?.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(entry!.bytes)).toBe(huge);
    expect(result.content).toContain(`tool-output:///${key}`);
    expect(result.content).toContain(toolOutputAbsolutePath(contextDir, key, "text/plain"));
  });
});
