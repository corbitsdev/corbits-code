import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobReader } from "@intx/types/runtime";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  READ_FILE_DEFAULT_MAX_LINES,
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LINE_LENGTH,
  READ_FILE_MAX_SCAN_BYTES,
  READ_FILE_MAX_TOOL_OUTPUT_BYTES,
  readBytesBounded,
  readFileBounded,
  readFileGuardPlugin,
} from "./read-file-guard-plugin.js";

const neverAbort = () => new AbortController().signal;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "read-guard-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, content: string | Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

describe("readFileBounded", () => {
  test("reads a small file fully with 1-indexed line numbers", async () => {
    const p = await fixture("small.txt", "alpha\nbeta\ngamma");
    const { content, isError } = await readFileBounded(p, 0, 2000, neverAbort());
    expect(isError).toBeUndefined();
    expect(content).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  test("caps output at a hard byte ceiling without reading the whole file", async () => {
    // Long lines so the byte cap trips before the 2000-line cap.
    const big = Array.from({ length: 5_000 }, () => "x".repeat(200)).join("\n");
    const p = await fixture("big.txt", big);
    const { content } = await readFileBounded(p, 0, READ_FILE_DEFAULT_MAX_LINES, neverAbort());
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(READ_FILE_MAX_BYTES);
    expect(content).toContain("output limit");
    expect(content).toContain("Use offset=");
  });

  test("default line cap stops at DEFAULT_MAX_LINES for short lines", async () => {
    const many = Array.from({ length: 5_000 }, () => "x").join("\n");
    const p = await fixture("many.txt", many);
    const { content } = await readFileBounded(p, 0, READ_FILE_DEFAULT_MAX_LINES, neverAbort());
    const body = content.split("\n\n")[0] ?? "";
    const lineCount = body.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(READ_FILE_DEFAULT_MAX_LINES);
    expect(content).toContain("line limit");
  });

  test("offset is a zero-based skip count matching stock read_file", async () => {
    const p = await fixture("offset.txt", "one\ntwo\nthree\nfour");
    const { content } = await readFileBounded(p, 2, 2000, neverAbort());
    expect(content).toBe("     3\tthree\n     4\tfour");
  });

  test("offset beyond EOF is an error with the true line count", async () => {
    const p = await fixture("short.txt", "a\nb");
    const { content, isError } = await readFileBounded(p, 99, 2000, neverAbort());
    expect(isError).toBe(true);
    expect(content).toContain("beyond end of file");
    expect(content).toContain("(2 lines)");
  });

  test("truncates an overlong single line", async () => {
    const p = await fixture("long-line.txt", "z".repeat(10_000));
    const { content } = await readFileBounded(p, 0, 2000, neverAbort());
    expect(content).toContain("line truncated");
    expect(content.length).toBeLessThan(READ_FILE_MAX_LINE_LENGTH + 200);
  });

  test("rejects a binary file whose NUL is in the first chunk", async () => {
    const p = await fixture("binary.bin", Buffer.from([0x41, 0x00, 0x42]));
    const { content, isError } = await readFileBounded(p, 0, 2000, neverAbort());
    expect(isError).toBe(true);
    expect(content).toContain("binary");
  });

  test("a NUL deep in an otherwise-valid file does not discard streamed content", async () => {
    // Enough valid text (>64KB) to guarantee the NUL lands in a later chunk.
    const head = Array.from({ length: 10_000 }, (_, i) => `valid-line-${i}`).join("\n");
    const p = await fixture(
      "late-nul.bin",
      Buffer.concat([Buffer.from(`${head}\n`, "utf8"), Buffer.from([0x00]), Buffer.from("\ntail")]),
    );
    const { content, isError } = await readFileBounded(p, 0, 500_000, neverAbort());
    expect(isError).toBeUndefined();
    expect(content).toContain("valid-line-0");
    // Contract: a NUL past the first chunk is tolerated (streamed as text), not
    // rejected. Only a NUL in the first chunk marks the file binary.
  });

  test("a fully-read file emits no false continuation notice", async () => {
    // ~40KB, under the 50KB budget, all lines fit and the stream ends.
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} ${"z".repeat(80)}`).join("\n");
    const p = await fixture("fits.txt", body);
    const { content } = await readFileBounded(p, 0, READ_FILE_DEFAULT_MAX_LINES, neverAbort());
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(30_000);
    expect(content).not.toContain("Use offset=");
    expect(content).not.toContain("continue");
  });

  test("a newline-less file past the scan ceiling returns content, not empty", async () => {
    const giant = "a".repeat(READ_FILE_MAX_SCAN_BYTES + 1024);
    const p = await fixture("giant-line.txt", giant);
    const { content, isError } = await readFileBounded(p, 0, 2000, neverAbort());
    expect(isError).toBeUndefined();
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("     1\t");
    expect(content).toContain("scan limit");
  });

  test("abort rejects with read_file timeout guidance", async () => {
    const p = await fixture("abort.txt", "line one\nline two\n");
    const controller = new AbortController();
    controller.abort();
    let message = "";
    try {
      await readFileBounded(p, 0, 2000, controller.signal);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("[timed out before completing]");
    expect(message).toContain("not an empty file");
  });

  test("offset and limit slice in-memory tool-output bytes without loading all lines", async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join("\n");
    const bytes = new TextEncoder().encode(lines);
    const { content, isError } = await readBytesBounded(
      bytes,
      2,
      3,
      neverAbort(),
      "tool-output:///slice-test",
    );
    expect(isError).toBeUndefined();
    expect(content).toContain("line-2");
    expect(content).toContain("line-3");
    expect(content).toContain("line-4");
    expect(content).not.toContain("line-0");
    expect(content).not.toContain("line-5");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(READ_FILE_MAX_BYTES);
  });

  test("offset past the scan ceiling reports the scan limit, not a fake EOF", async () => {
    // Many short lines totaling more than the scan ceiling; a huge offset can
    // never be reached within one scan pass.
    const line = `${"y".repeat(80)}\n`;
    const count = Math.ceil((READ_FILE_MAX_SCAN_BYTES + 1_000_000) / line.length);
    const p = await fixture("wide.txt", line.repeat(count));
    const { content, isError } = await readFileBounded(p, 50_000_000, 2000, neverAbort());
    expect(isError).toBe(true);
    expect(content).toContain("scan limit");
    expect(content).not.toContain("beyond end of file");
  });
});

describe("readFileGuardPlugin", () => {
  const fallback = async (call: ToolCall): Promise<ToolResult> => ({
    callId: call.id,
    content: "FALLBACK",
  });

  function run(
    call: ToolCall,
    blobReader?: ReturnType<typeof createBlobReader>,
  ): Promise<ToolResult> {
    const plugin = readFileGuardPlugin(dir, blobReader !== undefined ? { blobReader } : {});
    return plugin.middleware!(fallback)(call, neverAbort());
  }

  test("intercepts read_file for real paths", async () => {
    await fixture("guarded.txt", "hello");
    const result = await run({ id: "r1", name: "read_file", arguments: { path: "guarded.txt" } });
    expect(result.content).toBe("     1\thello");
    expect(result.content).not.toBe("FALLBACK");
  });

  test("threads zero-based offset and limit through the middleware", async () => {
    await fixture("paged.txt", "l1\nl2\nl3\nl4\nl5");
    const result = await run({
      id: "r1b",
      name: "read_file",
      arguments: { path: "paged.txt", offset: 1, limit: 2 },
    });
    expect(result.content).toContain("     2\tl2");
    expect(result.content).toContain("     3\tl3");
    expect(result.content).not.toContain("     4\tl4");
    expect(result.content).toContain('Use path="tool-output:///');
    expect(result.content).not.toContain("Use offset=");
  });

  test("rejects tool-output URIs when no blob reader is configured", async () => {
    const result = await run({
      id: "r2",
      name: "read_file",
      arguments: { path: "tool-output:///call-123" },
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("no blob reader is configured");
  });

  test("bounds tool-output blobs with offset and limit when a blob reader is configured", async () => {
    const encoder = new TextEncoder();
    const body = Array.from({ length: 8_000 }, (_, i) => `row-${i}`).join("\n");
    const blobReader = createBlobReader({
      async readBlob(key) {
        if (key === "big") return encoder.encode(body);
        throw new Error(`missing ${key}`);
      },
    });
    const result = await run(
      {
        id: "r2b",
        name: "read_file",
        arguments: { path: "tool-output:///big", offset: 10, limit: 2 },
      },
      blobReader,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("row-10");
    expect(result.content).toContain("row-11");
    expect(result.content).not.toContain("row-9");
    expect(result.content).not.toContain("row-12");
    expect(result.content).not.toBe("FALLBACK");
  });

  test("pages tool-output blobs above the display ceiling instead of rejecting the spill", async () => {
    const encoder = new TextEncoder();
    const huge = encoder.encode("x".repeat(READ_FILE_MAX_TOOL_OUTPUT_BYTES + 1));
    const blobReader = createBlobReader({
      async readBlob() {
        return huge;
      },
    });
    const result = await run(
      {
        id: "r2c",
        name: "read_file",
        arguments: { path: "tool-output:///huge", limit: 5 },
      },
      blobReader,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("x");
    expect(result.content).not.toBe("FALLBACK");
  });

  test("delegates missing files to the stock handler", async () => {
    const result = await run({
      id: "r3",
      name: "read_file",
      arguments: { path: "does-not-exist.txt" },
    });
    expect(result.content).toBe("FALLBACK");
  });

  test("delegates directories to the stock handler", async () => {
    const result = await run({ id: "r3b", name: "read_file", arguments: { path: "." } });
    expect(result.content).toBe("FALLBACK");
  });

  test("ignores non-read_file calls", async () => {
    const result = await run({ id: "r4", name: "grep", arguments: { pattern: "x" } });
    expect(result.content).toBe("FALLBACK");
  });

  test("a truncated read never asks the model to re-read the same path (CL-6961)", async () => {
    await fixture("many-lines.txt", Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"));
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = plugin.middleware!(fallback);
    const result = await middleware(
      { id: "c1", name: "read_file", arguments: { path: "many-lines.txt", limit: 4 } },
      neverAbort(),
    );
    expect(result.content).not.toContain("Use offset=");
    expect(String(result.content)).toContain('Use path="tool-output:///');
    // The literal source path never reappears as the thing to read next.
    expect(String(result.content)).not.toContain("many-lines.txt");
  });

  test("following the minted cursor resumes and eventually reads a large file to completion without any repeat call on the original path (CL-6961)", async () => {
    const lines = Array.from({ length: 9_000 }, (_, i) => `line-${i} payload`);
    await fixture("huge.txt", lines.join("\n"));
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = plugin.middleware!(fallback);

    const pathsRead: string[] = ["huge.txt"];
    let result = await middleware(
      { id: "c1", name: "read_file", arguments: { path: "huge.txt" } },
      neverAbort(),
    );
    let seen = 0;
    let guard = 0;
    for (;;) {
      guard++;
      expect(guard).toBeLessThan(50); // fails loudly instead of hanging on a broken cursor chain
      const content = String(result.content);
      const numbered = content.split("\n\n")[0] ?? "";
      seen += numbered.trimEnd().split("\n").length;

      const match = /Use path="(tool-output:\/\/\/[^"]+)"/.exec(content);
      if (match === undefined || match === null) break;
      const nextPath = match[1] as string;
      expect(pathsRead).not.toContain(nextPath); // every hop targets a fresh, distinct path
      pathsRead.push(nextPath);

      result = await middleware(
        { id: `c${pathsRead.length}`, name: "read_file", arguments: { path: nextPath } },
        neverAbort(),
      );
    }

    expect(seen).toBe(lines.length);
    expect(pathsRead.length).toBeGreaterThan(1); // it actually paginated
    // Never told to re-issue a call against the literal original path.
    expect(pathsRead.filter((p) => p === "huge.txt").length).toBe(1);
  });

  test("a stale (already-consumed) cursor names the original path and offset instead of a dead end", async () => {
    const absolutePath = await fixture(
      "stale.txt",
      Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
    );
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = plugin.middleware!(fallback);
    const first = await middleware(
      { id: "s1", name: "read_file", arguments: { path: "stale.txt", limit: 4 } },
      neverAbort(),
    );
    const match = /Use path="(tool-output:\/\/\/[^"]+)"/.exec(String(first.content));
    expect(match).not.toBeNull();
    const cursorPath = (match as RegExpExecArray)[1] as string;

    await middleware({ id: "s2", name: "read_file", arguments: { path: cursorPath } }, neverAbort());
    // Second use of the same, already-consumed cursor: distinct from a
    // generic missing-blob error, this must name a followable next step —
    // the original source and the offset to resume from — rather than
    // leaving the model to re-read the whole file from scratch.
    const replay = await middleware(
      { id: "s3", name: "read_file", arguments: { path: cursorPath } },
      neverAbort(),
    );
    expect(replay.isError).toBe(true);
    expect(String(replay.content)).toContain("already used");
    expect(String(replay.content)).toContain(absolutePath);
    expect(String(replay.content)).toMatch(/offset=4\b/);
  });

  test("an unknown tool-output URI against a real blobReader gets the production 'blob not found' error, not a stale-cursor message", async () => {
    const blobReader = {
      async read(uri: string): Promise<Uint8Array> {
        throw new Error(`Blob not found for key: ${uri}`);
      },
    };
    const result = await run(
      { id: "u1", name: "read_file", arguments: { path: "tool-output:///never-minted" } },
      blobReader,
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Blob not found for key");
    // Never a cursor's own wording, since this ID was never one of ours.
    expect(String(result.content)).not.toContain("already used");
  });

  test("a stale cursor short-circuits before reaching a real blobReader's production 'blob not found' error", async () => {
    const encoder = new TextEncoder();
    const body = Array.from({ length: 8_000 }, (_, i) => `row-${i}`).join("\n");
    const blobReader = {
      async read(uri: string): Promise<Uint8Array> {
        if (uri === "tool-output:///spill-1") return encoder.encode(body);
        throw new Error(`Blob not found for key: ${uri}`);
      },
    };
    const plugin = readFileGuardPlugin(dir, { blobReader });
    const middleware = plugin.middleware!(fallback);

    const first = await middleware(
      { id: "b1", name: "read_file", arguments: { path: "tool-output:///spill-1", limit: 5 } },
      neverAbort(),
    );
    const match = /Use path="(tool-output:\/\/\/[^"]+)"/.exec(String(first.content));
    expect(match).not.toBeNull();
    const cursorPath = (match as RegExpExecArray)[1] as string;

    await middleware({ id: "b2", name: "read_file", arguments: { path: cursorPath } }, neverAbort());
    // Replaying the consumed cursor must not fall through to blobReader.read()
    // (which would throw the opaque "Blob not found" error naming only the
    // random cursor UUID) -- it must short-circuit to the actionable message
    // naming the real spill URI and the offset to resume from.
    const replay = await middleware(
      { id: "b3", name: "read_file", arguments: { path: cursorPath } },
      neverAbort(),
    );
    expect(replay.isError).toBe(true);
    expect(String(replay.content)).toContain("already used");
    expect(String(replay.content)).toContain("tool-output:///spill-1");
    expect(String(replay.content)).not.toContain("Blob not found");
  });
});
