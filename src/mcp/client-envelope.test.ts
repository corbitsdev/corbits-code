import { describe, expect, test } from "bun:test";
import { defined } from "../../tests/helpers/defined.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";
import { connectMCPServer } from "./client.js";

let scriptedCallToolResult: unknown = { content: [] };

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
    ...real,
    Client: class {
      async connect(): Promise<void> {
        return undefined;
      }
      async listTools(): Promise<{ tools: [] }> {
        return { tools: [] };
      }
      async callTool(): Promise<unknown> {
        return scriptedCallToolResult;
      }
      async close(): Promise<void> {
        return undefined;
      }
    },
  }),
);

describe("mcp client tool envelope", () => {
  test("callResult preserves isError and structuredContent from the SDK", async () => {
    scriptedCallToolResult = {
      content: [{ type: "text", text: "tool failed: bad input" }],
      isError: true,
      structuredContent: { reason: "bad input" },
    };
    const connected = await connectMCPServer(
      { name: "envelope", command: "true" },
      {},
    );
    if (!connected.ok) throw new Error("expected stdio connect to succeed");
    const envelope = await defined(
      connected.client.callResult,
      "mcp client callResult",
    )("do_thing", {}, new AbortController().signal);

    expect(envelope.isError).toBe(true);
    expect(envelope.blocks).toEqual([
      { type: "text", text: "tool failed: bad input" },
    ]);
    expect(envelope.structuredContent).toEqual({ reason: "bad input" });
    await connected.client.close();
  });

  test("legacy call still flattens text blocks", async () => {
    scriptedCallToolResult = {
      content: [{ type: "text", text: "hello" }],
    };
    const connected = await connectMCPServer(
      { name: "envelope", command: "true" },
      {},
    );
    if (!connected.ok) throw new Error("expected stdio connect to succeed");
    const text = await connected.client.call(
      "do_thing",
      {},
      new AbortController().signal,
    );

    expect(text).toBe("hello");
    await connected.client.close();
  });
});
