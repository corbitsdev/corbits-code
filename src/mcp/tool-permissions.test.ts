import { describe, expect, test } from "bun:test";
import { createMcpToolPermissionRegistry, registerMcpClientTools } from "./tool-permissions.js";

describe("removeToolsForServer", () => {
  test("does not delete mcp__linear__* tiers when removing lin", () => {
    const registry = createMcpToolPermissionRegistry();
    registerMcpClientTools(registry, "lin", [{ name: "list" }]);
    registerMcpClientTools(registry, "linear", [{ name: "list" }]);
    expect(registry.tierFor("mcp__lin__list")).toBeDefined();
    expect(registry.tierFor("mcp__linear__list")).toBeDefined();

    registry.removeToolsForServer("lin");

    expect(registry.tierFor("mcp__lin__list")).toBeUndefined();
    expect(registry.tierFor("mcp__linear__list")).toBeDefined();
  });
});
