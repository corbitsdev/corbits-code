import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGlobalSettingsWriter,
  isAbsoluteHTTPURL,
  persistGlobalHTTPMCPServer,
} from "./add-server.js";
import { isReadOnlyMcpTool, mcpToolName } from "./tool-name.js";

const dirs: string[] = [];

async function settingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-mcp-add-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("persistGlobalHTTPMCPServer", () => {
  test("adds an HTTP server without losing unrelated settings", async () => {
    const path = await settingsPath();
    await Bun.write(path, JSON.stringify({ providers: {}, showPromptCost: true }));
    const writer = createGlobalSettingsWriter(path);

    expect(
      await persistGlobalHTTPMCPServer(writer, "linear", "https://mcp.linear.app/mcp"),
    ).toEqual({
      ok: true,
      server: { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
      settings: {
        providers: {},
        showPromptCost: true,
        mcpServers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
      },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      providers: {},
      showPromptCost: true,
      mcpServers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
    });
  });

  test("rejects invalid input and duplicate names without mutation", async () => {
    const path = await settingsPath();
    const original = JSON.stringify({
      providers: {},
      mcpServers: [{ name: "linear", url: "https://existing.test/mcp" }],
    });
    await Bun.write(path, original);
    const writer = createGlobalSettingsWriter(path);

    expect(await persistGlobalHTTPMCPServer(writer, "", "https://example.test/mcp")).toEqual({
      ok: false,
      reason: "invalid-name",
    });
    expect(await persistGlobalHTTPMCPServer(writer, "other", "ftp://example.test/mcp")).toEqual({
      ok: false,
      reason: "invalid-url",
    });
    expect(await persistGlobalHTTPMCPServer(writer, "other", "relative/path")).toEqual({
      ok: false,
      reason: "invalid-url",
    });
    expect(await persistGlobalHTTPMCPServer(writer, "other", "https://.")).toEqual({
      ok: false,
      reason: "invalid-url",
    });
    expect(await persistGlobalHTTPMCPServer(writer, "other", "https://user:pass@host/mcp")).toEqual(
      { ok: false, reason: "invalid-url" },
    );
    expect(await persistGlobalHTTPMCPServer(writer, "linear", "https://new.test/mcp")).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("rejects delimiter-bearing names before they can spoof mutating tool permissions", async () => {
    const path = await settingsPath();
    const original = JSON.stringify({ providers: {}, showPromptCost: true });
    await writeFile(path, original);
    const spoofingName = "linear__list_projects";

    expect(isReadOnlyMcpTool(mcpToolName(spoofingName, "delete_issue"))).toBe(true);
    expect(
      await persistGlobalHTTPMCPServer(
        createGlobalSettingsWriter(path),
        spoofingName,
        "https://mcp.linear.app/mcp",
      ),
    ).toEqual({ ok: false, reason: "invalid-name" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("blocks global mutation while local MCP settings shadow it", async () => {
    const path = await settingsPath();
    const original = JSON.stringify({ providers: {}, showPromptCost: true });
    await writeFile(path, original);
    const writer = createGlobalSettingsWriter(path);

    expect(
      await persistGlobalHTTPMCPServer(writer, "linear", "https://mcp.linear.app/mcp", "local"),
    ).toEqual({ ok: false, reason: "local-shadow" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("rejects degenerate and credential-bearing HTTP URLs", () => {
    expect(isAbsoluteHTTPURL("relative/path")).toBe(false);
    expect(isAbsoluteHTTPURL("ftp://example.test/mcp")).toBe(false);
    expect(isAbsoluteHTTPURL("https://.")).toBe(false);
    expect(isAbsoluteHTTPURL("https:example.com")).toBe(false);
    expect(isAbsoluteHTTPURL("https:////evil.com")).toBe(false);
    expect(isAbsoluteHTTPURL("https://user:pass@host/mcp")).toBe(false);
    expect(isAbsoluteHTTPURL("https://mcp.linear.app/mcp")).toBe(true);
  });

  test("persists the normalized href rather than the typed URL", async () => {
    const path = await settingsPath();
    await Bun.write(path, JSON.stringify({ providers: {} }));
    const writer = createGlobalSettingsWriter(path);

    expect(
      await persistGlobalHTTPMCPServer(writer, "linear", "https://CUSTOM.example:443/mcp"),
    ).toMatchObject({
      ok: true,
      server: { name: "linear", type: "http", url: "https://custom.example/mcp" },
    });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers).toEqual([
      { name: "linear", type: "http", url: "https://custom.example/mcp" },
    ]);
  });

  test("serializes a delayed MCP add with hook and plugin mutation", async () => {
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ providers: {}, showPromptCost: true }));
    let releaseFirstLoad: (() => void) | undefined;
    let firstLoadStarted: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      firstLoadStarted = resolve;
    });
    let loads = 0;
    const writer = createGlobalSettingsWriter(path, {
      load: async (settingsFile) => {
        const settings = JSON.parse(await readFile(settingsFile, "utf8"));
        loads += 1;
        if (loads === 1) {
          firstLoadStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstLoad = resolve;
          });
        }
        return settings;
      },
    });

    const add = persistGlobalHTTPMCPServer(writer, "linear", "https://mcp.linear.app/mcp");
    await firstLoad;
    const admin = writer.mutate((base) => ({
      ...base,
      hooks: { audit: { enabled: false } },
      plugins: { linear: { enabled: true } },
    }));
    releaseFirstLoad?.();
    await Promise.all([add, admin]);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      showPromptCost: true,
      hooks: { audit: { enabled: false } },
      plugins: { linear: { enabled: true } },
      mcpServers: [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
    });
  });

  test("checks duplicates inside serialized fresh-disk mutations", async () => {
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ providers: {} }));
    const writer = createGlobalSettingsWriter(path);

    const [first, second] = await Promise.all([
      persistGlobalHTTPMCPServer(writer, "linear", "https://one.test/mcp"),
      persistGlobalHTTPMCPServer(writer, "linear", "https://two.test/mcp"),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.mcpServers).toHaveLength(1);
  });
});
