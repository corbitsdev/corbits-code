import { test, expect, describe } from "bun:test";
import { isMcpToolName, parseMcpToolName, humanizeMcpTool, isReadOnlyMcpTool } from "../../src/mcp/tool-name.js";

describe("MCP tool name helpers", () => {
  test("detects mcp tool names", () => {
    expect(isMcpToolName("mcp__acme__list_widgets")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
  });

  test("parses server and tool", () => {
    expect(parseMcpToolName("mcp__acme__list_widgets")).toEqual({ server: "acme", tool: "list_widgets" });
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__only")).toBeNull();
  });

  test("humanizes to 'Server: tool name'", () => {
    expect(humanizeMcpTool("mcp__acme__list_widgets")).toBe("Acme: list widgets");
    expect(humanizeMcpTool("mcp__example__create_item")).toBe("Example: create item");
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
