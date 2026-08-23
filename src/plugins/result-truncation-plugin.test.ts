import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import { createBlobReader, type StrategyContext, type ToolResult } from "@intx/types/runtime";
import {
  MAX_RESULT_CHARS,
  resultTruncationPlugin,
  spillBlobKey,
  truncateToolResultContent,
} from "./result-truncation-plugin.js";

/** In-memory stand-in for ContextStore's writeBlob/readBlob pair, for tests. */
function fakeBlobStore() {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    writeBlob: async (key: string, bytes: Uint8Array) => {
      blobs.set(key, bytes);
    },
    readBlob: async (key: string) => {
      const bytes = blobs.get(key);
      if (bytes === undefined) throw new Error(`Blob not found: ${key}`);
      return bytes;
    },
  };
}

describe("truncateToolResultContent", () => {
  test("within-cap content passes through unchanged", async () => {
    const content = "x".repeat(100);
    expect(await truncateToolResultContent(content)).toBe(content);
  });

  test("oversized content with no blob store gets a marker that never promises retrievable remainder", async () => {
    const content = "x".repeat(MAX_RESULT_CHARS + 500);
    const truncated = await truncateToolResultContent(content);

    expect(truncated).toContain("[output truncated");
    expect(truncated).toContain("NOT retrievable");
    // The pre-cap discard must never be described as recoverable elsewhere.
    expect(truncated).not.toContain("see the rest");
    expect(truncated).not.toContain("Full output available");
    // And it must never promise a lifetime it doesn't control either way.
    expect(truncated).not.toContain("removed");
    expect(truncated).not.toContain("session ends");
  });

  test("the inlined portion stays bounded regardless of blob-store support", async () => {
    const content = "x".repeat(MAX_RESULT_CHARS * 3);
    const truncated = await truncateToolResultContent(content);
    // The marker text itself adds a bounded amount of overhead on top of the cap.
    expect(truncated.length).toBeLessThan(MAX_RESULT_CHARS + 1000);
  });

  describe("with a blob store", () => {
    test("a result over the cap is fully recoverable by following the notice's read_file instructions verbatim", async () => {
      const store = fakeBlobStore();
      const original = `${"x".repeat(MAX_RESULT_CHARS)}TAIL-MARKER-${"y".repeat(500)}`;
      const truncated = await truncateToolResultContent(original, MAX_RESULT_CHARS, {
        callId: "call-42",
        writeBlob: store.writeBlob,
      });

      // Inline content is bounded and does not itself contain the discarded tail.
      expect(truncated).not.toContain("TAIL-MARKER");
      expect(truncated.length).toBeLessThan(MAX_RESULT_CHARS + 1000);

      const uriMatch = /tool-output:\/\/\/\S+/.exec(truncated);
      expect(uriMatch).not.toBeNull();
      const uri = uriMatch?.[0].replace(/[.\]]+$/, "") ?? "";
      expect(uri).toBe(`tool-output:///${spillBlobKey("call-42")}`);

      // Follow the notice's instructions literally: read_file with that URI,
      // via the real BlobReader machinery read_file itself uses.
      const blobReader = createBlobReader(store);
      const recoveredBytes = await blobReader.read(uri);
      const recovered = new TextDecoder().decode(recoveredBytes);
      expect(recovered).toBe(original);
      expect(recovered).toContain("TAIL-MARKER");
      expect(recovered.length).toBe(original.length);

      // No false lifetime claim: the blob is part of the committed session
      // history, not something with its own expiry.
      expect(truncated).not.toContain("removed");
      expect(truncated).not.toContain("session ends");
    });

    test("within-cap content never writes a blob", async () => {
      const store = fakeBlobStore();
      await truncateToolResultContent("x".repeat(100), MAX_RESULT_CHARS, {
        callId: "call-1",
        writeBlob: store.writeBlob,
      });
      expect(store.blobs.size).toBe(0);
    });

    test(
      "the full spill survives the reactor's own downstream size-cap transform " +
        "(CL-6908 regression: a same-keyed write here would let that second write clobber it)",
      async () => {
        const store = fakeBlobStore();
        const original = "p".repeat(500_000);
        const truncated = await truncateToolResultContent(original, MAX_RESULT_CHARS, {
          callId: "call-1",
          writeBlob: store.writeBlob,
        });

        // Reproduce the production pipeline: this middleware's ToolResult
        // continues into the reactor, which always runs its own size-cap
        // transform (vendor/intx-inference, default cap 10,000 chars) on
        // every result, keyed by the bare call id.
        const reactorCap = createSizeCapTransform({
          maxChars: 10_000,
          contextStore: { writeBlob: store.writeBlob },
        });
        const result: ToolResult = { callId: "call-1", content: truncated, isError: false };
        await reactorCap.apply(
          { call: { id: "call-1", name: "run_shell", arguments: {} }, result },
          {} as StrategyContext,
        );

        // The reactor wrote its own (lossy) blob under the bare "call-1" key.
        expect(store.blobs.has("call-1")).toBe(true);
        // Our full spill lives under a distinct key and is untouched.
        const blobReader = createBlobReader(store);
        const recovered = new TextDecoder().decode(
          await blobReader.read(`tool-output:///${spillBlobKey("call-1")}`),
        );
        expect(recovered).toBe(original);
        expect(recovered.length).toBe(500_000);
      },
    );
  });
});

describe("resultTruncationPlugin", () => {
  test("spills oversized run_shell/grep/search_files/web_fetch results via the live getBlobWriter getter", async () => {
    const store = fakeBlobStore();
    const original = "q".repeat(MAX_RESULT_CHARS + 200);
    const plugin = resultTruncationPlugin({ getBlobWriter: () => store.writeBlob });
    if (plugin.middleware === undefined) throw new Error("expected middleware");
    const middleware = plugin.middleware(async (call) => ({
      callId: call.id,
      content: original,
    }));

    const result = await middleware(
      { id: "call-99", name: "run_shell", arguments: {} },
      new AbortController().signal,
    );

    const uri = `tool-output:///${spillBlobKey("call-99")}`;
    expect(result.content).toContain(uri);
    const recovered = new TextDecoder().decode(await createBlobReader(store).read(uri));
    expect(recovered).toBe(original);
  });

  test("falls back to the honest no-store notice when getBlobWriter resolves undefined", async () => {
    const plugin = resultTruncationPlugin({ getBlobWriter: () => undefined });
    if (plugin.middleware === undefined) throw new Error("expected middleware");
    const middleware = plugin.middleware(async (call) => ({
      callId: call.id,
      content: "r".repeat(MAX_RESULT_CHARS + 1),
    }));
    const result = await middleware(
      { id: "call-1", name: "grep", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toContain("NOT retrievable");
  });
});
