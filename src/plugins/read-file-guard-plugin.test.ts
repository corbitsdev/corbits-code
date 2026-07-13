import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  READ_FILE_DEFAULT_MAX_LINES,
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LINE_LENGTH,
  READ_FILE_MAX_SCAN_BYTES,
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

  function run(call: ToolCall): Promise<ToolResult> {
    return readFileGuardPlugin(dir).middleware!(fallback)(call, neverAbort());
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
    expect(result.content).toContain("Use offset=");
  });

  test("passes tool-output URIs through to the stock handler", async () => {
    const result = await run({
      id: "r2",
      name: "read_file",
      arguments: { path: "tool-output:///call-123" },
    });
    expect(result.content).toBe("FALLBACK");
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
});
