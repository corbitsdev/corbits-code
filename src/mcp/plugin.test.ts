import { defined } from "../../tests/helpers/defined.js";
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@intx/types/runtime";
import { mcpClientToAgentTools } from "./plugin.js";
import { createPermissionGate } from "../permission/gate.js";
import {
  MAX_RESULT_CHARS,
  spillBlobKey,
} from "../plugins/result-truncation-plugin.js";
import { toolOutputAbsolutePath } from "../plugins/tool-result-materialize.js";
import { CREDENTIAL_REDACTION } from "../plugins/tool-result-secret-scrub.js";
import { createCompactionArchive } from "../session/compaction-archive.js";
import type { MCPClient, MCPContentBlock } from "./client.js";

interface ScriptedMcpEnvelope {
  blocks: MCPContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function fakeEnvelopeClient(envelope: ScriptedMcpEnvelope): MCPClient {
  const client: MCPClient = {
    serverName: "acme",
    tools: [
      {
        name: "fetch_secret",
        description: "returns a value",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    call: async () => "",
    callBlocks: async () => envelope.blocks,
    close: async () => undefined,
  };
  // callResult is the new envelope channel (GREEN); absent on RED code.
  Object.assign(client, {
    callResult: async () => envelope,
  });
  return client;
}

async function runEnvelopeTool(
  envelope: ScriptedMcpEnvelope,
  callId: string,
  spillOptions?: Parameters<typeof mcpClientToAgentTools>[2],
) {
  const gate = skipGate();
  const client = fakeEnvelopeClient(envelope);
  const [tool] = mcpClientToAgentTools(client, gate, spillOptions);
  if (tool?.kind !== "full") throw new Error("expected full tool");
  return tool.handler(
    { id: callId, name: "mcp__acme__fetch_secret", arguments: {} },
    new AbortController().signal,
  );
}

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
    callBlocks: async () => [{ type: "text", text: reply }],
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

function memoryEvidenceArchive() {
  const blobs = new Map<string, Uint8Array>();
  const archive = createCompactionArchive({
    sessionId: "mcp-plugin-test",
    contextDir: mkdtempSync(join(tmpdir(), "mcp-plugin-archive-")),
    writeBlob: async (key, bytes) => {
      blobs.set(key, bytes);
    },
    readBlob: async (key) => {
      const bytes = blobs.get(key);
      if (bytes === undefined) throw new Error(`missing archive blob ${key}`);
      return bytes;
    },
  });
  return { archive, blobs };
}

function serializePersistedToolResultTurn(result: ToolResult): string {
  return JSON.stringify({
    role: "user",
    content: [
      {
        type: "tool_result",
        callId: result.callId,
        content: [{ type: "text", text: String(result.content) }],
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      },
    ],
    timestamp: 0,
  });
}

function skipGate() {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
    cwd: process.cwd(),
  });
}

describe("mcpClientToAgentTools", () => {
  test("scrubs a credential-shaped MCP result the same as built-in tools", async () => {
    const gate = skipGate();
    const client = fakeClient(
      "here is the key: sk-live-abc123abcdefghijklmnopqrst",
    );
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
    expect(new TextDecoder().decode(defined(entry).bytes)).toBe(pretty);

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
      defined(store.blobs.get(spillBlobKey("c-mcp-json-secret"))).bytes,
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
    expect(new TextDecoder().decode(defined(entry).bytes)).toBe(huge);
    expect(result.content).toContain(`tool-output:///${key}`);
    expect(result.content).toContain(
      toolOutputAbsolutePath(contextDir, key, "text/plain"),
    );
  });

  test("tool-level failure surfaces as an error result with text preserved", async () => {
    const result = await runEnvelopeTool(
      {
        blocks: [{ type: "text", text: "tool failed: bad input" }],
        isError: true,
      },
      "c-mcp-iserror-text",
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("tool failed: bad input");
  });

  test("tool-level failure with empty content still yields a failure message", async () => {
    const result = await runEnvelopeTool(
      { blocks: [], isError: true },
      "c-mcp-iserror-empty",
    );

    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBeGreaterThan(0);
  });

  test("structured-only result surfaces a scrubbed JSON string, not empty text", async () => {
    const result = await runEnvelopeTool(
      { blocks: [], structuredContent: { answer: 42 } },
      "c-mcp-structured-only",
    );

    expect(result.isError).toBeUndefined();
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("42");
    expect(result.detail).toEqual({ answer: 42 });
  });

  test("text plus structured content keeps the text and preserves structured detail", async () => {
    const result = await runEnvelopeTool(
      {
        blocks: [{ type: "text", text: "hello from tool" }],
        structuredContent: { answer: 42 },
      },
      "c-mcp-text-plus-structured",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("hello from tool");
    expect(result.detail).toEqual({ answer: 42 });
  });

  test("credential-shaped values inside structured content are redacted", async () => {
    const rawToken = ["sk-", "live-", "k".repeat(24)].join("");
    const result = await runEnvelopeTool(
      {
        blocks: [],
        structuredContent: { token: rawToken },
      },
      "c-mcp-structured-secret",
    );

    expect(result.detail).toEqual({ token: CREDENTIAL_REDACTION });
    expect(result.content).toContain(CREDENTIAL_REDACTION);
    expect(result.content).not.toContain(rawToken);
    expect(result.content).not.toContain("sk-live-");
    const detailJson = JSON.stringify(result.detail);
    expect(detailJson).toContain(CREDENTIAL_REDACTION);
    expect(detailJson).not.toContain(rawToken);
    expect(detailJson).not.toContain("sk-live-");
  });

  test("scrubs structured keys from detail, archive bytes, and model content", async () => {
    const topLevelKey = ["sk-", "live-", "a".repeat(24)].join("");
    const nestedKey = ["sk-", "live-", "b".repeat(24)].join("");
    const { archive, blobs } = memoryEvidenceArchive();
    const result = await runEnvelopeTool(
      {
        blocks: [{ type: "resource", [topLevelKey]: "block-value" }],
        isError: false,
        structuredContent: {
          [topLevelKey]: "top-level",
          nested: { [nestedKey]: "nested" },
        },
      },
      "c-mcp-structured-key-secret",
      { getEvidenceArchive: () => archive },
    );

    const detail = JSON.stringify(result.detail);
    const modelTurn = serializePersistedToolResultTurn(result);
    const archiveBytes = [...blobs.values()].map((bytes) =>
      new TextDecoder().decode(bytes),
    );
    const surfaces = [
      detail,
      String(result.content),
      modelTurn,
      ...archiveBytes,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(topLevelKey);
      expect(surface).not.toContain(nestedKey);
    }
    expect(detail).toContain(CREDENTIAL_REDACTION);
    expect(String(result.content)).toContain(CREDENTIAL_REDACTION);
    expect(modelTurn).toContain(CREDENTIAL_REDACTION);
    expect(archiveBytes.join("\n")).toContain(CREDENTIAL_REDACTION);
  });

  test("keeps oversized structured content full only in the evidence archive", async () => {
    const { archive } = memoryEvidenceArchive();
    const hugeValue = "x".repeat(MAX_RESULT_CHARS * 4);
    const result = await runEnvelopeTool(
      {
        blocks: [],
        isError: false,
        structuredContent: { hugeValue },
      },
      "c-mcp-oversized-detail",
      { getEvidenceArchive: () => archive },
    );

    expect(result.detail).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MAX_RESULT_CHARS + 256,
    );
    const serializedTurn = serializePersistedToolResultTurn(result);
    expect(serializedTurn.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 512);
    expect(serializedTurn).not.toContain(hugeValue);

    const [occurrence] = await archive.listOccurrences();
    if (occurrence === undefined) throw new Error("missing archive occurrence");
    const archived = JSON.parse(
      await archive.readAuthorizedPayload(occurrence.occurrenceId),
    ) as { structuredContent: { hugeValue: string } };
    expect(archived.structuredContent.hugeValue).toBe(hugeValue);
  });

  test("omits unserializable structured detail without failing text content", async () => {
    const result = await runEnvelopeTool(
      {
        blocks: [{ type: "text", text: "usable text" }],
        isError: false,
        structuredContent: { unsupported: 1n },
      },
      "c-mcp-unserializable-detail",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("usable text");
    expect(result.detail).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(MAX_RESULT_CHARS);
  });

  test("archives identical success and failure payloads with distinct isError", async () => {
    const { archive } = memoryEvidenceArchive();
    const envelope = {
      blocks: [{ type: "text", text: "same payload" }],
      structuredContent: { answer: 42 },
    };

    await runEnvelopeTool(
      { ...envelope, isError: false },
      "c-mcp-archive-success",
      { getEvidenceArchive: () => archive },
    );
    await runEnvelopeTool(
      { ...envelope, isError: true },
      "c-mcp-archive-failure",
      { getEvidenceArchive: () => archive },
    );

    const occurrences = await archive.listOccurrences();
    expect(occurrences).toHaveLength(2);
    const payloads = await Promise.all(
      occurrences.map(async (occurrence) =>
        JSON.parse(
          await archive.readAuthorizedPayload(occurrence.occurrenceId),
        ),
      ),
    );
    expect(payloads.map((payload) => payload.isError)).toEqual([false, true]);
  });

  test("falls back to legacy call when block and envelope methods are absent", async () => {
    let calls = 0;
    const client: MCPClient = {
      serverName: "legacy",
      tools: [
        {
          name: "echo",
          description: "returns legacy text",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      call: async () => {
        calls++;
        return "legacy response";
      },
      close: async () => undefined,
    };
    const [tool] = mcpClientToAgentTools(client, skipGate());
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      { id: "c-mcp-legacy", name: "mcp__legacy__echo", arguments: {} },
      new AbortController().signal,
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      callId: "c-mcp-legacy",
      content: "legacy response",
    });
  });

  test("thrown transport failures still surface as error results", async () => {
    const gate = skipGate();
    const client: MCPClient = {
      serverName: "acme",
      tools: [
        {
          name: "fetch_secret",
          description: "returns a value",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      call: async () => {
        throw new Error("transport exploded");
      },
      callBlocks: async () => {
        throw new Error("transport exploded");
      },
      close: async () => undefined,
    };
    Object.assign(client, {
      callResult: async () => {
        throw new Error("transport exploded");
      },
    });
    const [tool] = mcpClientToAgentTools(client, gate);
    if (tool?.kind !== "full") throw new Error("expected full tool");

    const result = await tool.handler(
      { id: "c-mcp-throw", name: "mcp__acme__fetch_secret", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("transport exploded");
  });
});
