import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import {
  closestLines,
  editFileDiagnosticsPlugin,
  findOccurrences,
  findWhitespaceNearMiss,
  normalizeLine,
  stripLineNumberPrefixes,
  truncateDiagnostic,
} from "./edit-file-diagnostics-plugin.js";
import { pathEscapePlugin } from "./path-escape-plugin.js";
import { verifyPlugin } from "./verify-plugin.js";
import { composeMiddleware, type Middleware } from "@intx/tools-posix";

function editCall(path: string, old_string: string, new_string = "x"): ToolCall {
  return {
    id: "edit-call",
    name: "edit_file",
    arguments: { path, old_string, new_string },
  };
}

function stockNotFound(path: string): ToolResult {
  return {
    callId: "edit-call",
    content: `old_string not found in ${path}`,
    isError: true,
  };
}

function stockNotUnique(path: string, n: number): ToolResult {
  return {
    callId: "edit-call",
    content: `old_string is not unique (${n} occurrences) in ${path}`,
    isError: true,
  };
}

describe("normalizeLine / near-miss helpers", () => {
  test("normalizeLine trims, collapses internal whitespace, and strips CR", () => {
    expect(normalizeLine("  const  x = 1\t  \r")).toBe("const x = 1");
  });

  test("findWhitespaceNearMiss returns unique indent-drift span", () => {
    const file = ["function f() {", "  const bareKey = 1;", "    const entry = 2;", "}"].join("\n");
    const old = ["const bareKey = 1;", "  const entry = 2;"].join("\n");
    const miss = findWhitespaceNearMiss(file, old);
    expect(miss).not.toBeNull();
    expect(miss!.text).toBe("  const bareKey = 1;\n    const entry = 2;");
    expect(miss!.startLine).toBe(2);
    expect(miss!.endLine).toBe(3);
  });

  test("findWhitespaceNearMiss ignores trailing and leading newlines on the needle", () => {
    const file = ["function f() {", "  const bareKey = 1;", "    const entry = 2;", "}"].join("\n");
    const trailing = "const bareKey = 1;\n  const entry = 2;\n";
    const leading = "\nconst bareKey = 1;\n  const entry = 2;";
    for (const old of [trailing, leading]) {
      const miss = findWhitespaceNearMiss(file, old);
      expect(miss).not.toBeNull();
      expect(miss!.text).toBe("  const bareKey = 1;\n    const entry = 2;");
    }
  });

  test("findWhitespaceNearMiss returns null when normalized match is not unique", () => {
    const file = ["  a = 1", "  a = 1"].join("\n");
    expect(findWhitespaceNearMiss(file, "a = 1")).toBeNull();
  });

  test("findWhitespaceNearMiss handles CRLF file against LF old_string", () => {
    const file = "line one\r\n  const x = 1;\r\nline three\r\n";
    const old = "const x = 1;";
    const miss = findWhitespaceNearMiss(file, old);
    expect(miss).not.toBeNull();
    // Original span uses the split-on-\n form; trailing \r may remain on the line body.
    expect(normalizeLine(miss!.text)).toBe("const x = 1;");
    expect(miss!.startLine).toBe(2);
  });

  test("stripLineNumberPrefixes detects read_file decoration", () => {
    const decorated = "   166\t  const x = 1;\n   167\t  return x;";
    expect(stripLineNumberPrefixes(decorated)).toBe("  const x = 1;\n  return x;");
    expect(stripLineNumberPrefixes("  const x = 1;")).toBeNull();
  });

  test("findOccurrences lists each hit with line numbers", () => {
    const file = "a\nb\na\n";
    const occ = findOccurrences(file, "a");
    expect(occ.map((o) => o.lineNumber)).toEqual([1, 3]);
  });

  test("findOccurrences previews multi-line matches, not just the start line", () => {
    const file = "foo\nbar\nbaz\nfoo\nbar\nqux\n";
    const occ = findOccurrences(file, "foo\nbar");
    expect(occ).toHaveLength(2);
    expect(occ[0]?.preview).toContain("foo");
    expect(occ[0]?.preview).toContain("bar");
    expect(occ[1]?.lineNumber).toBe(4);
  });

  test("closestLines ranks by token overlap", () => {
    const file = ["foo bar", "alpha beta gamma", "const bareKey = entry"].join("\n");
    const closest = closestLines(file, "const bareKey = something");
    expect(closest[0]?.lineNumber).toBe(3);
  });

  test("truncateDiagnostic keeps fence markers when body is huge", () => {
    const body = "x".repeat(3000);
    const diag = `Whitespace near-miss (unique; use this exact text as old_string):\n<<<\n${body}\n>>>\n(lines 1-100)`;
    const out = truncateDiagnostic(diag);
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out).toContain("<<<");
    expect(out).toContain(">>>");
    expect(out).toContain("span too large");
    // Must not offer the raw oversized body as a paste target.
    expect(out).not.toContain("x".repeat(100));
  });
});

describe("editFileDiagnosticsPlugin", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "intercode-edit-diag-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function wrap(
    next: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>,
    extra: Middleware[] = [],
  ) {
    const mws: Middleware[] = [
      pathEscapePlugin(cwd).middleware!,
      verifyPlugin().middleware!,
      editFileDiagnosticsPlugin().middleware!,
      ...extra,
    ];
    return composeMiddleware(mws, next);
  }

  test("enriches not-found with unique whitespace near-miss", async () => {
    const path = join(cwd, "a.ts");
    await writeFile(
      path,
      ["function f() {", "  const bareKey = 1;", "    const entry = 2;", "}"].join("\n"),
    );

    const next = async (): Promise<ToolResult> => stockNotFound(path);
    const handler = wrap(next);
    const result = await handler(
      editCall("a.ts", "const bareKey = 1;\n  const entry = 2;"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("old_string not found");
    expect(String(result.content)).toContain("Whitespace near-miss");
    expect(String(result.content)).toContain("<<<");
    expect(String(result.content)).toContain("  const bareKey = 1;");
    expect(String(result.content)).toContain("    const entry = 2;");
    // Must not re-teach read_file decoration.
    expect(String(result.content)).not.toMatch(/\n\s+\d+\t/);
  });

  test("detects line-number-prefix contamination", async () => {
    const path = join(cwd, "b.ts");
    await writeFile(path, "  const x = 1;\n  return x;\n");

    const next = async (): Promise<ToolResult> => stockNotFound(path);
    const handler = wrap(next);
    const result = await handler(
      editCall("b.ts", "     1\t  const x = 1;\n     2\t  return x;"),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("line-number prefixes");
    expect(String(result.content)).toContain("  const x = 1;");
  });

  test("composes line-number-prefix stripping with indent-drift near-miss", async () => {
    const path = join(cwd, "prefix-indent.ts");
    await writeFile(
      path,
      ["function f() {", "  const bareKey = 1;", "    const entry = 2;", "}"].join("\n"),
    );

    // Decorated AND wrong indent — both dominant failure modes at once.
    const contaminated = "     2\tconst bareKey = 1;\n     3\t  const entry = 2;";
    const next = async (): Promise<ToolResult> => stockNotFound(path);
    const handler = wrap(next);
    const result = await handler(
      editCall("prefix-indent.ts", contaminated),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("line-number prefixes");
    expect(String(result.content)).toContain("Whitespace near-miss");
    expect(String(result.content)).toContain("  const bareKey = 1;");
    expect(String(result.content)).toContain("    const entry = 2;");
  });

  test("lists not-unique occurrences with line numbers", async () => {
    const path = join(cwd, "c.ts");
    await writeFile(path, "foo\nbar\nfoo\nbaz\nfoo\n");

    const next = async (): Promise<ToolResult> => stockNotUnique(path, 3);
    const handler = wrap(next);
    const result = await handler(editCall("c.ts", "foo"), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("old_string is not unique");
    expect(String(result.content)).toContain("line 1:");
    expect(String(result.content)).toContain("line 3:");
    expect(String(result.content)).toContain("line 5:");
    expect(String(result.content)).toContain("replace_all=true");
  });

  test("caps not-unique listing", async () => {
    const path = join(cwd, "many.ts");
    const body = Array.from({ length: 25 }, () => "hit").join("\n");
    await writeFile(path, body);

    const next = async (): Promise<ToolResult> => stockNotUnique(path, 25);
    const handler = wrap(next);
    const result = await handler(editCall("many.ts", "hit"), new AbortController().signal);

    expect(String(result.content)).toContain("showing 10 of 25");
    expect(String(result.content)).toContain("and 15 more");
  });

  test("success path is transparent", async () => {
    const path = join(cwd, "ok.ts");
    await writeFile(path, "hello world\n");

    const next = async (call: ToolCall): Promise<ToolResult> => {
      // Simulate a successful stock edit.
      await writeFile(String(call.arguments.path), "hello there\n");
      return { callId: call.id, content: "replaced 1 occurrence(s) in " + call.arguments.path };
    };
    const handler = wrap(next);
    const result = await handler(
      editCall("ok.ts", "hello world", "hello there"),
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("replaced 1 occurrence");
    expect(String(result.content)).not.toContain("near-miss");
  });

  test("leaves non-match errors alone", async () => {
    const next = async (): Promise<ToolResult> => ({
      callId: "edit-call",
      content: "file not found: /nope",
      isError: true,
    });
    const handler = wrap(next);
    const result = await handler(
      editCall(join(cwd, "missing.ts"), "x"),
      new AbortController().signal,
    );
    expect(result.content).toBe("file not found: /nope");
  });

  test("preserves original error when re-read fails", async () => {
    // Path is absolute and escaped, but file is gone by the time diagnostics run.
    // Use a stock not-found for a path that does not exist.
    const missing = join(cwd, "gone.ts");
    const next = async (): Promise<ToolResult> => stockNotFound(missing);
    const handler = wrap(next);
    const result = await handler(editCall("gone.ts", "x"), new AbortController().signal);
    expect(result.content).toBe(`old_string not found in ${missing}`);
  });

  test("falls back to closest-line sample when no near-miss", async () => {
    const path = join(cwd, "far.ts");
    await writeFile(path, "alpha\nconst bareKey = 99;\ngamma\n");

    const next = async (): Promise<ToolResult> => stockNotFound(path);
    const handler = wrap(next);
    // Completely different whitespace structure AND different tokens on other lines
    // so near-miss fails; closest should still surface bareKey line.
    const result = await handler(
      editCall("far.ts", "const bareKey = 42; // no such line"),
      new AbortController().signal,
    );

    expect(String(result.content)).toContain("Closest lines");
    expect(String(result.content)).toContain("bareKey");
  });

  test("near-miss with trailing newline on old_string still enriches", async () => {
    const path = join(cwd, "trail.ts");
    await writeFile(
      path,
      ["function f() {", "  const bareKey = 1;", "    const entry = 2;", "}"].join("\n"),
    );

    const next = async (): Promise<ToolResult> => stockNotFound(path);
    const handler = wrap(next);
    const result = await handler(
      editCall("trail.ts", "const bareKey = 1;\n  const entry = 2;\n"),
      new AbortController().signal,
    );

    expect(String(result.content)).toContain("Whitespace near-miss");
    expect(String(result.content)).toContain("  const bareKey = 1;");
  });
});
