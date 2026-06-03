import { describe, expect, test } from "bun:test";
import {
  summarizeToolArgs,
  summarizeToolResult,
  isUserFacingJSON,
} from "./tool-formatter.js";

describe("summarizeToolArgs", () => {
  test("renders key: value pairs, not JSON", () => {
    const { summary } = summarizeToolArgs("read_file", JSON.stringify({ path: "src/foo.ts", limit: 100 }));
    expect(summary).toBe("path: src/foo.ts, limit: 100");
    expect(summary).not.toContain("{");
    expect(summary).not.toContain('"');
  });

  test("bare path shown without quotes or braces", () => {
    const { summary } = summarizeToolArgs("write_file", JSON.stringify({ path: "a/b.ts", content: "x" }));
    expect(summary).toContain("path: a/b.ts");
  });

  test("long values abbreviated in summary, full in full", () => {
    const long = "y".repeat(200);
    const { summary, full } = summarizeToolArgs("write_file", JSON.stringify({ path: "a.ts", content: long }));
    expect(summary.length).toBeLessThan(full.length);
    expect(summary).toContain("…");
    expect(full).toContain(long);
  });

  test("empty args produce empty summary", () => {
    expect(summarizeToolArgs("read_file", "")).toEqual({ summary: "", full: "" });
  });

  test("malformed JSON does not throw and is never a blob", () => {
    const { summary } = summarizeToolArgs("read_file", "{not json");
    expect(summary).toBe("{not json");
  });

  test("nested object is compacted, not dumped", () => {
    const { summary } = summarizeToolArgs("x", JSON.stringify({ opts: { a: 1, b: 2 } }));
    expect(summary).toBe("opts: {…}");
  });
});

describe("summarizeToolResult", () => {
  test("read_file counts lines", () => {
    const content = ["     1\tfoo", "     2\tbar", "     3\tbaz"].join("\n");
    expect(summarizeToolResult("read_file", content).preview).toBe("Read 3 lines");
  });

  test("write_file extracts path", () => {
    expect(summarizeToolResult("write_file", "wrote 42 bytes to src/foo.ts").preview).toBe("Wrote src/foo.ts");
  });

  test("edit_file extracts path", () => {
    expect(summarizeToolResult("edit_file", "replaced 2 occurrence(s) in src/foo.ts").preview).toBe(
      "Edited src/foo.ts",
    );
  });

  test("run_shell success reports exit 0", () => {
    expect(summarizeToolResult("run_shell", "line a\nline b").preview).toBe("Shell: exit 0 — 2 lines of output");
  });

  test("run_shell failure reports exit code", () => {
    expect(summarizeToolResult("run_shell", "exit code 1\nboom").preview).toBe("Shell: exit 1 — 1 lines of output");
  });

  test("search_files no match", () => {
    expect(summarizeToolResult("search_files", 'no files matching "*.foo"').preview).toBe("No files matched");
  });

  test("search_files counts files", () => {
    expect(summarizeToolResult("search_files", "a.ts\nb.ts").preview).toBe("Found 2 files");
  });

  test("grep no matches", () => {
    expect(summarizeToolResult("grep", "no matches for /xyz/").preview).toBe("No matches");
  });

  test("grep counts matches", () => {
    expect(summarizeToolResult("grep", "a.ts:1:foo\nb.ts:2:bar").preview).toBe("Found 2 matches");
  });

  test("unknown tool gets generic abbreviated preview", () => {
    expect(summarizeToolResult("mystery", "some output here").preview).toBe("some output here");
  });

  test("full always preserves raw content", () => {
    const raw = "wrote 10 bytes to a.ts";
    expect(summarizeToolResult("write_file", raw).full).toBe(raw);
  });
});

describe("isUserFacingJSON", () => {
  test("real JSON document object is user-facing", () => {
    expect(isUserFacingJSON('{"name":"pkg","version":"1.0.0"}')).toBe(true);
  });

  test("non-empty array is user-facing", () => {
    expect(isUserFacingJSON("[1, 2, 3]")).toBe(true);
  });

  test("prose is not JSON", () => {
    expect(isUserFacingJSON("wrote 42 bytes to a.ts")).toBe(false);
  });

  test("line-numbered file content is not JSON", () => {
    expect(isUserFacingJSON("     1\tconst x = 1")).toBe(false);
  });

  test("bare scalar is not a document", () => {
    expect(isUserFacingJSON("42")).toBe(false);
    expect(isUserFacingJSON("null")).toBe(false);
    expect(isUserFacingJSON('"just a string"')).toBe(false);
  });

  test("empty container is not a document", () => {
    expect(isUserFacingJSON("{}")).toBe(false);
    expect(isUserFacingJSON("[]")).toBe(false);
  });

  test("read_file of a .json file surfaces as JSON document (line numbers stripped)", () => {
    const lineNumbered = ['     1\t{', '     2\t  "strict": true', "     3\t}"].join("\n");
    expect(summarizeToolResult("read_file", lineNumbered).isJSONDocument).toBe(true);
  });

  test("read_file of source code is not a JSON document", () => {
    const lineNumbered = ["     1\tconst x = 1", "     2\texport default x"].join("\n");
    expect(summarizeToolResult("read_file", lineNumbered).isJSONDocument).toBe(false);
  });
});
