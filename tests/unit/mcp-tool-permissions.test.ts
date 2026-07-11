import { describe, expect, test } from "bun:test";
import {
  createMcpToolPermissionRegistry,
  registerMcpClientTools,
  tierFromMcpTool,
} from "../../src/mcp/tool-permissions.js";
import { classifyTool } from "../../src/permission/classify.js";

describe("tierFromMcpTool", () => {
  test("readOnlyHint true allows", () => {
    expect(tierFromMcpTool({ readOnlyHint: true }, "srv", "mutate_everything")).toBe("allow");
  });

  test("explicit non-read-only annotations ask even for list_ names", () => {
    expect(tierFromMcpTool({ readOnlyHint: false }, "srv", "list_everything")).toBe("ask");
  });

  test("missing annotations use prefix heuristics", () => {
    expect(tierFromMcpTool(undefined, "linear", "get_issue")).toBe("allow");
    expect(tierFromMcpTool(undefined, "linear", "save_issue")).toBe("ask");
  });

  test("empty annotation object falls back to prefix heuristics", () => {
    expect(tierFromMcpTool({}, "linear", "list_teams")).toBe("allow");
    expect(tierFromMcpTool({ title: "List teams" }, "linear", "save_issue")).toBe("ask");
  });
});

describe("registerMcpClientTools", () => {
  test("feeds classifyTool through the permission registry", () => {
    const registry = createMcpToolPermissionRegistry();
    registerMcpClientTools(registry, "linear", [
      { name: "custom_read", annotations: { readOnlyHint: true } },
      { name: "custom_write", annotations: { destructiveHint: true } },
    ]);
    expect(classifyTool("mcp__linear__custom_read", registry)).toBe("allow");
    expect(classifyTool("mcp__linear__custom_write", registry)).toBe("ask");
  });
});