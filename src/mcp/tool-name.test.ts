import { describe, expect, test } from "bun:test";
import {
  humanizeMcpTool,
  isMcpToolName,
  isReadOnlyMcpTool,
  mcpToolName,
  mcpToolPrefix,
  parseMcpToolName,
} from "./tool-name.js";

describe("mcpToolName", () => {
  test("builds mcp__<server>__<tool> and round-trips through parseMcpToolName", () => {
    const name = mcpToolName("railway", "get_logs");
    expect(name).toBe("mcp__railway__get_logs");
    expect(name.startsWith(mcpToolPrefix("railway"))).toBe(true);
    expect(mcpToolPrefix("railway")).toBe("mcp__railway__");
    expect(parseMcpToolName(name)).toEqual({
      server: "railway",
      tool: "get_logs",
    });
  });
});

describe("MCP tool name helpers", () => {
  test("detects and parses mcp tool names", () => {
    expect(isMcpToolName("mcp__acme__list_widgets")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
    expect(parseMcpToolName("mcp__acme__list_widgets")).toEqual({
      server: "acme",
      tool: "list_widgets",
    });
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__only")).toBeNull();
  });

  test("humanizes to 'Server: Tool Name' with dedup and raw fallback", () => {
    expect(humanizeMcpTool("mcp__acme__list_widgets")).toBe(
      "Acme: List Widgets",
    );
    expect(humanizeMcpTool("mcp__acme__ping")).toBe("Acme: Ping");
    expect(humanizeMcpTool("mcp__acme-2__list_widgets")).toBe(
      "Acme-2: List Widgets",
    );
    expect(humanizeMcpTool("mcp__exa__web_search_exa")).toBe("Exa: Web Search");
    expect(humanizeMcpTool("mcp__exa__exa_crawl")).toBe("Exa: Crawl");
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
