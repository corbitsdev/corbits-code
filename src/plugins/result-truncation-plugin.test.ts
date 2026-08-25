import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import { createBlobReader, type StrategyContext, type ToolResult } from "@intx/types/runtime";
import {
  MAX_RESULT_CHARS,
  resultTruncationPlugin,
  spillBlobKey,
  truncateToolResultContent,
} from "./result-truncation-plugin.js";
import { toolOutputAbsolutePath } from "./tool-result-materialize.js";
import { CREDENTIAL_REDACTION } from "./tool-result-secret-scrub.js";
import { toolResultSecretScrubPlugin } from "./tool-result-secret-scrub-plugin.js";
import type { ToolPlugin } from "@intx/tools-posix";

/** In-memory stand-in for ContextStore's writeBlob/readBlob pair, for tests. */
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

describe("truncateToolResultContent", () => {
  test("within-cap content passes through unchanged", async () => {
    const content = "x".repeat(100);
    expect(await truncateToolResultContent(content)).toBe(content);
  });

  test("under-gate minified JSON is left unchanged (no pretty, no spill)", async () => {
    const store = fakeBlobStore();
    const minified = JSON.stringify({ a: 1, b: 2 });
    expect(minified.length).toBeLessThan(MAX_RESULT_CHARS);
    const out = await truncateToolResultContent(minified, MAX_RESULT_CHARS, {
      callId: "call-small",
      writeBlob: store.writeBlob,
    });
    expect(out).toBe(minified);
    expect(store.blobs.size).toBe(0);
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

  test("the inlined portion stays within the cap (notice reserved inside the budget)", async () => {
    const content = "x".repeat(MAX_RESULT_CHARS * 3);
    const truncated = await truncateToolResultContent(content);
    // Notice is reserved before slicing so the reactor 10k size-cap cannot strip it.
    expect(truncated.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(truncated).toContain("[output truncated");
  });

  describe("with a blob store", () => {
    test("a result over the cap is fully recoverable by following the notice's read_file instructions verbatim", async () => {
      const store = fakeBlobStore();
      const original = `${"x".repeat(MAX_RESULT_CHARS)}TAIL-MARKER-${"y".repeat(500)}`;
      const truncated = await truncateToolResultContent(original, MAX_RESULT_CHARS, {
        callId: "call-42",
        writeBlob: store.writeBlob,
      });

      // Inline content is within the reactor cap and does not itself contain the discarded tail.
      expect(truncated).not.toContain("TAIL-MARKER");
      expect(truncated.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);

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

    test("minified JSON over the gate is pretty-spilled as application/json", async () => {
      const store = fakeBlobStore();
      // Build a compact object whose minified form exceeds the 10k gate.
      const obj: Record<string, string> = {};
      for (let i = 0; i < 400; i++) {
        obj[`key_${i}`] = `value_${i}_${"x".repeat(20)}`;
      }
      const minified = JSON.stringify(obj);
      expect(minified.length).toBeGreaterThan(MAX_RESULT_CHARS);
      const pretty = JSON.stringify(obj, null, 2);

      const truncated = await truncateToolResultContent(minified, MAX_RESULT_CHARS, {
        callId: "call-json",
        writeBlob: store.writeBlob,
        contextDir: "/tmp/session/context",
      });

      const key = spillBlobKey("call-json");
      const entry = store.blobs.get(key);
      expect(entry).toBeDefined();
      expect(entry?.contentType).toBe("application/json");
      expect(new TextDecoder().decode(entry!.bytes)).toBe(pretty);

      const uri = `tool-output:///${key}`;
      const abs = toolOutputAbsolutePath("/tmp/session/context", key, "application/json");
      expect(truncated).toContain(uri);
      expect(truncated).toContain(abs);
      expect(truncated).toContain("application/json");
      expect(truncated).not.toContain(pretty.slice(-40));
    });

    test("oversized JSON with an escaped secret is scrubbed after pretty materialization", async () => {
      const store = fakeBlobStore();
      const escapedSecret = `sk-\\u006cive-${"a".repeat(24)}`;
      const minified = `{"secret":"${escapedSecret}","pad":"${"x".repeat(MAX_RESULT_CHARS)}"}`;
      expect(minified).not.toContain("sk-live-");

      const truncated = await truncateToolResultContent(minified, MAX_RESULT_CHARS, {
        callId: "call-json-secret",
        writeBlob: store.writeBlob,
      });

      const spilled = new TextDecoder().decode(
        store.blobs.get(spillBlobKey("call-json-secret"))!.bytes,
      );
      expect(truncated).toContain(CREDENTIAL_REDACTION);
      expect(truncated).not.toContain("sk-live-");
      expect(spilled).toContain(CREDENTIAL_REDACTION);
      expect(spilled).not.toContain("sk-live-");
      expect(spilled).not.toContain(escapedSecret);
    });

    test("NDJSON over the gate is spilled unchanged as application/x-ndjson", async () => {
      const store = fakeBlobStore();
      const lines = Array.from({ length: 200 }, (_, i) =>
        JSON.stringify({ i, pad: "y".repeat(80) }),
      );
      const ndjson = `${lines.join("\n")}\n`;
      expect(ndjson.length).toBeGreaterThan(MAX_RESULT_CHARS);

      const truncated = await truncateToolResultContent(ndjson, MAX_RESULT_CHARS, {
        callId: "call-ndjson",
        writeBlob: store.writeBlob,
      });

      const key = spillBlobKey("call-ndjson");
      const entry = store.blobs.get(key);
      expect(entry?.contentType).toBe("application/x-ndjson");
      expect(new TextDecoder().decode(entry!.bytes)).toBe(ndjson);
      expect(truncated).toContain("application/x-ndjson");
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
      "leisure notice (URI + session path) survives the reactor 10k size-cap " +
        "(CL-7055: reserved notice keeps inline result within-cap)",
      async () => {
        const store = fakeBlobStore();
        const contextDir = "/tmp/session/context";
        const original = "p".repeat(50_000);
        const truncated = await truncateToolResultContent(original, MAX_RESULT_CHARS, {
          callId: "call-1",
          writeBlob: store.writeBlob,
          contextDir,
        });

        const key = spillBlobKey("call-1");
        const uri = `tool-output:///${key}`;
        const abs = toolOutputAbsolutePath(contextDir, key, "text/plain");
        expect(truncated.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
        expect(truncated).toContain(uri);
        expect(truncated).toContain(abs);

        // Production pipeline: leisure middleware → reactor size-cap (always on, 10k).
        const reactorCap = createSizeCapTransform({
          maxChars: 10_000,
          contextStore: { writeBlob: store.writeBlob },
        });
        const result: ToolResult = { callId: "call-1", content: truncated, isError: false };
        const capped = await reactorCap.apply(
          { call: { id: "call-1", name: "run_shell", arguments: {} }, result },
          {} as StrategyContext,
        );

        const modelFacing = String(capped.output.content);
        expect(modelFacing).toContain(uri);
        expect(modelFacing).toContain(abs);
        expect(modelFacing).toContain(":full");
        // Within-cap → reactor must not replace the leisure notice with its own.
        expect(modelFacing).not.toContain("Tool output truncated");
        expect(store.blobs.has("call-1")).toBe(false);

        const blobReader = createBlobReader(store);
        const recovered = new TextDecoder().decode(await blobReader.read(uri));
        expect(recovered).toBe(original);
        expect(recovered.length).toBe(50_000);
      },
    );

    test("a same-keyed reactor spill cannot clobber the :full blob (CL-6908)", async () => {
      const store = fakeBlobStore();
      const original = "p".repeat(50_000);
      await truncateToolResultContent(original, MAX_RESULT_CHARS, {
        callId: "call-1",
        writeBlob: store.writeBlob,
      });

      // Simulate a lossy same-id write the reactor would do on an over-cap result.
      await store.writeBlob("call-1", new TextEncoder().encode("LOSSY"), "text/plain");

      const blobReader = createBlobReader(store);
      const recovered = new TextDecoder().decode(
        await blobReader.read(`tool-output:///${spillBlobKey("call-1")}`),
      );
      expect(recovered).toBe(original);
      expect(new TextDecoder().decode(store.blobs.get("call-1")!.bytes)).toBe("LOSSY");
    });
  });
});

describe("resultTruncationPlugin", () => {
  test("spills oversized run_shell/grep/search_files/web_fetch results via the live getBlobWriter getter", async () => {
    const store = fakeBlobStore();
    const original = "q".repeat(MAX_RESULT_CHARS + 200);
    const plugin = resultTruncationPlugin({
      getBlobWriter: () => store.writeBlob,
      getContextDir: () => "/session/context",
    });
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
    expect(result.content).toContain(
      toolOutputAbsolutePath("/session/context", spillBlobKey("call-99"), "text/plain"),
    );
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

  test("pretty-serializes then spills an oversized Record content", async () => {
    const store = fakeBlobStore();
    const record: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) {
      record[`k${i}`] = `v${i}_${"z".repeat(20)}`;
    }
    expect(JSON.stringify(record).length).toBeGreaterThan(MAX_RESULT_CHARS);

    const plugin = resultTruncationPlugin({ getBlobWriter: () => store.writeBlob });
    if (plugin.middleware === undefined) throw new Error("expected middleware");
    const middleware = plugin.middleware(async (call) => ({
      callId: call.id,
      content: record,
    }));

    const result = await middleware(
      { id: "call-rec", name: "web_fetch", arguments: {} },
      new AbortController().signal,
    );

    expect(typeof result.content).toBe("string");
    const key = spillBlobKey("call-rec");
    const entry = store.blobs.get(key);
    expect(entry?.contentType).toBe("application/json");
    expect(new TextDecoder().decode(entry!.bytes)).toBe(JSON.stringify(record, null, 2));
  });

  test("under-gate Record content is left unchanged", async () => {
    const store = fakeBlobStore();
    const record = { ok: true, n: 1 };
    const plugin = resultTruncationPlugin({ getBlobWriter: () => store.writeBlob });
    if (plugin.middleware === undefined) throw new Error("expected middleware");
    const middleware = plugin.middleware(async (call) => ({
      callId: call.id,
      content: record,
    }));
    const result = await middleware(
      { id: "call-rec-small", name: "web_fetch", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toEqual(record);
    expect(store.blobs.size).toBe(0);
  });
});

describe("scrub-before-spill", () => {
  test("secret scrub runs on the full content before truncation spills", async () => {
    const store = fakeBlobStore();
    // Compose the same order as buildCorePosixToolPlugins: truncation outer,
    // scrub inner — so scrub sees the full payload and the spill is redacted.
    // Put the credential near the start so the kept (≤10k) slice also proves scrub
    // ran; a secret past the cut would only show up in the spill.
    const secret = `prefix sk-live-${"a".repeat(24)} ${"x".repeat(MAX_RESULT_CHARS)} suffix`;
    const scrub: ToolPlugin = toolResultSecretScrubPlugin();
    const trunc: ToolPlugin = resultTruncationPlugin({ getBlobWriter: () => store.writeBlob });
    if (scrub.middleware === undefined || trunc.middleware === undefined) {
      throw new Error("expected middleware");
    }

    const inner = scrub.middleware(async (call) => ({
      callId: call.id,
      content: secret,
    }));
    const outer = trunc.middleware(inner);

    const result = await outer(
      { id: "call-scrub", name: "run_shell", arguments: {} },
      new AbortController().signal,
    );

    expect(String(result.content)).toContain(CREDENTIAL_REDACTION);
    expect(String(result.content)).not.toContain("sk-live-");

    const spilled = new TextDecoder().decode(store.blobs.get(spillBlobKey("call-scrub"))!.bytes);
    expect(spilled).toContain(CREDENTIAL_REDACTION);
    expect(spilled).not.toContain("sk-live-");
  });
});
