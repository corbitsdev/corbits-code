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
  test("builds the mcp__<server>__<tool> identifier", () => {
    expect(mcpToolName("linear", "list_projects")).toBe(
      "mcp__linear__list_projects",
    );
  });

  test("round-trips with parseMcpToolName", () => {
    const name = mcpToolName("railway", "get_logs");
    expect(parseMcpToolName(name)).toEqual({
      server: "railway",
      tool: "get_logs",
    });
  });
});

describe("mcpToolPrefix", () => {
  test("matches the prefix of a built name for the same server", () => {
    const server = "linear";
    expect(
      mcpToolName(server, "list_projects").startsWith(mcpToolPrefix(server)),
    ).toBe(true);
  });

  test("builds mcp__<server>__", () => {
    expect(mcpToolPrefix("linear")).toBe("mcp__linear__");
  });
});

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
    expect(humanizeMcpTool("mcp__acme__list_widgets")).toBe(
      "Acme: List Widgets",
    );
    expect(humanizeMcpTool("mcp__example__create_item")).toBe(
      "Example: Create Item",
    );
  });

  test("title-cases a single-word tool", () => {
    expect(humanizeMcpTool("mcp__acme__ping")).toBe("Acme: Ping");
  });

  test("handles a server with digits and hyphens", () => {
    expect(humanizeMcpTool("mcp__acme-2__list_widgets")).toBe(
      "Acme-2: List Widgets",
    );
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
