import { describe, expect, test } from "bun:test";
import { mcpToolName, mcpToolPrefix, parseMcpToolName } from "./tool-name.js";

describe("mcpToolName", () => {
  test("builds the mcp__<server>__<tool> identifier", () => {
    expect(mcpToolName("linear", "list_projects")).toBe("mcp__linear__list_projects");
  });

  test("round-trips with parseMcpToolName", () => {
    const name = mcpToolName("railway", "get_logs");
    expect(parseMcpToolName(name)).toEqual({ server: "railway", tool: "get_logs" });
  });
});

describe("mcpToolPrefix", () => {
  test("matches the prefix of a built name for the same server", () => {
    const server = "linear";
    expect(mcpToolName(server, "list_projects").startsWith(mcpToolPrefix(server))).toBe(true);
  });

  test("builds mcp__<server>__", () => {
    expect(mcpToolPrefix("linear")).toBe("mcp__linear__");
  });
});
