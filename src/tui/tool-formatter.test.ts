import { describe, expect, test } from "bun:test";
import {
  summarizeToolArgs,
  summarizeToolResult,
  isUserFacingJSON,
  describeToolCall,
  humanizeToolName,
} from "./tool-formatter.js";

describe("humanizeToolName", () => {
  test("maps known tools to readable names", () => {
    expect(humanizeToolName("read_file")).toBe("Read");
    expect(humanizeToolName("run_shell")).toBe("Shell");
    expect(humanizeToolName("edit_file")).toBe("Edit");
  });
  test("title-cases unknown snake_case tools so identifiers never leak", () => {
    expect(humanizeToolName("fetch_remote_thing")).toBe("Fetch Remote Thing");
    expect(humanizeToolName("custom_tool")).not.toContain("_");
  });
  test("renders MCP tools as 'Server: tool name'", () => {
    expect(humanizeToolName("mcp__acme__list_projects")).toBe("Acme: list projects");
    expect(humanizeToolName("mcp__acme__list_projects")).not.toContain("mcp__");
  });
});

describe("summarizeToolResult for MCP tools", () => {
  test("summarizes JSON instead of flagging it as a document", () => {
    const raw = JSON.stringify({ projects: [{ name: "A" }, { name: "B" }] });
    const r = summarizeToolResult("mcp__acme__list_projects", raw);
    expect(r.isJSONDocument).toBe(false);
    expect(r.preview).toBe("2 projects");
  });
  test("bounds an enormous payload so it cannot freeze the renderer", () => {
    const raw = JSON.stringify({ results: Array.from({ length: 1000 }, (_, i) => ({ name: `n${i}` })) });
    const r = summarizeToolResult("mcp__acme__list_projects", raw);
    expect(r.full.length).toBeLessThan(4200);
    expect(r.isJSONDocument).toBe(false);
  });
});

describe("describeToolCall", () => {
  test("shell calls put the command in the summary and flag isShell", () => {
    const d = describeToolCall("run_shell", '{"command":"npm test"}');
    expect(d.isShell).toBe(true);
    expect(d.display).toBe("Shell");
    expect(d.summary).toBe("npm test");
  });
  test("writes read as success, edits as accent, reads as muted", () => {
    expect(describeToolCall("write_file", '{"path":"a"}').role).toBe("success");
    expect(describeToolCall("edit_file", '{"path":"a"}').role).toBe("accent");
    expect(describeToolCall("read_file", '{"path":"a"}').role).toBe("muted");
  });
  test("web tools read as accent actions with readable names", () => {
    expect(describeToolCall("web_search", '{"query":"hono.dev"}').display).toBe("Web Search");
    expect(describeToolCall("web_search", '{"query":"hono.dev"}').role).toBe("accent");
    expect(describeToolCall("web_fetch", '{"url":"https://hono.dev"}').display).toBe("Web Fetch");
    expect(describeToolCall("web_fetch", '{"url":"https://hono.dev"}').role).toBe("accent");
  });
  test("a destructive shell command reads as danger", () => {
    expect(describeToolCall("run_shell", '{"command":"rm -rf build"}').role).toBe("danger");
  });
});

describe("summarizeToolArgs", () => {
  test("renders key: value pairs, not JSON, for tools without a path headline", () => {
    const { summary } = summarizeToolArgs("list_dir", JSON.stringify({ path: "src/foo.ts", limit: 100 }));
    expect(summary).toBe("path: src/foo.ts, limit: 100");
    expect(summary).not.toContain("{");
    expect(summary).not.toContain('"');
  });

  test("file tools collapse to a bare path, never key: value or content", () => {
    const long = "#!/usr/bin/env python3\n" + "y".repeat(200);
    const { summary, full } = summarizeToolArgs("write_file", JSON.stringify({ path: "a/b.ts", content: long }));
    expect(summary).toBe("a/b.ts");
    expect(full).toBe("a/b.ts");
    expect(summary).not.toContain("content");
    expect(summary).not.toContain("y".repeat(10));
  });

  test("long values abbreviated in summary, full in full", () => {
    const long = "y".repeat(200);
    const { summary, full } = summarizeToolArgs("notify", JSON.stringify({ message: long }));
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

  test("run_shell success previews the first output line", () => {
    expect(summarizeToolResult("run_shell", "line a\nline b").preview).toBe("line a (+1 more lines)");
    expect(summarizeToolResult("run_shell", "only one").preview).toBe("only one");
    expect(summarizeToolResult("run_shell", "").preview).toBe("(no output)");
  });

  test("run_shell failure previews the exit code and first error line", () => {
    expect(summarizeToolResult("run_shell", "exit code 1\nboom").preview).toBe("exit 1: boom");
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

  test("web_search counts and formats structured results", () => {
    const raw = JSON.stringify({
      results: [
        { title: "Hono", url: "https://hono.dev", snippet: "Fast web framework" },
      ],
    });
    const result = summarizeToolResult("web_search", raw);
    expect(result.preview).toBe("Found 1 web result");
    expect(result.full).toContain("Hono");
    expect(result.full).toContain("https://hono.dev");
    expect(result.full).toContain("Fast web framework");
    expect(result.isJSONDocument).toBe(false);
  });

  test("web_search handles empty structured results", () => {
    const result = summarizeToolResult("web_search", JSON.stringify({ results: [] }));
    expect(result.preview).toBe("No web results");
    expect(result.full).toBe("No web results");
    expect(result.isJSONDocument).toBe(false);
  });

  test("web_fetch unwraps structured markdown content", () => {
    const result = summarizeToolResult("web_fetch", JSON.stringify({ content: "# Hono\n\nFast framework" }));
    expect(result.preview).toBe("Fetched 3 lines");
    expect(result.full).toContain("# Hono");
    expect(result.isJSONDocument).toBe(false);
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

describe("describeToolCall for task tool", () => {
  test("named agent call uses agent name as display with description separate", () => {
    const args = JSON.stringify({ agent: "greybeard", description: "review the diff", prompt: "..." });
    const result = describeToolCall("task", args);
    expect(result.display).toBe("Greybeard");
    expect(result.summary).toBe("review the diff");
    expect(result.isShell).toBe(false);
  });

  test("task without agent uses generic Task display", () => {
    const args = JSON.stringify({ description: "map all callers", prompt: "..." });
    const result = describeToolCall("task", args);
    expect(result.display).toBe("Task");
    expect(result.summary).toBe("map all callers");
  });

  test("long description is abbreviated", () => {
    const long = "a".repeat(100);
    const args = JSON.stringify({ agent: "critique", description: long, prompt: "..." });
    const result = describeToolCall("task", args);
    expect(result.summary.length).toBeLessThan(long.length + 20);
    expect(result.summary.length).toBe(48); // ARG_VALUE_MAX
  });
});
