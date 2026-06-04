import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLocalSettings,
  isSettings,
  loadLocalSettings,
  loadSettings,
  resolveProvider,
  saveGlobalSettings,
  saveLocalSettings,
  type Settings,
} from "./settings.js";

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

describe("resolveProvider", () => {
  test("env-only mode resolves entirely from env", () => {
    const r = resolveProvider({
      settings: null,
      local: null,
      env: { apiKey: "k", baseURL: "https://u/v1", model: "m", providerName: "p" },
      cli: {},
    });
    expect(r).toEqual({ apiKey: "k", baseURL: "https://u/v1", model: "m", providerName: "p" });
  });

  test("file mode uses defaultProvider and defaultModel", () => {
    const r = resolveProvider({ settings: firepass, local: null, env: {}, cli: {} });
    expect(r).toEqual({
      providerName: "firepass",
      baseURL: "https://firepass.example/v1",
      apiKey: "fp-key",
      model: "fp-large",
    });
  });

  test("falls back to the first model when no defaultModel", () => {
    const settings: Settings = {
      providers: { only: { baseURL: "https://o/v1", apiKey: "o-key", models: ["first", "second"] } },
    };
    const r = resolveProvider({ settings, local: null, env: {}, cli: {} });
    expect(r.model).toBe("first");
    expect(r.providerName).toBe("only");
  });

  test("a sole provider is used without a defaultProvider", () => {
    const settings: Settings = {
      providers: { solo: { baseURL: "https://s/v1", apiKey: "s-key", models: ["s-model"] } },
    };
    const r = resolveProvider({ settings, local: null, env: {}, cli: {} });
    expect(r.providerName).toBe("solo");
  });

  test("local selection overrides defaultProvider", () => {
    const r = resolveProvider({ settings: twoProviders, local: { provider: "b" }, env: {}, cli: {} });
    expect(r.providerName).toBe("b");
    expect(r.apiKey).toBe("b-key");
    expect(r.model).toBe("b-model");
  });

  test("cli provider overrides local and env", () => {
    const r = resolveProvider({
      settings: twoProviders,
      local: { provider: "a" },
      env: { providerName: "a" },
      cli: { provider: "b" },
    });
    expect(r.providerName).toBe("b");
  });

  test("model precedence: cli > env > local > defaultModel", () => {
    const cli = resolveProvider({
      settings: firepass,
      local: { model: "fp-small" },
      env: { model: "env-model" },
      cli: { model: "cli-model" },
    });
    expect(cli.model).toBe("cli-model");

    const env = resolveProvider({
      settings: firepass,
      local: { model: "fp-small" },
      env: { model: "env-model" },
      cli: {},
    });
    expect(env.model).toBe("env-model");

    const local = resolveProvider({
      settings: firepass,
      local: { model: "fp-small" },
      env: {},
      cli: {},
    });
    expect(local.model).toBe("fp-small");
  });

  test("env overrides file credentials", () => {
    const r = resolveProvider({
      settings: firepass,
      local: null,
      env: { apiKey: "override-key", baseURL: "https://override/v1" },
      cli: {},
    });
    expect(r.apiKey).toBe("override-key");
    expect(r.baseURL).toBe("https://override/v1");
    expect(r.providerName).toBe("firepass");
  });

  test("throws when cli provider is not configured", () => {
    expect(() =>
      resolveProvider({ settings: twoProviders, local: null, env: {}, cli: { provider: "c" } }),
    ).toThrow(/not found/);
  });

  test("names the offending provider when a local selection is not configured", () => {
    expect(() =>
      resolveProvider({ settings: twoProviders, local: { provider: "zzz" }, env: {}, cli: {} }),
    ).toThrow(/Selected provider "zzz" is not configured/);
  });

  test("names the offending provider when defaultProvider is a typo", () => {
    const settings: Settings = {
      defaultProvider: "typo",
      providers: { solo: { baseURL: "https://s/v1", apiKey: "s-key", models: ["s-model"] } },
    };
    expect(() => resolveProvider({ settings, local: null, env: {}, cli: {} })).toThrow(
      /Selected provider "typo" is not configured/,
    );
  });

  test("env overrides a single field while the rest come from the file", () => {
    const r = resolveProvider({
      settings: firepass,
      local: null,
      env: { apiKey: "env-key" },
      cli: {},
    });
    expect(r.apiKey).toBe("env-key");
    expect(r.providerName).toBe("firepass");
    expect(r.baseURL).toBe("https://firepass.example/v1");
    expect(r.model).toBe("fp-large");
  });

  test("throws listing every missing field", () => {
    expect(() => resolveProvider({ settings: null, local: null, env: {}, cli: {} })).toThrow(
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

  test("loadLocalSettings rejects credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      await mkdir(join(dir, ".interchange"), { recursive: true });
      const path = join(dir, ".interchange", "settings.json");
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
      const path = join(dir, ".interchange", "settings.json");
      await saveGlobalSettings(path, firepass);
      expect(await loadSettings(path)).toEqual(firepass);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the .interchange directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "nested", ".interchange", "settings.json");
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
      const path = join(dir, ".interchange", "settings.json");
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
      const path = join(dir, ".interchange", "settings.json");
      await saveLocalSettings(path, { provider: "firepass", model: "fp-small" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "firepass", model: "fp-small" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates the .interchange directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, "nested", ".interchange", "settings.json");
      await saveLocalSettings(path, { provider: "a" });
      expect(await loadLocalSettings(path)).toEqual({ provider: "a" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to write credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-settings-"));
    try {
      const path = join(dir, ".interchange", "settings.json");
      // Force an invalid shape past the type system to prove the guard holds.
      const leaky = { provider: "a", apiKey: "leak" } as unknown as { provider?: string };
      await expect(saveLocalSettings(path, leaky)).rejects.toThrow(/only "provider" and "model"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
