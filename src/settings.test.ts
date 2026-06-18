import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLocalSettings,
  isSettings,
  loadLocalSettings,
  loadSettings,
  normalizeOpenAICompatibleBaseURL,
  resolveProvider,
  saveGlobalSettings,
  saveLocalSettings,
  type Settings,
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
      providers: { only: { baseURL: "https://o/v1", apiKey: "o-key", models: ["first", "second"] } },
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
    expect(isLocalSettings({ reasoningEffort: "ultra" })).toBe(false);
    expect(isLocalSettings({ reasoningEffort: 5 })).toBe(false);
  });
});

describe("loaders", () => {
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
        }),
      );
      const loaded = await loadSettings(path);
      expect(loaded?.workflowProfiles).toEqual({ fast: { implement: "m" } });
      expect(loaded?.web).toBe("exa");
      expect(loaded?.plugins).toEqual({ exa: { enabled: true, credentials: { apiKey: "exa-key" } } });
      expect(loaded?.pluginPaths).toEqual(["/abs/plugins/exa", "./local-plugin"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettings rejects credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      await mkdir(join(dir, ".intercode"), { recursive: true });
      const path = join(dir, ".intercode", "settings.json");
      await writeFile(path, JSON.stringify({ provider: "a", apiKey: "leak" }));
      await expect(loadLocalSettings(path)).rejects.toThrow(/no credentials/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saveGlobalSettings", () => {
  test("round-trips a settings object through loadSettings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".intercode", "settings.json");
      await saveGlobalSettings(path, firepass);
      expect(await loadSettings(path)).toEqual(firepass);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the .intercode directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "nested", ".intercode", "settings.json");
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
      const path = join(dir, ".intercode", "settings.json");
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
      const path = join(dir, ".intercode", "settings.json");
      await saveLocalSettings(path, { provider: "firepass", model: "fp-small" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "firepass", model: "fp-small" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a reasoningEffort through loadLocalSettings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".intercode", "settings.json");
      await saveLocalSettings(path, { provider: "firepass", model: "fp-small", reasoningEffort: "high" });
      expect(await loadLocalSettings(path)).toEqual({
        provider: "firepass",
        model: "fp-small",
        reasoningEffort: "high",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadLocalSettings rejects an invalid reasoningEffort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      await mkdir(join(dir, ".intercode"), { recursive: true });
      const path = join(dir, ".intercode", "settings.json");
      await writeFile(path, JSON.stringify({ model: "m", reasoningEffort: "ultra" }));
      await expect(loadLocalSettings(path)).rejects.toThrow(/reasoningEffort/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the .intercode directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "nested", ".intercode", "settings.json");
      await saveLocalSettings(path, { provider: "a" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "a" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to write credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".intercode", "settings.json");
      // Force an invalid shape past the type system to prove the guard holds.
      const leaky = { provider: "a", apiKey: "leak" } as unknown as { provider?: string };
      await expect(saveLocalSettings(path, leaky)).rejects.toThrow(/only "provider", "model", and "reasoningEffort"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
