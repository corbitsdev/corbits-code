import { describe, expect, test } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createBlobReader, type ToolCall, type ToolResult } from "@intx/types/runtime";

import { createCodexToolProxies, type CodexRunManageTasks } from "../agent/codex-tool-proxies.js";
import {
  MAX_RESULT_CHARS,
  truncateToolResultContent,
} from "../plugins/result-truncation-plugin.js";
import { createCodexProxyRunTool } from "./run.js";

function fakeBlobStore() {
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    blobs,
    writeBlob: async (key: string, bytes: Uint8Array, contentType: string) => {
      blobs.set(key, { bytes, contentType });
    },
    readBlob: async (key: string) => {
      const entry = blobs.get(key);
      if (entry === undefined) throw new Error(`Blob not found: ${key}`);
      return entry.bytes;
    },
  };
}

const unusedManageTasks: CodexRunManageTasks = async () => ({ content: "unused" });

function extractToolOutputURI(content: unknown): string {
  const match = /tool-output:\/\/\/\S+/.exec(String(content));
  if (match === null) throw new Error(`missing tool-output URI in ${String(content)}`);
  return match[0].replace(/[.\]]+$/, "");
}

describe("createCodexProxyRunTool", () => {
  test("oversized proxied shell calls get distinct recoverable spill URIs", async () => {
    const store = fakeBlobStore();
    const outputs: [string, string] = [
      `${"a".repeat(MAX_RESULT_CHARS)}FIRST-TAIL`,
      `${"b".repeat(MAX_RESULT_CHARS)}SECOND-TAIL`,
    ];
    const seenCallIds: string[] = [];
    const posixTools = {
      run: async (call: ToolCall): Promise<ToolResult> => {
        seenCallIds.push(call.id);
        const index = seenCallIds.length - 1;
        return {
          callId: call.id,
          content: await truncateToolResultContent(outputs[index] ?? "", MAX_RESULT_CHARS, {
            callId: call.id,
            writeBlob: store.writeBlob,
          }),
        };
      },
    };

    const tools = createCodexToolProxies({
      isCodex: true,
      runTool: createCodexProxyRunTool(posixTools),
      readRawFile: async () => ({ content: "unused" }),
      runManageTasks: unusedManageTasks,
    });
    const runner = createToolRunner(tools);

    const first = await runner.run(
      { id: "outer-1", name: "shell", arguments: { command: "first" } },
      new AbortController().signal,
    );
    const second = await runner.run(
      { id: "outer-2", name: "shell", arguments: { command: "second" } },
      new AbortController().signal,
    );

    const firstURI = extractToolOutputURI(first.content);
    const secondURI = extractToolOutputURI(second.content);
    expect(firstURI).not.toBe(secondURI);
    expect(seenCallIds).toEqual(["codex-proxy-1", "codex-proxy-2"]);

    const reader = createBlobReader(store);
    expect(new TextDecoder().decode(await reader.read(firstURI))).toBe(outputs[0]);
    expect(new TextDecoder().decode(await reader.read(secondURI))).toBe(outputs[1]);
  });
});
