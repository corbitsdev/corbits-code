import { describe, test, expect } from "bun:test";

import { createSizeCapTransform } from "./size-cap";
import type {
  ContextStore,
  ReactorState,
  StrategyContext,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";

function emptyState(): ReactorState {
  return {
    turns: [],
    activeForks: [],
    pendingOperations: [],
    activeGates: [],
    tokenUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    lastCycleUsage: null,
    lastCycleSource: null,
    sessionId: "test-session",
  };
}

function emptyContext(): StrategyContext {
  return { state: emptyState(), trigger: "test" };
}

function recordingWriteBlob(): {
  store: Pick<ContextStore, "writeBlob">;
  calls: { key: string; bytes: Uint8Array; contentType?: string }[];
} {
  const calls: { key: string; bytes: Uint8Array; contentType?: string }[] = [];
  const store: Pick<ContextStore, "writeBlob"> = {
    async writeBlob(key, bytes, contentType) {
      calls.push({
        key,
        bytes,
        ...(contentType !== undefined ? { contentType } : {}),
      });
    },
  };
  return { store, calls };
}

function call(id: string, name = "tool"): ToolCall {
  return { id, name, arguments: {} };
}

describe("createSizeCapTransform", () => {
  test("passes a within-cap result through unchanged with a within-cap record", async () => {
    const { store, calls } = recordingWriteBlob();
    const transform = createSizeCapTransform({
      maxChars: 100,
      contextStore: store,
    });

    const result: ToolResult = { callId: "c1", content: "hello world" };
    const out = await transform.apply(
      { call: call("c1"), result },
      emptyContext(),
    );

    expect(out.output).toBe(result);
    expect(out.record.strategy).toBe("size-cap");
    expect(out.record.reason).toBe("within-cap");
    expect(out.record.decisions["callId"]).toBe("c1");
    expect(out.record.decisions["length"]).toBe(11);
    expect(out.blobs).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("oversize result writes a blob and produces a truncated marker", async () => {
    const { store, calls } = recordingWriteBlob();
    const transform = createSizeCapTransform({
      maxChars: 10,
      contextStore: store,
    });

    const full = "x".repeat(50);
    const result: ToolResult = { callId: "callABC", content: full };
    const out = await transform.apply(
      { call: call("callABC"), result },
      emptyContext(),
    );

    expect(out.output).not.toBe(result);
    const content = out.output.content;
    if (typeof content !== "string") throw new Error("expected string content");
    expect(content.startsWith("xxxxxxxxxx\n")).toBe(true);
    expect(content).toContain("tool-output:///callABC");
    expect(content).toContain("omitted 40 chars");
    expect(out.record.strategy).toBe("size-cap");
    expect(out.record.reason).toBe("exceeded-cap");
    expect(out.record.decisions["callId"]).toBe("callABC");
    expect(out.record.decisions["originalLength"]).toBe(50);
    expect(out.record.decisions["kept"]).toBe(10);
    expect(out.record.decisions["spillKey"]).toBe("callABC");
    expect(out.record.decisions["spillURI"]).toBe("tool-output:///callABC");

    // Blob is emitted for the reactor to persist.
    expect(out.blobs).toBeDefined();
    expect(out.blobs).toHaveLength(1);
    expect(out.blobs?.[0]?.key).toBe("callABC");
    expect(out.blobs?.[0]?.contentType).toBe("text/plain");

    // The transform itself also wrote the blob through the supplied store
    // (so reactors that consume blobs from the chain stay consistent with
    // the transform's contract).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe("callABC");
    expect(calls[0]?.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(calls[0]?.bytes)).toBe(full);
  });

  test("structured (non-string) content is JSON-stringified before length check", async () => {
    const { store } = recordingWriteBlob();
    const transform = createSizeCapTransform({
      maxChars: 5,
      contextStore: store,
    });

    const result: ToolResult = {
      callId: "json-1",
      content: { hello: "world", n: 42 },
    };
    const out = await transform.apply(
      { call: call("json-1"), result },
      emptyContext(),
    );
    expect(out.record.reason).toBe("exceeded-cap");
  });

  test("preserves isError and detail on the transformed output", async () => {
    const { store } = recordingWriteBlob();
    const transform = createSizeCapTransform({
      maxChars: 4,
      contextStore: store,
    });

    const result: ToolResult = {
      callId: "x1",
      content: "abcdefghij",
      isError: true,
      detail: { stack: "..." },
    };
    const out = await transform.apply(
      { call: call("x1"), result },
      emptyContext(),
    );

    expect(out.output.isError).toBe(true);
    expect(out.output.detail).toEqual({ stack: "..." });
  });

  test("rejects non-positive maxChars at construction time", () => {
    const { store } = recordingWriteBlob();
    let thrown: Error | undefined;
    try {
      createSizeCapTransform({ maxChars: 0, contextStore: store });
    } catch (cause) {
      thrown = cause instanceof Error ? cause : new Error(String(cause));
    }
    expect(thrown?.message).toContain("positive finite");
  });

  test("passes a footer-bearing read_file page through even when over maxChars", async () => {
    const { store, calls } = recordingWriteBlob();
    const transform = createSizeCapTransform({
      maxChars: 10_000,
      contextStore: store,
    });

    const body = Array.from(
      { length: 3000 },
      (_, i) =>
        `${String(i + 1).padStart(6, " ")}\tcell-${String(i)}-${"v".repeat(50)}`,
    ).join("\n");
    const page =
      `${body}\n\n[Showing lines 1-3000; stopped at the 50KB output limit. ` +
      `Use offset=3000 to continue.]`;
    expect(page.length).toBeGreaterThan(10_000);
    expect(page).toContain("Use offset=");

    const result: ToolResult = { callId: "rf1", content: page };
    const out = await transform.apply(
      { call: call("rf1", "read_file"), result },
      emptyContext(),
    );

    expect(out.output).toBe(result);
    expect(out.output.content).toBe(page);
    expect(String(out.output.content)).toContain("Use offset=");
    expect(out.record.reason).toBe("paged-read-file");
    expect(out.blobs).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("still caps oversize read_file results that lack a continuation footer", async () => {
    const { store, calls } = recordingWriteBlob();
    const transform = createSizeCapTransform({
      maxChars: 10_000,
      contextStore: store,
    });

    const full = "x".repeat(12_000);
    const result: ToolResult = { callId: "rf2", content: full };
    const out = await transform.apply(
      { call: call("rf2", "read_file"), result },
      emptyContext(),
    );

    expect(out.record.reason).toBe("exceeded-cap");
    expect(String(out.output.content)).toContain("Tool output truncated");
    expect(String(out.output.content)).not.toContain("Use offset=");
    expect(calls).toHaveLength(1);
  });
});
