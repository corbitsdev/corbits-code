import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGlobalSettingsWriter,
  createLocalSettingsWriter,
  isAbsoluteHTTPURL,
  persistGlobalHTTPMCPServer,
  persistLocalMCPServerEnabled,
  persistLocalMCPServerRemoved,
  persistMCPServerEnabled,
  persistMCPServerRemoved,
  removeMCPServerEntry,
  setMCPServerEntryEnabled,
} from "./add-server.js";
import { loadAuthState, mcpAuthDir, saveAuthState } from "./auth-store.js";
import { isReadOnlyMcpTool, mcpToolName } from "./tool-name.js";

const dirs: string[] = [];

async function settingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-mcp-add-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-mcp-home-"));
  dirs.push(dir);
  return dir;
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

const linearHTTP = {
  name: "linear",
  type: "http" as const,
  url: "https://mcp.linear.app/mcp",
};

const linearAuth = { serverName: "linear", serverURL: "https://mcp.linear.app/mcp" };

describe("setMCPServerEntryEnabled", () => {
  test("disables a transport row and omits enabled when re-enabled", () => {
    expect(setMCPServerEntryEnabled([linearHTTP], "linear", false)).toEqual([
      { ...linearHTTP, enabled: false },
    ]);
    expect(setMCPServerEntryEnabled([{ ...linearHTTP, enabled: false }], "linear", true)).toEqual([
      linearHTTP,
    ]);
  });

  test("upserts an Exa preset when the list is empty or already a preset", () => {
    expect(setMCPServerEntryEnabled([], "exa", false)).toEqual([{ name: "exa", enabled: false }]);
    expect(setMCPServerEntryEnabled([{ name: "exa", enabled: false }], "exa", true)).toEqual([
      { name: "exa", enabled: true },
    ]);
  });

  test("treats a custom transport named exa as a transport row", () => {
    const custom = { name: "exa", type: "http" as const, url: "https://custom.exa.test/mcp" };
    expect(setMCPServerEntryEnabled([custom], "exa", false)).toEqual([
      { ...custom, enabled: false },
    ]);
  });

  test("returns null for a missing non-exa name", () => {
    expect(setMCPServerEntryEnabled([linearHTTP], "other", false)).toBeNull();
  });
});

describe("removeMCPServerEntry", () => {
  test("drops a transport row and refuses an Exa preset", () => {
    expect(removeMCPServerEntry([linearHTTP, { name: "exa", enabled: true }], "linear")).toEqual({
      entries: [{ name: "exa", enabled: true }],
      removed: linearHTTP,
    });
    expect(removeMCPServerEntry([{ name: "exa", enabled: false }], "exa")).toBeNull();
    expect(removeMCPServerEntry([linearHTTP], "missing")).toBeNull();
  });
});

describe("persistMCPServerEnabled", () => {
  test("disables Linear HTTP with enabled false and omits enabled on enable", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    await writeFile(
      path,
      JSON.stringify({ providers: {}, showPromptCost: true, mcpServers: [linearHTTP] }),
    );
    await saveAuthState(linearAuth, { codeVerifier: "keep-me" }, home);
    const writer = createGlobalSettingsWriter(path);

    expect(await persistMCPServerEnabled(writer, "linear", false)).toMatchObject({
      ok: true,
      omitted: false,
      entries: [{ ...linearHTTP, enabled: false }],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      providers: {},
      showPromptCost: true,
      mcpServers: [{ ...linearHTTP, enabled: false }],
    });
    expect((await loadAuthState(linearAuth, home)).codeVerifier).toBe("keep-me");

    expect(await persistMCPServerEnabled(writer, "linear", true)).toMatchObject({
      ok: true,
      entries: [linearHTTP],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      providers: {},
      showPromptCost: true,
      mcpServers: [linearHTTP],
    });
  });

  test("disables injected Exa when mcpServers is empty", async () => {
    const path = await settingsPath();
    await writeFile(path, JSON.stringify({ providers: {} }));
    const writer = createGlobalSettingsWriter(path);

    expect(await persistMCPServerEnabled(writer, "exa", false)).toEqual({
      ok: true,
      entries: [{ name: "exa", enabled: false }],
      omitted: false,
      settings: { providers: {}, mcpServers: [{ name: "exa", enabled: false }] },
    });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers).toEqual([
      { name: "exa", enabled: false },
    ]);

    expect(await persistMCPServerEnabled(writer, "exa", true)).toMatchObject({
      ok: true,
      entries: [{ name: "exa", enabled: true }],
    });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers).toEqual([
      { name: "exa", enabled: true },
    ]);
  });

  test("does not convert a custom transport named exa into a preset", async () => {
    const path = await settingsPath();
    const custom = { name: "exa", type: "http" as const, url: "https://custom.exa.test/mcp" };
    await writeFile(path, JSON.stringify({ providers: {}, mcpServers: [custom] }));
    const writer = createGlobalSettingsWriter(path);

    expect(await persistMCPServerEnabled(writer, "exa", false)).toMatchObject({
      ok: true,
      entries: [{ ...custom, enabled: false }],
    });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers).toEqual([
      { ...custom, enabled: false },
    ]);
  });
});

describe("persistMCPServerRemoved", () => {
  test("removes Linear, keeps unrelated keys, and deletes that identity's auth file", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    await writeFile(
      path,
      JSON.stringify({
        providers: {},
        showPromptCost: true,
        mcpServers: [linearHTTP, { name: "other", type: "http", url: "https://other.test/mcp" }],
      }),
    );
    await saveAuthState(linearAuth, { codeVerifier: "linear-secret" }, home);
    const writer = createGlobalSettingsWriter(path);

    const result = await persistMCPServerRemoved(writer, "linear", home);
    expect(result).toMatchObject({
      ok: true,
      omitted: false,
      removed: linearHTTP,
      entries: [{ name: "other", type: "http", url: "https://other.test/mcp" }],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      providers: {},
      showPromptCost: true,
      mcpServers: [{ name: "other", type: "http", url: "https://other.test/mcp" }],
    });
    expect(await loadAuthState(linearAuth, home)).toEqual({});
  });

  test("treats a missing auth file as success", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    await writeFile(path, JSON.stringify({ providers: {}, mcpServers: [linearHTTP] }));
    const writer = createGlobalSettingsWriter(path);

    expect(await persistMCPServerRemoved(writer, "linear", home)).toMatchObject({
      ok: true,
      omitted: true,
      removed: linearHTTP,
      entries: [],
    });
  });

  test("omits the mcpServers key after removing the last server", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    await writeFile(
      path,
      JSON.stringify({ providers: {}, showPromptCost: true, mcpServers: [linearHTTP] }),
    );
    const writer = createGlobalSettingsWriter(path);

    const result = await persistMCPServerRemoved(writer, "linear", home);
    expect(result).toMatchObject({ ok: true, omitted: true, entries: [] });
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(saved).toEqual({ providers: {}, showPromptCost: true });
    expect("mcpServers" in saved).toBe(false);
    expect(await readFile(path, "utf8")).not.toContain("mcpServers");
  });

  test("refuses to remove an Exa preset and leaves disk unchanged", async () => {
    const path = await settingsPath();
    const original = JSON.stringify({
      providers: {},
      mcpServers: [{ name: "exa", enabled: false }],
    });
    await writeFile(path, original);
    const writer = createGlobalSettingsWriter(path);

    expect(await persistMCPServerRemoved(writer, "exa")).toEqual({
      ok: false,
      reason: "builtin-exa",
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("allows removing a custom transport named exa and deletes that url's auth", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    const custom = { name: "exa", type: "http" as const, url: "https://custom.exa.test/mcp" };
    const identity = { serverName: "exa", serverURL: custom.url };
    await writeFile(path, JSON.stringify({ providers: {}, mcpServers: [custom] }));
    await saveAuthState(identity, { codeVerifier: "custom-exa" }, home);
    const writer = createGlobalSettingsWriter(path);

    expect(await persistMCPServerRemoved(writer, "exa", home)).toMatchObject({
      ok: true,
      omitted: true,
      removed: custom,
    });
    expect("mcpServers" in JSON.parse(await readFile(path, "utf8"))).toBe(false);
    expect(await loadAuthState(identity, home)).toEqual({});
  });

  test("auth-delete failure after a successful write still returns ok", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    await writeFile(path, JSON.stringify({ providers: {}, mcpServers: [linearHTTP] }));
    await saveAuthState(linearAuth, { codeVerifier: "linear-secret" }, home);
    const authDir = mcpAuthDir(home);
    await chmod(authDir, 0o000);
    const writer = createGlobalSettingsWriter(path);
    try {
      const result = await persistMCPServerRemoved(writer, "linear", home);
      expect(result).toMatchObject({ ok: true, omitted: true, removed: linearHTTP, entries: [] });
      expect("mcpServers" in JSON.parse(await readFile(path, "utf8"))).toBe(false);
    } finally {
      await chmod(authDir, 0o700);
    }
  });
});

describe("local MCP persist", () => {
  test("mutates only the local path when disabling and removing linear", async () => {
    const globalPath = await settingsPath();
    const localPath = await settingsPath();
    const home = await tempHome();
    const globalOriginal = {
      providers: {},
      mcpServers: [{ name: "global-linear", type: "http", url: "https://global.test/mcp" }],
    };
    await writeFile(globalPath, JSON.stringify(globalOriginal));
    await writeFile(localPath, JSON.stringify({ provider: "a", mcpServers: [linearHTTP] }));
    await saveAuthState(linearAuth, { codeVerifier: "local-linear" }, home);
    const writer = createLocalSettingsWriter(localPath);

    expect(await persistLocalMCPServerEnabled(writer, "linear", false)).toMatchObject({
      ok: true,
      entries: [{ ...linearHTTP, enabled: false }],
      local: { provider: "a", mcpServers: [{ ...linearHTTP, enabled: false }] },
    });
    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual(globalOriginal);
    expect(JSON.parse(await readFile(localPath, "utf8"))).toEqual({
      provider: "a",
      mcpServers: [{ ...linearHTTP, enabled: false }],
    });

    const removed = await persistLocalMCPServerRemoved(writer, "linear", home);
    expect(removed).toMatchObject({
      ok: true,
      omitted: true,
      entries: [],
      removed: { ...linearHTTP, enabled: false },
    });
    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual(globalOriginal);
    const localSaved = JSON.parse(await readFile(localPath, "utf8")) as Record<string, unknown>;
    expect(localSaved).toEqual({ provider: "a" });
    expect("mcpServers" in localSaved).toBe(false);
    expect(await loadAuthState(linearAuth, home)).toEqual({});
  });

  test("auth-delete failure after a successful write still returns ok", async () => {
    const path = await settingsPath();
    const home = await tempHome();
    await writeFile(path, JSON.stringify({ provider: "a", mcpServers: [linearHTTP] }));
    await saveAuthState(linearAuth, { codeVerifier: "local-linear" }, home);
    const authDir = mcpAuthDir(home);
    await chmod(authDir, 0o000);
    const writer = createLocalSettingsWriter(path);
    try {
      const result = await persistLocalMCPServerRemoved(writer, "linear", home);
      expect(result).toMatchObject({ ok: true, omitted: true, removed: linearHTTP, entries: [] });
      expect("mcpServers" in JSON.parse(await readFile(path, "utf8"))).toBe(false);
    } finally {
      await chmod(authDir, 0o700);
    }
  });
});
