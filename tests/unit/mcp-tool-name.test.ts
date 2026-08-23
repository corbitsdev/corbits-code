import { test, expect, describe } from "bun:test";
import {
  isMcpToolName,
  parseMcpToolName,
  humanizeMcpTool,
  isReadOnlyMcpTool,
} from "../../src/mcp/tool-name.js";

describe("MCP tool name helpers", () => {
  test("detects mcp tool names", () => {
    expect(isMcpToolName("mcp__acme__list_widgets")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
  });

  test("parses server and tool", () => {
    expect(parseMcpToolName("mcp__acme__list_widgets")).toEqual({
      server: "acme",
      tool: "list_widgets",
    });
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__only")).toBeNull();
  });

  test("humanizes to 'Server: Tool Name'", () => {
    expect(humanizeMcpTool("mcp__acme__list_widgets")).toBe("Acme: List Widgets");
    expect(humanizeMcpTool("mcp__example__create_item")).toBe("Example: Create Item");
  });

  test("title-cases a single-word tool", () => {
    expect(humanizeMcpTool("mcp__acme__ping")).toBe("Acme: Ping");
  });

  test("handles a server with digits and hyphens", () => {
    expect(humanizeMcpTool("mcp__acme-2__list_widgets")).toBe("Acme-2: List Widgets");
  });

  test("does not repeat the server when a tool name carries it as a suffix or prefix", () => {
    expect(humanizeMcpTool("mcp__exa__web_search_exa")).toBe("Exa: Web Search");
    expect(humanizeMcpTool("mcp__exa__exa_crawl")).toBe("Exa: Crawl");
  });

  test("falls back to the raw name when it does not match the mcp__server__tool shape", () => {
    expect(humanizeMcpTool("mcp__only")).toBe("mcp__only");
    expect(humanizeMcpTool("read_file")).toBe("read_file");
  });
});

describe("isReadOnlyMcpTool", () => {
  test("read-style Linear tools are read-only", () => {
    expect(isReadOnlyMcpTool("mcp__linear__list_teams")).toBe(true);
    expect(isReadOnlyMcpTool("mcp__linear__get_issue")).toBe(true);
  });

  test("mutating tools are not read-only", () => {
    expect(isReadOnlyMcpTool("mcp__linear__save_issue")).toBe(false);
  });
});
