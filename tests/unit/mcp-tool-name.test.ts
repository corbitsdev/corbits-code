import { test, expect, describe } from "bun:test";
import { isMcpToolName, parseMcpToolName, humanizeMcpTool } from "../../src/mcp/tool-name.js";

describe("MCP tool name helpers", () => {
  test("detects mcp tool names", () => {
    expect(isMcpToolName("mcp__linear__list_projects")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
  });

  test("parses server and tool", () => {
    expect(parseMcpToolName("mcp__linear__list_projects")).toEqual({ server: "linear", tool: "list_projects" });
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__only")).toBeNull();
  });

  test("humanizes to 'Server: tool name'", () => {
    expect(humanizeMcpTool("mcp__linear__list_projects")).toBe("Linear: list projects");
    expect(humanizeMcpTool("mcp__github__create_issue")).toBe("Github: create issue");
  });
});
