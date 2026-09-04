import { describe, expect, test } from "bun:test";
import { createExaMCPServerConfig } from "../mcp/exa.js";
import { nextMcpCatalog } from "./mcp-catalog.js";

const linear = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp" };
const globalLinear = {
  name: "global-linear",
  type: "http" as const,
  url: "https://global.test/mcp",
};
const customExa = { name: "exa", type: "http" as const, url: "https://custom.exa.test/mcp" };

describe("nextMcpCatalog", () => {
  test("omitted local unshadows the global settings list this session", () => {
    const next = nextMcpCatalog({
      source: "local",
      result: { ok: true, entries: [], omitted: true },
      globalServers: [globalLinear],
    });
    expect(next.mcpServersSource).toBe("global");
    expect(next.overlayEntries).toEqual([globalLinear]);
    expect(next.mcpServers.map((server) => server.name)).toContain("global-linear");
    expect(next.mcpServers.some((server) => server.name === "exa")).toBe(true);
  });

  test("omitted local with no global key becomes source none plus implicit Exa", () => {
    const next = nextMcpCatalog({
      source: "local",
      result: { ok: true, entries: [], omitted: true },
      globalServers: undefined,
    });
    expect(next.mcpServersSource).toBe("none");
    expect(next.overlayEntries).toEqual([]);
    expect(next.mcpServers).toEqual([createExaMCPServerConfig()]);
  });

  test("non-omitted local still shadows global", () => {
    const next = nextMcpCatalog({
      source: "local",
      result: { ok: true, entries: [linear], omitted: false },
      globalServers: [globalLinear],
    });
    expect(next.mcpServersSource).toBe("local");
    expect(next.overlayEntries).toEqual([linear]);
    expect(next.mcpServers.map((server) => server.name)).toContain("linear");
    expect(next.mcpServers.map((server) => server.name)).not.toContain("global-linear");
  });

  test("removing a custom-exa-only list resolves to builtin Exa", () => {
    const next = nextMcpCatalog({
      source: "global",
      result: { ok: true, entries: [], omitted: true, removed: customExa },
      globalServers: [customExa],
    });
    expect(next.overlayEntries).toEqual([]);
    expect(next.mcpServers).toEqual([createExaMCPServerConfig()]);
    expect(next.mcpServersSource).toBe("global");
  });
});
