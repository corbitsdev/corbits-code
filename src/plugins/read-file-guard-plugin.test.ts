import { defined } from "../../tests/helpers/defined.js";
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
import { resultTruncationPlugin } from "./result-truncation-plugin.js";

const neverAbort = () => new AbortController().signal;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "read-guard-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(
  name: string,
  content: string | Buffer,
): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

describe("readFileBounded", () => {
  test("reads a small file fully with 1-indexed line numbers", async () => {
    const p = await fixture("small.txt", "alpha\nbeta\ngamma");
    const { content, isError } = await readFileBounded(
      p,
      0,
      2000,
      neverAbort(),
    );
    expect(isError).toBeUndefined();
    expect(content).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  test("caps output at a hard byte ceiling without reading the whole file", async () => {
    // Long lines so the byte cap trips before the 2000-line cap.
    const big = Array.from({ length: 5_000 }, () => "x".repeat(200)).join("\n");
    const p = await fixture("big.txt", big);
    const { content } = await readFileBounded(
      p,
      0,
      READ_FILE_DEFAULT_MAX_LINES,
      neverAbort(),
    );
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      READ_FILE_MAX_BYTES,
    );
    expect(content).toContain("output limit");
    expect(content).toContain("Use offset=");
  });

  test("default line cap stops at DEFAULT_MAX_LINES for short lines", async () => {
    const many = Array.from({ length: 5_000 }, () => "x").join("\n");
    const p = await fixture("many.txt", many);
    const { content } = await readFileBounded(
      p,
      0,
      READ_FILE_DEFAULT_MAX_LINES,
      neverAbort(),
    );
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
    const { content, isError } = await readFileBounded(
      p,
      99,
      2000,
      neverAbort(),
    );
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
    const { content, isError } = await readFileBounded(
      p,
      0,
      2000,
      neverAbort(),
    );
    expect(isError).toBe(true);
    expect(content).toContain("binary");
  });

  test("a NUL deep in an otherwise-valid file does not discard streamed content", async () => {
    // Enough valid text (>64KB) to guarantee the NUL lands in a later chunk.
    const head = Array.from(
      { length: 10_000 },
      (_, i) => `valid-line-${i}`,
    ).join("\n");
    const p = await fixture(
      "late-nul.bin",
      Buffer.concat([
        Buffer.from(`${head}\n`, "utf8"),
        Buffer.from([0x00]),
        Buffer.from("\ntail"),
      ]),
    );
    const { content, isError } = await readFileBounded(
      p,
      0,
      500_000,
      neverAbort(),
    );
    expect(isError).toBeUndefined();
    expect(content).toContain("valid-line-0");
    // Contract: a NUL past the first chunk is tolerated (streamed as text), not
    // rejected. Only a NUL in the first chunk marks the file binary.
  });

  test("a fully-read file emits no false continuation notice", async () => {
    // ~40KB, under the 50KB budget, all lines fit and the stream ends.
    const body = Array.from(
      { length: 400 },
      (_, i) => `line ${i} ${"z".repeat(80)}`,
    ).join("\n");
    const p = await fixture("fits.txt", body);
    const { content } = await readFileBounded(
      p,
      0,
      READ_FILE_DEFAULT_MAX_LINES,
      neverAbort(),
    );
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(30_000);
    expect(content).not.toContain("Use offset=");
    expect(content).not.toContain("continue");
  });

  test("a newline-less file past the scan ceiling returns content, not empty", async () => {
    const giant = "a".repeat(READ_FILE_MAX_SCAN_BYTES + 1024);
    const p = await fixture("giant-line.txt", giant);
    const { content, isError } = await readFileBounded(
      p,
      0,
      2000,
      neverAbort(),
    );
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
    const lines = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join(
      "\n",
    );
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
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      READ_FILE_MAX_BYTES,
    );
  });

  test("pages a giant one-line blob by wrapping through the byte window", async () => {
    const giant = `HEAD-${"x".repeat(READ_FILE_MAX_BYTES)}-TAIL`;
    const bytes = new TextEncoder().encode(giant);
    const { content, isError } = await readBytesBounded(
      bytes,
      0,
      Number.POSITIVE_INFINITY,
      neverAbort(),
      "tool-output:///giant-line",
    );
    expect(isError).toBeUndefined();
    expect(content).toContain("HEAD-");
    expect(content).not.toContain("-TAIL");
    expect(content).not.toContain("line truncated");
    expect(content).toContain("output limit");
    expect(content).toContain("Use offset=");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      READ_FILE_MAX_BYTES,
    );
    const body = content.split("\n\n")[0] ?? "";
    const numbered = body.trimEnd().split("\n");
    expect(numbered.length).toBeGreaterThan(1);
    for (const line of numbered) {
      const text = line.replace(/^\s*\d+\t/, "");
      expect(text.length).toBeLessThanOrEqual(READ_FILE_MAX_LINE_LENGTH);
    }
  });

  test("returns a pretty-printed blob past the 2000-line file cap when it fits the byte window", async () => {
    const pretty = `${JSON.stringify(
      Array.from({ length: READ_FILE_DEFAULT_MAX_LINES + 500 }, (_, i) => i),
      null,
      2,
    )}\n`;
    const bytes = new TextEncoder().encode(pretty);
    const { content, isError } = await readBytesBounded(
      bytes,
      0,
      Number.POSITIVE_INFINITY,
      neverAbort(),
      "tool-output:///pretty-json",
    );
    expect(isError).toBeUndefined();
    const sourceLines = pretty.trimEnd().split("\n").length;
    expect(sourceLines).toBeGreaterThan(READ_FILE_DEFAULT_MAX_LINES);
    const body = content.split("\n\n")[0] ?? "";
    expect(body.trimEnd().split("\n").length).toBe(sourceLines);
    expect(content).toContain(String(READ_FILE_DEFAULT_MAX_LINES + 499));
    expect(content).not.toContain("line limit");
    expect(content).not.toContain("Use offset=");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      READ_FILE_MAX_BYTES,
    );
  });

  test("offset past the scan ceiling reports the scan limit, not a fake EOF", async () => {
    // Many short lines totaling more than the scan ceiling; a huge offset can
    // never be reached within one scan pass.
    const line = `${"y".repeat(80)}\n`;
    const count = Math.ceil(
      (READ_FILE_MAX_SCAN_BYTES + 1_000_000) / line.length,
    );
    const p = await fixture("wide.txt", line.repeat(count));
    const { content, isError } = await readFileBounded(
      p,
      50_000_000,
      2000,
      neverAbort(),
    );
    expect(isError).toBe(true);
    expect(content).toContain("scan limit");
    expect(content).not.toContain("beyond end of file");
  });
});

describe("CL-8979 large-file pagination", () => {
  const BIG_LINES = 45_000;
  const bigRow = (i: number): string => `L${i}-` + "p".repeat(243);

  async function bigFixture(name: string): Promise<string> {
    const rows = Array.from({ length: BIG_LINES }, (_, i) => bigRow(i));
    return fixture(name, `${rows.join("\n")}\n`);
  }

  function continueOffset(content: string): number | null {
    const match = /Use offset=(\d+) to continue/.exec(content);
    return match === null ? null : Number(match[1]);
  }

  function bodyRows(content: string): string[] {
    const body = content.split("\n\n")[0] ?? "";
    return body
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^\s*\d+\t/, ""));
  }

  function chainRunner(): (
    id: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult> {
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = plugin.middleware;
    if (middleware === undefined) throw new Error("expected middleware");
    const fallback = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: "FALLBACK",
    });
    return (id, args) =>
      middleware(fallback)(
        { id, name: "read_file", arguments: args },
        neverAbort(),
      );
  }

  function blobChainRunner(
    readBlob: (key: string) => Promise<Uint8Array>,
  ): (id: string, args: Record<string, unknown>) => Promise<ToolResult> {
    const plugin = readFileGuardPlugin(dir, {
      blobReader: createBlobReader({ readBlob }),
    });
    const middleware = plugin.middleware;
    if (middleware === undefined) throw new Error("expected middleware");
    const fallback = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: "FALLBACK",
    });
    return (id, args) =>
      middleware(fallback)(
        { id, name: "read_file", arguments: args },
        neverAbort(),
      );
  }

  test("reads a deep page of a file larger than the scan ceiling", async () => {
    const p = await bigFixture("cl8979-big.txt");
    const res = await readFileBounded(p, 43_000, 5, neverAbort());
    expect(res.isError).toBeUndefined();
    expect(String(res.content)).toContain(bigRow(43_000));
    expect(String(res.content)).not.toContain("scan limit");
  });

  test("chains plain path+offset continuation on one path through to the last line", async () => {
    const name = "cl8979-chain.txt";
    await bigFixture(name);
    const run = chainRunner();
    const collected: string[] = [];
    let offset = 0;
    let hops = 0;
    for (;;) {
      const result = await run(`chain-${hops}`, {
        path: name,
        limit: 200,
        offset,
      });
      hops += 1;
      const content = String(result.content);
      expect(result.isError).toBeFalsy();
      expect(content).not.toContain("scan limit");
      collected.push(...bodyRows(content));
      const next = continueOffset(content);
      if (next === null) break;
      offset = next;
      expect(hops).toBeLessThan(2000);
    }
    expect(hops).toBeGreaterThan(1);
    expect(collected.length).toBe(BIG_LINES);
    expect(collected).toEqual(
      Array.from({ length: BIG_LINES }, (_, i) => bigRow(i)),
    );
  }, 120_000);

  test("chains same-URI+offset continuation on a blob past the scan ceiling without re-scanning", async () => {
    const rows = Array.from({ length: BIG_LINES }, (_, i) => bigRow(i));
    const bytes = new TextEncoder().encode(`${rows.join("\n")}\n`);
    const run = blobChainRunner(async (key) => {
      if (key === "cl8979-blob") return bytes;
      throw new Error(`missing ${key}`);
    });
    const collected: string[] = [];
    const path = "tool-output:///cl8979-blob";
    let offset = 0;
    let hops = 0;
    let sawOffsetFooter = false;
    for (;;) {
      const result = await run(`blob-${hops}`, { path, limit: 200, offset });
      hops += 1;
      const content = String(result.content);
      expect(result.isError).toBeFalsy();
      expect(content).not.toContain("scan limit");
      collected.push(...bodyRows(content));
      const next = continueOffset(content);
      if (next === null) break;
      sawOffsetFooter = true;
      expect(next).toBeGreaterThan(offset);
      offset = next;
      expect(hops).toBeLessThan(2000);
    }
    expect(hops).toBeGreaterThan(1);
    expect(sawOffsetFooter).toBe(true);
    expect(collected.length).toBe(BIG_LINES);
    expect(collected[BIG_LINES - 1]).toBe(bigRow(BIG_LINES - 1));
  }, 120_000);

  test("windows an overlong single file line so the tail is reachable", async () => {
    const payload = `HEAD-${"y".repeat(100_000)}-TAIL`;
    const p = await fixture("cl8979-giant.txt", `${payload}\nEND\n`);
    let offset = 0;
    let hops = 0;
    let collected = "";
    for (;;) {
      const res = await readFileBounded(p, offset, 10, neverAbort());
      hops += 1;
      expect(res.isError).toBeUndefined();
      const content = String(res.content);
      expect(content).not.toContain("line truncated");
      collected += `${content}\n`;
      const rows = bodyRows(content);
      expect(rows.length).toBeGreaterThan(1);
      const next = continueOffset(content);
      if (next === null) break;
      offset = next;
      expect(hops).toBeLessThan(100);
    }
    expect(collected).toContain("HEAD-");
    expect(collected).toContain("-TAIL");
    expect(collected).toContain("END");
  });

  test("a large-file page passes the result-truncation layer byte-identical", async () => {
    const name = "cl8979-page.txt";
    const rows = Array.from(
      { length: 3_000 },
      (_, i) => `cell-${i}-` + "v".repeat(50),
    );
    await fixture(name, `${rows.join("\n")}\n`);
    const plugin = readFileGuardPlugin(dir, {});
    const guardMiddleware = plugin.middleware;
    if (guardMiddleware === undefined) throw new Error("expected middleware");
    const fallback = async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content: "FALLBACK",
    });
    const guard = guardMiddleware(fallback);
    const guardOnly = await guard(
      { id: "page-1", name: "read_file", arguments: { path: name } },
      neverAbort(),
    );
    expect(guardOnly.isError).toBeFalsy();
    expect(String(guardOnly.content)).toContain("to continue");
    const spilled = new Map<string, Uint8Array>();
    const truncPlugin = resultTruncationPlugin({
      getBlobWriter: () => async (key: string, payload: Uint8Array) => {
        spilled.set(key, payload);
      },
    });
    const truncMiddleware = truncPlugin.middleware;
    if (truncMiddleware === undefined) throw new Error("expected middleware");
    const composed = truncMiddleware(guard);
    const res = await composed(
      { id: "page-1", name: "read_file", arguments: { path: name } },
      neverAbort(),
    );
    expect(String(res.content)).toBe(String(guardOnly.content));
    expect(spilled.size).toBe(0);
  });

  test("an aborted read rejects with a timeout, not a fallback page", async () => {
    const p = await fixture("cl8979-abort.txt", "x".repeat(1000));
    const ctl = new AbortController();
    ctl.abort();
    const read = readFileBounded(p, 0, 2000, ctl.signal);
    await expect(read).rejects.toThrow("[timed out before completing]");
  });

  test("a binary file still surfaces a refusal instead of a fallback page", async () => {
    await fixture(
      "cl8979-bin.dat",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00]),
    );
    const run = chainRunner();
    const result = await run("bin-1", { path: "cl8979-bin.dat" });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/binary/);
    expect(String(result.content)).not.toBe("FALLBACK");
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
    const plugin = readFileGuardPlugin(
      dir,
      blobReader !== undefined ? { blobReader } : {},
    );
    return defined(plugin.middleware)(fallback)(call, neverAbort());
  }

  test("intercepts read_file for real paths", async () => {
    await fixture("guarded.txt", "hello");
    const result = await run({
      id: "r1",
      name: "read_file",
      arguments: { path: "guarded.txt" },
    });
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
    expect(result.content).toContain("Use offset=");
    expect(result.content).not.toContain('Use path="tool-output:///');
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

  test("pages a giant one-line tool-output blob across byte windows on the same URI with rising offsets", async () => {
    const encoder = new TextEncoder();
    const payload = `HEAD-${"x".repeat(READ_FILE_MAX_BYTES)}-TAIL`;
    const blobReader = createBlobReader({
      async readBlob(key) {
        if (key === "giant-line") return encoder.encode(payload);
        throw new Error(`missing ${key}`);
      },
    });
    const plugin = readFileGuardPlugin(dir, { blobReader });
    const middleware = defined(plugin.middleware)(fallback);
    const first = await middleware(
      {
        id: "g1",
        name: "read_file",
        arguments: { path: "tool-output:///giant-line" },
      },
      neverAbort(),
    );
    expect(first.isError).toBeFalsy();
    const firstContent = String(first.content);
    expect(firstContent).toContain("HEAD-");
    expect(firstContent).not.toContain("-TAIL");
    expect(firstContent).not.toContain("line truncated");
    expect(firstContent).toContain("output limit");
    expect(Buffer.byteLength(firstContent, "utf8")).toBeLessThanOrEqual(
      READ_FILE_MAX_BYTES,
    );
    const match = /Use offset=(\d+) to continue/.exec(firstContent);
    expect(match).not.toBeNull();
    const nextOffset = Number((match as RegExpExecArray)[1]);

    const second = await middleware(
      {
        id: "g2",
        name: "read_file",
        arguments: {
          path: "tool-output:///giant-line",
          offset: nextOffset,
        },
      },
      neverAbort(),
    );
    expect(second.isError).toBeFalsy();
    expect(String(second.content)).toContain("-TAIL");
  });

  test("returns pretty-printed tool-output past the 2000-line file cap when it fits the byte window", async () => {
    const encoder = new TextEncoder();
    const pretty = `${JSON.stringify(
      Array.from({ length: READ_FILE_DEFAULT_MAX_LINES + 500 }, (_, i) => i),
      null,
      2,
    )}\n`;
    const blobReader = createBlobReader({
      async readBlob(key) {
        if (key === "pretty-json") return encoder.encode(pretty);
        throw new Error(`missing ${key}`);
      },
    });
    const result = await run(
      {
        id: "pretty1",
        name: "read_file",
        arguments: { path: "tool-output:///pretty-json" },
      },
      blobReader,
    );
    expect(result.isError).toBeFalsy();
    const content = String(result.content);
    expect(pretty.trimEnd().split("\n").length).toBeGreaterThan(
      READ_FILE_DEFAULT_MAX_LINES,
    );
    expect(content).toContain(String(READ_FILE_DEFAULT_MAX_LINES + 499));
    expect(content).not.toContain("line limit");
    expect(content).not.toContain('Use path="tool-output:///');
  });

  test("pages tool-output blobs above the display ceiling instead of rejecting the spill", async () => {
    const encoder = new TextEncoder();
    const huge = encoder.encode(
      "x".repeat(READ_FILE_MAX_TOOL_OUTPUT_BYTES + 1),
    );
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
    const result = await run({
      id: "r3b",
      name: "read_file",
      arguments: { path: "." },
    });
    expect(result.content).toBe("FALLBACK");
  });

  test("ignores non-read_file calls", async () => {
    const result = await run({
      id: "r4",
      name: "grep",
      arguments: { pattern: "x" },
    });
    expect(result.content).toBe("FALLBACK");
  });

  test("a truncated read names the same path with an explicit offset (CL-8980)", async () => {
    await fixture(
      "many-lines.txt",
      Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
    );
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = defined(plugin.middleware)(fallback);
    const result = await middleware(
      {
        id: "c1",
        name: "read_file",
        arguments: { path: "many-lines.txt", limit: 4 },
      },
      neverAbort(),
    );
    expect(String(result.content)).toMatch(/Use offset=(\d+) to continue/);
    expect(String(result.content)).not.toContain('Use path="tool-output:///');
    expect(String(result.content)).not.toContain("single-use");
  });

  test("following same-path offsets reads a large file to completion; every hop re-issues the original path with a rising offset (CL-8980)", async () => {
    const lines = Array.from({ length: 9_000 }, (_, i) => `line-${i} payload`);
    await fixture("huge.txt", lines.join("\n"));
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = defined(plugin.middleware)(fallback);

    let result = await middleware(
      { id: "c1", name: "read_file", arguments: { path: "huge.txt" } },
      neverAbort(),
    );
    let seen = 0;
    let guard = 0;
    for (;;) {
      guard++;
      expect(guard).toBeLessThan(50); // fails loudly instead of hanging on a broken offset chain
      const content = String(result.content);
      const numbered = content.split("\n\n")[0] ?? "";
      seen += numbered.trimEnd().split("\n").length;

      const match = /Use offset=(\d+) to continue/.exec(content);
      if (match === undefined || match === null) break;
      const offset = Number(match[1] as string);

      result = await middleware(
        {
          id: `c${guard + 1}`,
          name: "read_file",
          arguments: { path: "huge.txt", offset },
        },
        neverAbort(),
      );
      expect(result.isError).toBeFalsy();
    }

    expect(seen).toBe(lines.length);
    expect(guard).toBeGreaterThan(1); // it actually paginated
  });

  test("reusing a continuation offset after first use still yields the window — reads never expire", async () => {
    await fixture(
      "stale.txt",
      Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
    );
    const plugin = readFileGuardPlugin(dir, {});
    const middleware = defined(plugin.middleware)(fallback);
    const first = await middleware(
      {
        id: "s1",
        name: "read_file",
        arguments: { path: "stale.txt", limit: 4 },
      },
      neverAbort(),
    );
    const match = /Use offset=(\d+) to continue/.exec(String(first.content));
    expect(match).not.toBeNull();
    const offset = Number((match as RegExpExecArray)[1] as string);

    const second = await middleware(
      { id: "s2", name: "read_file", arguments: { path: "stale.txt", offset } },
      neverAbort(),
    );
    expect(second.isError).toBeFalsy();
    expect(String(second.content)).toContain("line-4");
    // Second use of the same offset: reads are idempotent, so the replay is
    // byte-identical instead of a spent-handle error.
    const replay = await middleware(
      { id: "s3", name: "read_file", arguments: { path: "stale.txt", offset } },
      neverAbort(),
    );
    expect(replay.isError).toBeFalsy();
    expect(String(replay.content)).toBe(String(second.content));
    expect(String(replay.content)).not.toContain("already used");
    expect(String(replay.content)).not.toContain("single-use");
  });

  test("an unknown tool-output URI against a real blobReader surfaces the blob store error", async () => {
    const blobReader = {
      async read(uri: string): Promise<Uint8Array> {
        throw new Error(`Blob not found for key: ${uri}`);
      },
    };
    const result = await run(
      {
        id: "u1",
        name: "read_file",
        arguments: { path: "tool-output:///never-minted" },
      },
      blobReader,
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Blob not found for key");
    // No handle machinery remains: there is no spent/cursor wording anywhere.
    expect(String(result.content)).not.toContain("already used");
    expect(String(result.content)).not.toContain("single-use");
  });

  test("a replayed unknown tool-output URI surfaces the same blob error twice — no spent-handle state", async () => {
    const blobReader = {
      async read(uri: string): Promise<Uint8Array> {
        throw new Error(`Blob not found for key: ${uri}`);
      },
    };
    const plugin = readFileGuardPlugin(dir, { blobReader });
    const middleware = defined(plugin.middleware)(fallback);

    const first = await middleware(
      {
        id: "b1",
        name: "read_file",
        arguments: { path: "tool-output:///gone", limit: 5 },
      },
      neverAbort(),
    );
    expect(first.isError).toBe(true);
    expect(String(first.content)).toContain("Blob not found for key");
    const replay = await middleware(
      {
        id: "b2",
        name: "read_file",
        arguments: { path: "tool-output:///gone", limit: 5 },
      },
      neverAbort(),
    );
    expect(replay.isError).toBe(true);
    expect(String(replay.content)).toBe(String(first.content));
  });
});
