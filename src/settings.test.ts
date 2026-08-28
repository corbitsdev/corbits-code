import { describe, test, expect } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { OPENCODE_GO_BASE_URL } from "../packages/opencode-go/src/index.js";
import {
  isLocalSettings,
  isSettings,
  healOpenCodeGoProviders,
  loadLocalSettings,
  loadLocalSettingsWriteBase,
  loadSettings,
  loadSettingsRecoveringClobberedOAuthSelection,
  normalizeOpenAICompatibleBaseURL,
  resolveProvider,
  saveGlobalSettings,
  saveLocalSettings,
  type ProviderSettings,
  type Settings,
  toolWatchdogFromSettings,
  loadGlobalSettingsWriteBase,
  persistSkipPermissionsDefault,
  markLastChangelogVersion,
  pushRecentModel,
  toggleFavoriteModel,
  setDefaultModel,
  listRecentModels,
  listFavoriteModels,
  normalizeMcpServers,
} from "./config/settings.js";

const firepass: Settings = {
  defaultProvider: "firepass",
  providers: {
    firepass: {
      baseURL: "https://firepass.example/v1",
      apiKey: "fp-key",
      models: ["fp-large", "fp-small"],
      defaultModel: "fp-large",
    },
  },
};

const twoProviders: Settings = {
  defaultProvider: "a",
  providers: {
    a: { baseURL: "https://a/v1", apiKey: "a-key", models: ["a-model"] },
    b: { baseURL: "https://b/v1", apiKey: "b-key", models: ["b-model"], defaultModel: "b-model" },
  },
};

describe("MCP settings validation", () => {
  test("accepts the Exa preset enabled or disabled in object and array forms", () => {
    expect(normalizeMcpServers({ exa: { enabled: true } })).toEqual([
      { name: "exa", enabled: true },
    ]);
    expect(normalizeMcpServers({ exa: { enabled: false } })).toEqual([
      { name: "exa", enabled: false },
    ]);
    expect(normalizeMcpServers([{ name: "exa", enabled: true }])).toEqual([
      { name: "exa", enabled: true },
    ]);
    expect(normalizeMcpServers([{ name: "exa", enabled: false }])).toEqual([
      { name: "exa", enabled: false },
    ]);
  });

  test("rejects empty, unknown transport-less, and mixed preset entries", () => {
    expect(normalizeMcpServers({ exa: {} })).toBeUndefined();
    expect(normalizeMcpServers({ unknown: { enabled: true } })).toBeUndefined();
    expect(normalizeMcpServers({ unknown: { enabled: false } })).toBeUndefined();
    expect(
      normalizeMcpServers({ exa: { enabled: true, url: "https://mcp.exa.ai/mcp" } }),
    ).toBeUndefined();
    expect(normalizeMcpServers({ exa: { enabled: false, command: "custom-exa" } })).toBeUndefined();
  });

  test("preserves a custom transport-bearing server named Exa", () => {
    expect(normalizeMcpServers({ exa: { url: "https://example.test/custom" } })).toEqual([
      { name: "exa", url: "https://example.test/custom" },
    ]);
  });
});

describe("normalizeOpenAICompatibleBaseURL", () => {
  test("preserves a plain base URL", () => {
    expect(normalizeOpenAICompatibleBaseURL("https://provider.example.com/v1")).toBe(
      "https://provider.example.com/v1",
    );
  });

  test("removes a trailing slash from a base URL", () => {
    expect(normalizeOpenAICompatibleBaseURL("https://provider.example.com/v1/")).toBe(
      "https://provider.example.com/v1",
    );
  });

  test("normalizes a full chat completions endpoint to its base URL", () => {
    expect(
      normalizeOpenAICompatibleBaseURL("https://provider.example.com/v1/chat/completions"),
    ).toBe("https://provider.example.com/v1");
  });

  test("normalizes a full chat completions endpoint with trailing slash", () => {
    expect(
      normalizeOpenAICompatibleBaseURL("https://provider.example.com/v1/chat/completions/"),
    ).toBe("https://provider.example.com/v1");
  });

  test("trims whitespace around pasted URLs", () => {
    expect(normalizeOpenAICompatibleBaseURL("  https://provider.example.com/v1  ")).toBe(
      "https://provider.example.com/v1",
    );
  });

  test("accepts localhost http URLs", () => {
    expect(normalizeOpenAICompatibleBaseURL("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1",
    );
  });

  test("strips query and hash from pasted endpoint URLs", () => {
    expect(
      normalizeOpenAICompatibleBaseURL("https://provider.example.com/v1/chat/completions?x=1#frag"),
    ).toBe("https://provider.example.com/v1");
  });

  test("rejects malformed URL input with an actionable error", () => {
    expect(() => normalizeOpenAICompatibleBaseURL("provider.example.com/v1")).toThrow(
      /expected an absolute URL/,
    );
  });

  test("rejects non-http URL schemes", () => {
    expect(() => normalizeOpenAICompatibleBaseURL("file:///tmp/provider")).toThrow(
      /expected http or https/,
    );
  });
});

describe("resolveProvider", () => {
  test("file mode uses defaultProvider and defaultModel", () => {
    const r = resolveProvider({ settings: firepass, local: null, cli: {} });
    expect(r).toEqual({
      providerName: "firepass",
      baseURL: "https://firepass.example/v1",
      apiKey: "fp-key",
      model: "fp-large",
    });
  });

  test("file mode normalizes configured provider baseURL", () => {
    const settings: Settings = {
      providers: {
        only: {
          baseURL: "https://o/v1/chat/completions/",
          apiKey: "o-key",
          models: ["m"],
        },
      },
    };
    const r = resolveProvider({ settings, local: null, cli: {} });
    expect(r.baseURL).toBe("https://o/v1");
  });

  test("falls back to the first model when no defaultModel", () => {
    const settings: Settings = {
      providers: {
        only: { baseURL: "https://o/v1", apiKey: "o-key", models: ["first", "second"] },
      },
    };
    const r = resolveProvider({ settings, local: null, cli: {} });
    expect(r.model).toBe("first");
    expect(r.providerName).toBe("only");
  });

  test("a sole provider is used without a defaultProvider", () => {
    const settings: Settings = {
      providers: { solo: { baseURL: "https://s/v1", apiKey: "s-key", models: ["s-model"] } },
    };
    const r = resolveProvider({ settings, local: null, cli: {} });
    expect(r.providerName).toBe("solo");
  });

  test("local selection overrides defaultProvider", () => {
    const r = resolveProvider({ settings: twoProviders, local: { provider: "b" }, cli: {} });
    expect(r.providerName).toBe("b");
    expect(r.apiKey).toBe("b-key");
    expect(r.model).toBe("b-model");
  });

  test("cli provider overrides local selection", () => {
    const r = resolveProvider({
      settings: twoProviders,
      local: { provider: "a" },
      cli: { provider: "b" },
    });
    expect(r.providerName).toBe("b");
  });

  test("model precedence: cli > local > defaultModel", () => {
    const cli = resolveProvider({
      settings: firepass,
      local: { model: "fp-small" },
      cli: { model: "cli-model" },
    });
    expect(cli.model).toBe("cli-model");

    const local = resolveProvider({
      settings: firepass,
      local: { model: "fp-small" },
      cli: {},
    });
    expect(local.model).toBe("fp-small");
  });

  test("throws when cli provider is not configured", () => {
    expect(() =>
      resolveProvider({ settings: twoProviders, local: null, cli: { provider: "c" } }),
    ).toThrow(/not found/);
  });

  test("names the offending provider when a local selection is not configured", () => {
    expect(() =>
      resolveProvider({ settings: twoProviders, local: { provider: "zzz" }, cli: {} }),
    ).toThrow(/Selected provider "zzz" is not configured/);
  });

  test("names the offending provider when defaultProvider is a typo", () => {
    const settings: Settings = {
      defaultProvider: "typo",
      providers: { solo: { baseURL: "https://s/v1", apiKey: "s-key", models: ["s-model"] } },
    };
    expect(() => resolveProvider({ settings, local: null, cli: {} })).toThrow(
      /Selected provider "typo" is not configured/,
    );
  });

  test("throws listing every missing field", () => {
    expect(() => resolveProvider({ settings: null, local: null, cli: {} })).toThrow(
      /missing: provider, baseURL, apiKey, model/,
    );
  });
});

describe("validators", () => {
  test("isSettings rejects a provider missing baseURL", () => {
    expect(isSettings({ providers: { x: { apiKey: "k", models: ["m"] } } })).toBe(false);
  });

  test("isSettings accepts a valid shape", () => {
    expect(isSettings(firepass)).toBe(true);
  });

  test("isSettings accepts bifrostVirtualKey and agentModelFallback", () => {
    expect(
      isSettings({
        providers: {
          bf: {
            baseURL: "http://b:8080/v1",
            apiKey: "sk-bf-k",
            models: ["m"],
            bifrostVirtualKey: true,
          },
        },
        agentModelFallback: "none",
      }),
    ).toBe(true);
  });

  test("isSettings accepts recentModels and favoriteModels", () => {
    expect(
      isSettings({
        providers: firepass.providers,
        recentModels: [{ provider: "firepass", model: "fp-large" }],
        favoriteModels: [{ provider: "firepass", model: "fp-small" }],
      }),
    ).toBe(true);
  });

  test("isSettings rejects malformed recentModels entries", () => {
    expect(
      isSettings({
        providers: firepass.providers,
        recentModels: [{ provider: "firepass" }],
      }),
    ).toBe(false);
  });

  test("isSettings accepts showPromptCost", () => {
    expect(isSettings({ providers: firepass.providers, showPromptCost: true })).toBe(true);
  });

  test("isSettings accepts dangerouslySkipPermissions", () => {
    expect(isSettings({ providers: firepass.providers, dangerouslySkipPermissions: true })).toBe(
      true,
    );
  });

  test("isLocalSettings rejects credentials", () => {
    expect(isLocalSettings({ provider: "a", apiKey: "leak" })).toBe(false);
  });

  test("isLocalSettings accepts selection only", () => {
    expect(isLocalSettings({ provider: "a", model: "m" })).toBe(true);
    expect(isLocalSettings({})).toBe(true);
  });

  test("isLocalSettings accepts a valid reasoningEffort", () => {
    expect(isLocalSettings({ model: "m", reasoningEffort: "high" })).toBe(true);
    // "none" is OpenAI's explicit disable-reasoning value, a real level.
    expect(isLocalSettings({ reasoningEffort: "none" })).toBe(true);
  });

  test("isLocalSettings rejects an invalid reasoningEffort", () => {
    expect(isLocalSettings({ reasoningEffort: "legendary" })).toBe(false);
    expect(isLocalSettings({ reasoningEffort: 5 })).toBe(false);
  });

  test("isLocalSettings accepts a valid env map", () => {
    expect(isLocalSettings({ env: { FOO: "bar", BAZ: "qux" } })).toBe(true);
    expect(isLocalSettings({ env: {} })).toBe(true);
  });

  test("isLocalSettings rejects a malformed env map", () => {
    expect(isLocalSettings({ env: { FOO: 5 } })).toBe(false);
    expect(isLocalSettings({ env: "not-an-object" })).toBe(false);
    expect(isLocalSettings({ env: { FOO: { nested: true } } })).toBe(false);
  });
});

describe("healOpenCodeGoProviders", () => {
  test("pins flag and canonical baseURL for custom name with Go URL", () => {
    const settings: Settings = {
      providers: {
        "go/personal": {
          baseURL: "https://opencode.ai/zen/go/v1",
          apiKey: "sk-go",
          models: ["kimi-k2.7-code"],
        },
      },
    };
    expect(healOpenCodeGoProviders(settings)).toEqual(["go/personal"]);
    expect(settings.providers["go/personal"]?.opencodeGo).toBe(true);
    expect(settings.providers["go/personal"]?.baseURL).toBe(OPENCODE_GO_BASE_URL);
  });

  test("leaves bare Zen providers alone", () => {
    const settings: Settings = {
      providers: {
        zen: {
          baseURL: "https://opencode.ai/zen/v1",
          apiKey: "sk-zen",
          models: ["claude-sonnet-4-5"],
        },
      },
    };
    expect(healOpenCodeGoProviders(settings)).toEqual([]);
    expect(settings.providers.zen?.opencodeGo).toBeUndefined();
    expect(settings.providers.zen?.baseURL).toBe("https://opencode.ai/zen/v1");
  });

  test("is a no-op when already pinned", () => {
    const settings: Settings = {
      providers: {
        "opencode-go": {
          baseURL: OPENCODE_GO_BASE_URL,
          apiKey: "sk-go",
          models: ["kimi-k2.7-code"],
          opencodeGo: true,
        },
      },
    };
    expect(healOpenCodeGoProviders(settings)).toEqual([]);
  });

  test("does not heal host spoofs or /zen/goodies paths", () => {
    const settings: Settings = {
      providers: {
        spoof: {
          baseURL: "https://not-opencode.ai/zen/go/v1",
          apiKey: "sk",
          models: ["kimi-k2.7-code"],
        },
        goodies: {
          baseURL: "https://opencode.ai/zen/goodies",
          apiKey: "sk",
          models: ["kimi-k2.7-code"],
        },
      },
    };
    expect(healOpenCodeGoProviders(settings)).toEqual([]);
    expect(settings.providers.spoof?.opencodeGo).toBeUndefined();
    expect(settings.providers.goodies?.opencodeGo).toBeUndefined();
  });

  test("private gateway host is not healed by URL alone (needs flag or known name)", () => {
    // Intentional FN: product URL matcher is public-host only (opencode.ai).
    // Private reverse proxies must set opencodeGo or use the known provider id.
    const settings: Settings = {
      providers: {
        "go-proxy": {
          baseURL: "https://go.internal.example/zen/go/v1",
          apiKey: "sk-go",
          models: ["kimi-k2.7-code"],
        },
      },
    };
    expect(healOpenCodeGoProviders(settings)).toEqual([]);
    expect(settings.providers["go-proxy"]?.opencodeGo).toBeUndefined();
    expect(settings.providers["go-proxy"]?.baseURL).toBe("https://go.internal.example/zen/go/v1");
  });
});

describe("loaders", () => {
  test("loadSettings heals Go-by-URL providers onto disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            "go/personal": {
              baseURL: "https://opencode.ai/zen/go",
              apiKey: "sk-go",
              models: ["kimi-k2.7-code"],
            },
          },
        }),
      );
      const loaded = await loadSettings(path);
      expect(loaded?.providers["go/personal"]?.opencodeGo).toBe(true);
      expect(loaded?.providers["go/personal"]?.baseURL).toBe(OPENCODE_GO_BASE_URL);
      // Hard cutover: rewritten on disk, not only in memory.
      const reloaded = await loadSettings(path);
      expect(reloaded?.providers["go/personal"]?.opencodeGo).toBe(true);
      expect(reloaded?.providers["go/personal"]?.baseURL).toBe(OPENCODE_GO_BASE_URL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings does not rewrite disk when heal is a no-op", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      const alreadyPinned = {
        providers: {
          "opencode-go": {
            baseURL: OPENCODE_GO_BASE_URL,
            apiKey: "sk-go",
            models: ["kimi-k2.7-code"],
            opencodeGo: true,
          },
        },
      };
      await writeFile(path, JSON.stringify(alreadyPinned));
      const before = await readFile(path, "utf8");
      const beforeStat = await stat(path);
      // Ensure mtime resolution has room to move if a write sneaks in.
      await Bun.sleep(20);
      const loaded = await loadSettings(path);
      expect(loaded?.providers["opencode-go"]?.opencodeGo).toBe(true);
      const after = await readFile(path, "utf8");
      const afterStat = await stat(path);
      expect(after).toBe(before);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings logs healed provider ids when heal mutates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (originalWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(
        chunk,
        ...rest,
      );
    }) as typeof process.stderr.write;
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            "go/personal": {
              baseURL: "https://opencode.ai/zen/go",
              apiKey: "sk-go",
              models: ["kimi-k2.7-code"],
            },
            zen: {
              baseURL: "https://opencode.ai/zen/v1",
              apiKey: "sk-zen",
              models: ["claude-sonnet-4-5"],
            },
          },
        }),
      );
      await loadSettings(path);
      const notice = writes.find((w) => w.includes("healed OpenCode Go providers"));
      expect(notice).toBeDefined();
      expect(notice).toContain("go/personal");
      expect(notice).not.toContain("zen");
    } finally {
      process.stderr.write = originalWrite;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings stays quiet on heal no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (originalWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(
        chunk,
        ...rest,
      );
    }) as typeof process.stderr.write;
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            "opencode-go": {
              baseURL: OPENCODE_GO_BASE_URL,
              apiKey: "sk-go",
              models: ["kimi-k2.7-code"],
              opencodeGo: true,
            },
          },
        }),
      );
      await loadSettings(path);
      expect(writes.some((w) => w.includes("healed OpenCode Go providers"))).toBe(false);
    } finally {
      process.stderr.write = originalWrite;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings keeps in-memory heal when disk save fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            "go/personal": {
              baseURL: "https://opencode.ai/zen/go",
              apiKey: "sk-go",
              models: ["kimi-k2.7-code"],
            },
          },
        }),
      );
      // Read-only dir: heal save (temp write + rename) fails; load must not throw.
      await chmod(dir, 0o555);
      const loaded = await loadSettings(path);
      expect(loaded?.providers["go/personal"]?.opencodeGo).toBe(true);
      expect(loaded?.providers["go/personal"]?.baseURL).toBe(OPENCODE_GO_BASE_URL);
    } finally {
      await chmod(dir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings returns null for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      expect(await loadSettings(join(dir, "nope.json"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings throws on an invalid schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(path, JSON.stringify({ providers: { x: { models: [] } } }));
      await expect(loadSettings(path)).rejects.toThrow(/Invalid settings schema/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings keeps local selection recovery out of the strict loader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(path, JSON.stringify({ provider: "codex/work", model: "gpt-5.1-codex" }));
      await expect(loadSettings(path)).rejects.toThrow(/Invalid settings schema/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["one profile", ["codex/work"]],
    ["multiple profiles", ["codex/personal", "codex/work"]],
  ])(
    "loadSettingsRecoveringClobberedOAuthSelection recovers an exact OAuth selection with %s",
    async (_name, providerNames) => {
      const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
      try {
        const path = join(dir, "settings.json");
        await writeFile(path, JSON.stringify({ provider: "codex/work", model: "gpt-5.1-codex" }));
        const projected = Object.fromEntries(
          providerNames.map((name) => [
            name,
            {
              baseURL: "https://chatgpt.com/backend-api",
              apiKey: "oauth-token",
              models: ["gpt-5.2-codex", "gpt-5.1-codex"],
              defaultModel: "gpt-5.2-codex",
            } satisfies ProviderSettings,
          ]),
        );

        const recovered = await loadSettingsRecoveringClobberedOAuthSelection(path, projected, {
          persist: true,
        });
        expect(recovered).toEqual({
          defaultProvider: "codex/work",
          providers: {
            "codex/work": {
              baseURL: "https://chatgpt.com/backend-api",
              models: ["gpt-5.1-codex"],
              defaultModel: "gpt-5.1-codex",
            },
          },
        });
        expect(JSON.stringify(recovered)).not.toContain("oauth-token");
        expect(await loadSettings(path)).toEqual(recovered);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("loadSettingsRecoveringClobberedOAuthSelection recovers a non-catalog OAuth model when the auth profile exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({ provider: "codex/work", model: "gpt-special-custom" }),
      );
      const recovered = await loadSettingsRecoveringClobberedOAuthSelection(
        path,
        {
          "codex/work": {
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "oauth-token",
            models: ["gpt-5.2-codex", "gpt-5.1-codex"],
            defaultModel: "gpt-5.2-codex",
          },
        },
        { persist: true },
      );
      expect(recovered).toEqual({
        defaultProvider: "codex/work",
        providers: {
          "codex/work": {
            baseURL: "https://chatgpt.com/backend-api",
            models: ["gpt-special-custom"],
            defaultModel: "gpt-special-custom",
          },
        },
      });
      expect(JSON.stringify(recovered)).not.toContain("oauth-token");
      expect(await loadSettings(path)).toEqual(recovered);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings keeps malformed clobber documents strict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({ provider: "codex/work", model: "gpt-5.1-codex", apiKey: "nope" }),
      );
      await expect(
        loadSettingsRecoveringClobberedOAuthSelection(
          path,
          {
            "codex/work": {
              baseURL: "https://chatgpt.com/backend-api",
              apiKey: "oauth-token",
              models: ["gpt-5.1-codex"],
            },
          },
          { persist: true },
        ),
      ).rejects.toThrow(/Invalid settings schema/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings fails closed on unmatched OAuth selections without touching the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      const original = JSON.stringify({ provider: "codex/missing", model: "gpt-5.1-codex" });
      await writeFile(path, original);
      await expect(
        loadSettingsRecoveringClobberedOAuthSelection(
          path,
          {
            "codex/work": {
              baseURL: "https://chatgpt.com/backend-api",
              apiKey: "oauth-token",
              models: ["gpt-5.1-codex"],
            },
          },
          { persist: true },
        ),
      ).rejects.toThrow(/Invalid settings schema/);
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettingsRecoveringClobberedOAuthSelection leaves the file unchanged when persist is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      const original = JSON.stringify({ provider: "codex/work", model: "gpt-5.1-codex" });
      await writeFile(path, original);
      const recovered = await loadSettingsRecoveringClobberedOAuthSelection(
        path,
        {
          "codex/work": {
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "oauth-token",
            models: ["gpt-5.1-codex"],
          },
        },
        { persist: false },
      );
      expect(recovered?.defaultProvider).toBe("codex/work");
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings preserves bifrostVirtualKey and agentModelFallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: {
            bf: {
              baseURL: "http://b:8080/v1",
              apiKey: "k",
              models: ["m"],
              bifrostVirtualKey: true,
            },
          },
          agentModelFallback: "active",
        }),
      );
      const loaded = await loadSettings(path);
      expect(loaded?.providers.bf?.bifrostVirtualKey).toBe(true);
      expect(loaded?.agentModelFallback).toBe("active");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings preserves plugin and web-provider fields through a round trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          providers: { a: { baseURL: "https://a/v1", apiKey: "k", models: ["m"] } },
          workflowProfiles: { fast: { implement: "m" } },
          web: "exa",
          plugins: { exa: { enabled: true, credentials: { apiKey: "exa-key" } } },
          pluginPaths: ["/abs/plugins/exa", "./local-plugin"],
          discoverClaudePlugins: true,
        }),
      );
      const loaded = await loadSettings(path);
      expect(loaded?.workflowProfiles).toEqual({ fast: { implement: "m" } });
      expect(loaded?.web).toBe("exa");
      expect(loaded?.plugins).toEqual({
        exa: { enabled: true, credentials: { apiKey: "exa-key" } },
      });
      expect(loaded?.pluginPaths).toEqual(["/abs/plugins/exa", "./local-plugin"]);
      expect(loaded?.discoverClaudePlugins).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettings fails open on credentials and unknown keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      await mkdir(join(dir, ".corbits"), { recursive: true });
      const path = join(dir, ".corbits", "settings.json");
      await writeFile(
        path,
        JSON.stringify({ provider: "a", model: "m1", apiKey: "leak", providers: {}, weird: true }),
      );
      // Must not throw — app starts with known keys applied.
      const loaded = await loadLocalSettings(path);
      expect(loaded).toEqual({ provider: "a", model: "m1" });
      // Credentials never load.
      expect(loaded).not.toHaveProperty("apiKey");
      const { loadLocalSettingsResult } = await import("./config/settings.js");
      const result = await loadLocalSettingsResult(path);
      expect(result.settings).toEqual({ provider: "a", model: "m1" });
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.some((d) => /credential|apiKey|unknown/i.test(d.message))).toBe(
        true,
      );
      expect(result.diagnostics.every((d) => d.fix.length > 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettings fails open on invalid JSON with diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await writeFile(path, "{ not json");
      expect(await loadLocalSettings(path)).toBeNull();
      const { loadLocalSettingsResult } = await import("./config/settings.js");
      const result = await loadLocalSettingsResult(path);
      expect(result.settings).toBeNull();
      expect(result.diagnostics.some((d) => /Invalid JSON/i.test(d.message))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettingsWriteBase distinguishes absent, cleaned, and unusable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      // Absent: empty base is safe to create.
      expect(await loadLocalSettingsWriteBase(path)).toEqual({});

      // Partial fail-open: cleaned known fields are the base.
      await writeFile(
        path,
        JSON.stringify({ provider: "a", model: "m1", apiKey: "leak", weird: true }),
      );
      expect(await loadLocalSettingsWriteBase(path)).toEqual({ provider: "a", model: "m1" });

      // Invalid JSON: skip write — do not collapse to {}.
      await writeFile(path, "{ not json");
      expect(await loadLocalSettingsWriteBase(path)).toBeNull();

      // Non-object: skip write.
      await writeFile(path, JSON.stringify(["not", "object"]));
      expect(await loadLocalSettingsWriteBase(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadSettings preserves tools block through a round trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      const withTools: Settings = {
        ...firepass,
        tools: { timeoutMs: 120_000, maxTimeoutMs: 600_000, waitForApproval: false },
      };
      await saveGlobalSettings(path, withTools);
      const loaded = await loadSettings(path);
      expect(loaded?.tools).toEqual({
        timeoutMs: 120_000,
        maxTimeoutMs: 600_000,
        waitForApproval: false,
      });
      expect(loaded).toEqual(withTools);
      expect(toolWatchdogFromSettings(loaded)).toEqual({
        defaultMs: 120_000,
        maxMs: 600_000,
        waitForApproval: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadGlobalSettingsWriteBase distinguishes absent from unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      // Absent file: a fresh minimal base is a safe write target.
      expect(await loadGlobalSettingsWriteBase(path)).toEqual({ providers: {} });

      // Readable file: its contents are the base.
      await saveGlobalSettings(path, firepass);
      expect(await loadGlobalSettingsWriteBase(path)).toEqual(firepass);

      // Unreadable file: null so the caller skips the write instead of
      // overwriting the whole settings file with a minimal base.
      await writeFile(path, "{ not json");
      expect(await loadGlobalSettingsWriteBase(path)).toBeNull();

      await writeFile(path, JSON.stringify({ providers: "wrong-shape" }));
      expect(await loadGlobalSettingsWriteBase(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("toolWatchdogFromSettings maps waitForApproval alone", () => {
    expect(toolWatchdogFromSettings({ providers: {}, tools: { waitForApproval: true } })).toEqual({
      waitForApproval: true,
    });
    expect(toolWatchdogFromSettings({ providers: {} })).toBeUndefined();
  });

  test("toolWatchdogFromSettings maps mcp.timeoutMs alone (no tools.* set)", () => {
    expect(toolWatchdogFromSettings({ providers: {}, mcp: { timeoutMs: 45_000 } })).toEqual({
      mcpTimeoutMs: 45_000,
    });
  });

  test("toolWatchdogFromSettings merges mcp.timeoutMs alongside tools.*", () => {
    expect(
      toolWatchdogFromSettings({
        providers: {},
        tools: { timeoutMs: 120_000, maxTimeoutMs: 600_000 },
        mcp: { timeoutMs: 45_000 },
      }),
    ).toEqual({ defaultMs: 120_000, maxMs: 600_000, mcpTimeoutMs: 45_000 });
  });
});

describe("persistSkipPermissionsDefault", () => {
  test("writes true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await saveGlobalSettings(path, firepass);
      expect(await persistSkipPermissionsDefault(path, true)).toBe("ok");
      expect(await loadSettings(path)).toEqual({
        ...firepass,
        dangerouslySkipPermissions: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      await saveGlobalSettings(path, { ...firepass, dangerouslySkipPermissions: true });
      expect(await persistSkipPermissionsDefault(path, false)).toBe("ok");
      expect(await loadSettings(path)).toEqual({
        ...firepass,
        dangerouslySkipPermissions: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips invalid or unreadable settings and leaves the file unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      const garbage = "{ not json";
      await writeFile(path, garbage);
      expect(await persistSkipPermissionsDefault(path, true)).toBe("skipped");
      expect(await readFile(path, "utf8")).toBe(garbage);

      const wrongShape = JSON.stringify({ providers: "wrong-shape" });
      await writeFile(path, wrongShape);
      expect(await persistSkipPermissionsDefault(path, true)).toBe("skipped");
      expect(await readFile(path, "utf8")).toBe(wrongShape);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionMode", () => {
  test("loadSettings drops legacy single sessionMode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ ...firepass, sessionMode: "single" }, null, 2) + "\n",
        "utf8",
      );
      // CL-5814: "single" still loads without error, then is stripped.
      expect(await loadSettings(path)).toEqual(firepass);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettings round-trips orchestrator sessionMode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-local-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveLocalSettings(path, { provider: "a", sessionMode: "orchestrator" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "a", sessionMode: "orchestrator" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid sessionMode", () => {
    expect(isSettings({ providers: firepass.providers, sessionMode: "fleet" })).toBe(false);
    expect(isLocalSettings({ provider: "a", sessionMode: 1 })).toBe(false);
  });
});

test("loadSettings round-trips showPromptCost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
  try {
    const path = join(dir, ".corbits", "settings.json");
    await saveGlobalSettings(path, { ...firepass, showPromptCost: true });
    expect(await loadSettings(path)).toEqual({ ...firepass, showPromptCost: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings round-trips dangerouslySkipPermissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
  try {
    const path = join(dir, ".corbits", "settings.json");
    await saveGlobalSettings(path, { ...firepass, dangerouslySkipPermissions: true });
    expect(await loadSettings(path)).toEqual({ ...firepass, dangerouslySkipPermissions: true });
    await saveGlobalSettings(path, { ...firepass, dangerouslySkipPermissions: false });
    expect(await loadSettings(path)).toEqual({ ...firepass, dangerouslySkipPermissions: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings tolerates a legacy maxConcurrentSubAgents key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
  try {
    const path = join(dir, ".corbits", "settings.json");
    await mkdir(join(dir, ".corbits"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ ...firepass, maxConcurrentSubAgents: 6 }, null, 2),
      "utf8",
    );
    expect(await loadSettings(path)).toEqual(firepass);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("lastChangelogVersion", () => {
  test("isSettings accepts a version string", () => {
    expect(
      isSettings({
        providers: firepass.providers,
        lastChangelogVersion: "0.2.86",
      }),
    ).toBe(true);
  });

  test("loadSettings round-trips lastChangelogVersion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveGlobalSettings(path, { ...firepass, lastChangelogVersion: "0.2.85" });
      expect(await loadSettings(path)).toEqual({ ...firepass, lastChangelogVersion: "0.2.85" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("markLastChangelogVersion stamps without clobbering other fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveGlobalSettings(path, { ...firepass, onboarded: true });
      await markLastChangelogVersion(path, "0.2.86");
      const loaded = await loadSettings(path);
      expect(loaded?.lastChangelogVersion).toBe("0.2.86");
      expect(loaded?.onboarded).toBe(true);
      expect(loaded?.defaultProvider).toBe("firepass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("markLastChangelogVersion ignores empty versions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveGlobalSettings(path, firepass);
      await markLastChangelogVersion(path, "  ");
      expect(await loadSettings(path)).toEqual(firepass);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saveGlobalSettings", () => {
  test("round-trips a settings object through loadSettings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveGlobalSettings(path, firepass);
      expect(await loadSettings(path)).toEqual(firepass);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the .corbits directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "nested", ".corbits", "settings.json");
      await saveGlobalSettings(path, firepass);
      const loaded = await loadSettings(path);
      expect(loaded?.defaultProvider).toBe("firepass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to write invalid settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      const invalid = { providers: { x: { models: [] } } } as unknown as Settings;
      await expect(saveGlobalSettings(path, invalid)).rejects.toThrow(/invalid global settings/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saveLocalSettings", () => {
  test("round-trips a selection through loadLocalSettings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveLocalSettings(path, { provider: "firepass", model: "fp-small" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "firepass", model: "fp-small" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a reasoningEffort through loadLocalSettings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      await saveLocalSettings(path, {
        provider: "firepass",
        model: "fp-small",
        reasoningEffort: "high",
      });
      expect(await loadLocalSettings(path)).toEqual({
        provider: "firepass",
        model: "fp-small",
        reasoningEffort: "high",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettings fails open on invalid reasoningEffort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      await mkdir(join(dir, ".corbits"), { recursive: true });
      const path = join(dir, ".corbits", "settings.json");
      await writeFile(path, JSON.stringify({ model: "m", reasoningEffort: "legendary" }));
      // Fail open: keep model, drop invalid effort, surface diagnostic.
      expect(await loadLocalSettings(path)).toEqual({ model: "m" });
      const { loadLocalSettingsResult } = await import("./config/settings.js");
      const result = await loadLocalSettingsResult(path);
      expect(result.settings).toEqual({ model: "m" });
      expect(result.diagnostics.some((d) => /reasoningEffort/i.test(d.message))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the .corbits directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "nested", ".corbits", "settings.json");
      await saveLocalSettings(path, { provider: "a" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "a" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to write credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".corbits", "settings.json");
      // Force an invalid shape past the type system to prove the guard holds.
      const leaky = { provider: "a", apiKey: "leak" } as unknown as { provider?: string };
      await expect(saveLocalSettings(path, leaky)).rejects.toThrow(/allowed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("recent and favorite model helpers", () => {
  test("pushRecentModel prepends, dedupes, and caps", () => {
    let s: Settings = { providers: firepass.providers };
    s = pushRecentModel(s, { provider: "a", model: "m1" });
    s = pushRecentModel(s, { provider: "a", model: "m2" });
    s = pushRecentModel(s, { provider: "a", model: "m1" });
    expect(s.recentModels).toEqual([
      { provider: "a", model: "m1" },
      { provider: "a", model: "m2" },
    ]);

    for (let i = 0; i < 12; i++) {
      s = pushRecentModel(s, { provider: "a", model: `x${i}` }, 10);
    }
    expect(s.recentModels).toHaveLength(10);
    expect(s.recentModels?.[0]).toEqual({ provider: "a", model: "x11" });
  });

  test("pushRecentModel leaves defaultProvider untouched", () => {
    const s: Settings = { providers: firepass.providers, defaultProvider: "firepass" };
    const next = pushRecentModel(s, { provider: "other", model: "m1" });
    expect(next.defaultProvider).toBe("firepass");
  });

  test("toggleFavoriteModel adds and removes", () => {
    let s: Settings = { providers: firepass.providers };
    s = toggleFavoriteModel(s, { provider: "a", model: "m1" });
    expect(listFavoriteModels(s)).toEqual([{ provider: "a", model: "m1" }]);
    s = toggleFavoriteModel(s, { provider: "a", model: "m1" });
    expect(listFavoriteModels(s)).toEqual([]);
  });

  test("setDefaultModel sets defaultProvider and that provider's defaultModel", () => {
    const s: Settings = {
      defaultProvider: "a",
      providers: {
        a: {
          baseURL: "https://a/v1",
          apiKey: "a-key",
          models: ["a-model"],
          defaultModel: "a-model",
        },
        b: {
          baseURL: "https://b/v1",
          apiKey: "b-key",
          models: ["b-model", "b-other"],
          defaultModel: "b-model",
        },
      },
      recentModels: [{ provider: "a", model: "a-model" }],
      favoriteModels: [{ provider: "b", model: "b-model" }],
    };
    const next = setDefaultModel(s, { provider: "b", model: "b-other" });
    expect(next.defaultProvider).toBe("b");
    expect(next.providers.b?.defaultModel).toBe("b-other");
    expect(next.providers.a).toEqual(s.providers.a);
    expect(next.recentModels).toEqual(s.recentModels);
    expect(next.favoriteModels).toEqual(s.favoriteModels);
  });

  test("setDefaultModel with a missing provider still sets defaultProvider and does not invent a providers key", () => {
    const s: Settings = { providers: firepass.providers, defaultProvider: "firepass" };
    const next = setDefaultModel(s, { provider: "missing", model: "m1" });
    expect(next.defaultProvider).toBe("missing");
    expect(next.providers).toEqual(s.providers);
    expect(next.providers.missing).toBeUndefined();
  });

  test("setDefaultModel persists credential-free projected OAuth metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "settings.json");
      const projected: ProviderSettings = {
        baseURL: "https://chatgpt.com/backend-api",
        apiKey: "oauth-token",
        models: ["gpt-5.2-codex", "gpt-5.1-codex"],
      };
      const next = setDefaultModel(
        { providers: {} },
        { provider: "codex/work", model: "gpt-5.1-codex" },
        projected,
      );
      await saveGlobalSettings(path, next);

      expect(await loadSettings(path)).toEqual({
        defaultProvider: "codex/work",
        providers: {
          "codex/work": {
            baseURL: projected.baseURL,
            models: ["gpt-5.1-codex"],
            defaultModel: "gpt-5.1-codex",
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listRecentModels respects max (default 5)", () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({
      provider: "a",
      model: `m${i}`,
    }));
    const s: Settings = { providers: firepass.providers, recentModels: recent };
    expect(listRecentModels(s)).toHaveLength(5);
    expect(listRecentModels(s, 3)).toHaveLength(3);
  });
});
