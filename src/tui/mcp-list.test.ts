/**
 * `/mcp` list merge: configured catalog plus live non-disconnected names.
 */
import { describe, expect, test } from "bun:test";

import type { MCPServerState } from "../agent/tools.js";
import { createExaMCPServerConfig } from "../mcp/exa.js";
import { mergeMcpSurfaceEntries } from "./mcp-list.js";

function live(states: MCPServerState[]): Map<string, MCPServerState> {
  return new Map(states.map((status) => [status.name, status]));
}

describe("mergeMcpSurfaceEntries", () => {
  test("implicit builtin Exa stays visible as connecting when nothing is live", () => {
    expect(mergeMcpSurfaceEntries([], live([]))).toEqual([
      { name: "exa", state: "connecting", builtin: true },
    ]);
  });

  test("configured disabled wins over leftover disconnected and never paints disconnected", () => {
    const rows = mergeMcpSurfaceEntries(
      [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp", enabled: false }],
      live([{ name: "linear", state: "disconnected" }]),
    );
    expect(rows.map((row) => row.state)).not.toContain("disconnected");
    expect(rows).toEqual([
      { name: "exa", state: "connecting", builtin: true },
      { name: "linear", state: "disabled" },
    ]);
  });

  test("configured-enabled with no live row is connecting after re-enable", () => {
    expect(
      mergeMcpSurfaceEntries(
        [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
        live([]),
      ),
    ).toEqual([
      { name: "exa", state: "connecting", builtin: true },
      { name: "linear", state: "connecting" },
    ]);
  });

  test("live non-disconnected state is used when the catalog row is enabled", () => {
    expect(
      mergeMcpSurfaceEntries(
        [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
        live([{ name: "linear", state: "connected", tools: ["a", "b"] }]),
      ),
    ).toEqual([
      { name: "exa", state: "connecting", builtin: true },
      { name: "linear", state: "connected", toolCount: 2 },
    ]);
  });

  test("an Exa preset is builtin; a custom exa transport is not", () => {
    expect(mergeMcpSurfaceEntries([{ name: "exa", enabled: false }], live([]))).toEqual([
      { name: "exa", state: "disabled", builtin: true },
    ]);
    expect(
      mergeMcpSurfaceEntries(
        [{ name: "exa", type: "http", url: "https://custom.example/mcp" }],
        live([{ name: "exa", state: "connected", tools: ["search"] }]),
      ),
    ).toEqual([{ name: "exa", state: "connected", toolCount: 1 }]);
  });

  test("live builtin Exa config marks the implicit row builtin", () => {
    expect(
      mergeMcpSurfaceEntries([], live([{ name: "exa", state: "connected", tools: ["s"] }]), [
        createExaMCPServerConfig(),
      ]),
    ).toEqual([{ name: "exa", state: "connected", toolCount: 1, builtin: true }]);
  });
});
