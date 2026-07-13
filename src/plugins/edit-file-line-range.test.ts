import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { composeMiddleware } from "@intx/tools-posix";

import {
  advertiseEditFileLineRange,
  applyLineRangeEdit,
  lineRangeSourceText,
  parseEditFileMode,
  runEditFileLineRange,
} from "./edit-file-line-range.js";
import { editFileLineRangePlugin } from "./edit-file-line-range-plugin.js";
import { pathEscapePlugin } from "./path-escape-plugin.js";
import { verifyPlugin } from "./verify-plugin.js";

describe("parseEditFileMode", () => {
  test("detects substring mode", () => {
    const mode = parseEditFileMode({
      path: "a.ts",
      old_string: "x",
      new_string: "y",
    });
    expect(mode.kind).toBe("substring");
  });

  test("detects line-range mode", () => {
    const mode = parseEditFileMode({
      path: "a.ts",
      start_line: 2,
      end_line: 3,
      new_string: "z",
    });
    expect(mode.kind).toBe("line_range");
    if (mode.kind === "line_range") {
      expect(mode.start_line).toBe(2);
      expect(mode.end_line).toBe(3);
    }
  });

  test("mixed modes without file content returns recoverable error", () => {
    const mode = parseEditFileMode({
      path: "a.ts",
      old_string: "x",
      start_line: 1,
      end_line: 1,
      new_string: "y",
    });
    expect(mode.kind).toBe("invalid");
    if (mode.kind === "invalid") {
      expect(mode.message).toContain("omit old_string");
      expect(mode.message).toContain("omit start_line");
      expect(mode.message).not.toContain("not both");
    }
  });

  test("mixed modes match CRLF file when old_string uses LF newlines", () => {
    const file = "one\r\ntwo\r\nthree\r\n";
    const mode = parseEditFileMode(
      {
        path: "a.ts",
        old_string: "two",
        start_line: 2,
        end_line: 2,
        new_string: "T",
      },
      { fileContent: file },
    );
    expect(mode.kind).toBe("line_range");
  });

  test("mixed modes with matching range text proceeds as line-range", () => {
    const file = "alpha\nbeta\ngamma\n";
    const mode = parseEditFileMode(
      {
        path: "a.ts",
        old_string: "beta",
        start_line: 2,
        end_line: 2,
        new_string: "B",
      },
      { fileContent: file },
    );
    expect(mode.kind).toBe("line_range");
    if (mode.kind === "line_range") {
      expect(mode.start_line).toBe(2);
      expect(mode.end_line).toBe(2);
    }
  });

  test("mixed modes with out-of-range lines returns recoverable error", () => {
    const file = "alpha\nbeta\n";
    const mode = parseEditFileMode(
      {
        path: "a.ts",
        old_string: "beta",
        start_line: 2,
        end_line: 99,
        new_string: "B",
      },
      { fileContent: file },
    );
    expect(mode.kind).toBe("invalid");
    if (mode.kind === "invalid") {
      expect(mode.message).toContain("omit old_string");
      expect(mode.message).toContain("out of range");
    }
  });

  test("mixed modes with mismatched range text returns recoverable error", () => {
    const file = "alpha\nbeta\ngamma\n";
    const mode = parseEditFileMode(
      {
        path: "a.ts",
        old_string: "alpha",
        start_line: 2,
        end_line: 2,
        new_string: "B",
      },
      { fileContent: file },
    );
    expect(mode.kind).toBe("invalid");
    if (mode.kind === "invalid") {
      expect(mode.message).toContain("does not match");
      expect(mode.message).toContain("omit old_string");
      expect(mode.message).toContain("omit start_line");
    }
  });

  test("rejects inverted range", () => {
    const mode = parseEditFileMode({
      path: "a.ts",
      start_line: 5,
      end_line: 2,
      new_string: "y",
    });
    expect(mode.kind).toBe("invalid");
  });
});

describe("lineRangeSourceText", () => {
  test("extracts inclusive line range with file newline", () => {
    const file = ["one", "two", "three"].join("\n") + "\n";
    expect(lineRangeSourceText(file, 2, 3)).toBe("two\nthree");
    expect(lineRangeSourceText(file, 2, 2)).toBe("two");
  });
});

describe("applyLineRangeEdit", () => {
  test("replaces a single line", () => {
    const out = applyLineRangeEdit("a\nb\nc\n", 2, 2, "B");
    expect(out).toBe("a\nB\nc\n");
  });

  test("replaces a multi-line range", () => {
    const file = ["one", "two", "three", "four"].join("\n") + "\n";
    const out = applyLineRangeEdit(file, 2, 3, "TWO\nTHREE");
    expect(out).toBe(["one", "TWO", "THREE", "four"].join("\n") + "\n");
  });

  test("preserves trailing newline when range does not include last line", () => {
    const out = applyLineRangeEdit("x\ny\n", 1, 1, "X");
    expect(out).toBe("X\ny\n");
  });

  test("range at EOF uses new_string for trailing newline", () => {
    const out = applyLineRangeEdit("a\nb\n", 2, 2, "B");
    expect(out).toBe("a\nB");
    const withNl = applyLineRangeEdit("a\nb\n", 2, 2, "B\n");
    expect(withNl).toBe("a\nB\n");
  });

  test("throws on out-of-range", () => {
    expect(() => applyLineRangeEdit("a\n", 2, 2, "x")).toThrow(/out of range/);
  });
});

describe("advertiseEditFileLineRange", () => {
  test("adds start_line and end_line to edit_file schema", () => {
    const def = advertiseEditFileLineRange({
      name: "edit_file",
      description: "base",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    });
    const props = def.inputSchema.properties as Record<string, unknown>;
    expect(props.start_line).toBeDefined();
    expect(props.end_line).toBeDefined();
    expect(def.inputSchema.required).toEqual(["path", "new_string"]);
    expect(def.description).toContain("Mode B");
  });

  test("leaves non-edit tools unchanged", () => {
    const def = { name: "read_file", description: "r", inputSchema: { type: "object", properties: {} } };
    expect(advertiseEditFileLineRange(def)).toBe(def);
  });
});

describe("editFileLineRangePlugin", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "intercode-line-range-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function handler(next: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>) {
    const mws = [
      pathEscapePlugin(cwd).middleware!,
      editFileLineRangePlugin().middleware!,
      verifyPlugin().middleware!,
    ];
    return composeMiddleware(mws, next);
  }

  test("short-circuits line-range edit without calling stock handler", async () => {
    const path = join(cwd, "f.ts");
    await writeFile(path, "line1\nline2\nline3\n");

    let stockCalled = false;
    const run = handler(async () => {
      stockCalled = true;
      return { callId: "c1", content: "stock" };
    });

    const result = await run(
      {
        id: "c1",
        name: "edit_file",
        arguments: { path: "f.ts", start_line: 2, end_line: 2, new_string: "L2" },
      },
      new AbortController().signal,
    );

    expect(stockCalled).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("replaced line 2");
    expect(await readFile(path, "utf8")).toBe("line1\nL2\nline3\n");
  });

  test("disambiguates mixed mode when old_string matches the line range", async () => {
    const path = join(cwd, "f.ts");
    await writeFile(path, "line1\nline2\nline3\n");

    let stockCalled = false;
    const run = handler(async () => {
      stockCalled = true;
      return { callId: "c1", content: "stock" };
    });

    const result = await run(
      {
        id: "c1",
        name: "edit_file",
        arguments: {
          path: "f.ts",
          old_string: "line2",
          start_line: 2,
          end_line: 2,
          new_string: "L2",
        },
      },
      new AbortController().signal,
    );

    expect(stockCalled).toBe(false);
    expect(result.isError).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("line1\nL2\nline3\n");
  });

  test("mixed mode with conflicting old_string returns recoverable error", async () => {
    const path = join(cwd, "f.ts");
    await writeFile(path, "line1\nline2\nline3\n");

    const run = handler(async () => ({ callId: "c1", content: "stock" }));
    const result = await run(
      {
        id: "c1",
        name: "edit_file",
        arguments: {
          path: "f.ts",
          old_string: "line1",
          start_line: 2,
          end_line: 2,
          new_string: "L2",
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("omit old_string");
    expect(String(result.content)).not.toContain("not both");
  });

  test("runEditFileLineRange integrates with verify expectations", async () => {
    const path = join(cwd, "g.ts");
    await writeFile(path, "alpha\nbeta\ngamma\n");
    const msg = await runEditFileLineRange(
      { kind: "line_range", path, start_line: 2, end_line: 3, new_string: "B\nG" },
      new AbortController().signal,
    );
    expect(msg).toContain("replaced lines 2-3");
    expect(await readFile(path, "utf8")).toBe("alpha\nB\nG");
  });
});