import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  READ_FILE_DEFAULT_MAX_LINES,
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LINE_LENGTH,
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

async function fixture(name: string, content: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

describe("readFileBounded", () => {
  test("reads a small file fully with 1-indexed line numbers", async () => {
    const p = await fixture("small.txt", "alpha\nbeta\ngamma");
    const { content, isError } = await readFileBounded(p, 1, 2000, neverAbort());
    expect(isError).toBeUndefined();
    expect(content).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  test("caps output at the byte ceiling without reading the whole file", async () => {
    // 200k lines, ~1.4MB on disk; must stop well under it.
    const big = Array.from({ length: 200_000 }, (_, i) => `line-${i}`).join("\n");
    const p = await fixture("big.txt", big);
    const { content } = await readFileBounded(p, 1, READ_FILE_DEFAULT_MAX_LINES, neverAbort());
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(READ_FILE_MAX_BYTES + 4_096);
    expect(content).toContain("Use offset=");
  });

  test("default line cap stops at DEFAULT_MAX_LINES when lines are short", async () => {
    const many = Array.from({ length: 5_000 }, () => "x").join("\n");
    const p = await fixture("many.txt", many);
    const { content } = await readFileBounded(p, 1, READ_FILE_DEFAULT_MAX_LINES, neverAbort());
    const body = content.split("\n\n")[0] ?? "";
    const lineCount = body.trimEnd().split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(READ_FILE_DEFAULT_MAX_LINES);
    expect(content).toContain("Use offset=");
  });

  test("honors offset", async () => {
    const p = await fixture("offset.txt", "one\ntwo\nthree\nfour");
    const { content } = await readFileBounded(p, 3, 2000, neverAbort());
    expect(content).toBe("     3\tthree\n     4\tfour");
  });

  test("offset beyond EOF is an error", async () => {
    const p = await fixture("short.txt", "a\nb");
    const { content, isError } = await readFileBounded(p, 99, 2000, neverAbort());
    expect(isError).toBe(true);
    expect(content).toContain("beyond end of file");
  });

  test("truncates an overlong single line", async () => {
    const p = await fixture("long-line.txt", "z".repeat(10_000));
    const { content } = await readFileBounded(p, 1, 2000, neverAbort());
    expect(content).toContain("line truncated");
    expect(content.length).toBeLessThan(READ_FILE_MAX_LINE_LENGTH + 200);
  });

  test("rejects binary files", async () => {
    const p = join(dir, "binary.bin");
    await writeFile(p, Buffer.from([0x41, 0x00, 0x42]));
    const { content, isError } = await readFileBounded(p, 1, 2000, neverAbort());
    expect(isError).toBe(true);
    expect(content).toContain("binary");
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
    const result = await run({
      id: "r1",
      name: "read_file",
      arguments: { path: "guarded.txt" },
    });
    expect(result.content).toBe("     1\thello");
    expect(result.content).not.toBe("FALLBACK");
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

  test("ignores non-read_file calls", async () => {
    const result = await run({ id: "r4", name: "grep", arguments: { pattern: "x" } });
    expect(result.content).toBe("FALLBACK");
  });
});
