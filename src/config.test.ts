import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOpenAISource, buildProviderCatalog, loadConfig, providerCatalogToSettings } from "./config/index.js";
import type { Config, UnconfiguredConfig } from "./config/index.js";
import type { ResolvedProvider, Settings } from "./config/settings.js";

function assertConfigured(config: Config | UnconfiguredConfig): asserts config is Config {
  if (config.configured === false) {
    throw new Error(`Expected configured Config but got UnconfiguredConfig: ${config.providerError}`);
  }
}

const ENV_KEYS = [
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_MODEL",
  "OPENAI_COMPATIBLE_PROVIDER_NAME",
];

// A global settings path guaranteed not to exist, so file resolution is inert
// and the env-based tests below stay hermetic regardless of the dev machine's
// real ~/.intercode/settings.json.
const NO_SETTINGS = join(tmpdir(), "interchange-code-tests-missing", ".intercode", "settings.json");

function stashEnv(): Record<string, string | undefined> {
  const stash: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    stash[key] = process.env[key];
    delete process.env[key];
  }
  return stash;
}

function restoreEnv(stash: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const val = stash[key];
    if (val !== undefined) {
      process.env[key] = val;
    } else {
      delete process.env[key];
    }
  }
}

function setRequiredEnv(): void {
  process.env.OPENAI_COMPATIBLE_API_KEY = "test-key";
  process.env.OPENAI_COMPATIBLE_BASE_URL = "https://api.fireworks.ai/inference";
  process.env.OPENAI_COMPATIBLE_MODEL = "accounts/fireworks/routers/kimi-k2p6-turbo";
  process.env.OPENAI_COMPATIBLE_PROVIDER_NAME = "fireworks";
}

// A cwd with no per-repo settings file, so local resolution is inert.
async function emptyCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ic-config-"));
}

describe("loadConfig", () => {
  test("resolves provider from env when no settings file exists", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      const config = await loadConfig(["--cwd", cwd, "add", "hello", "world"], {
        globalSettingsPath: NO_SETTINGS,
      });
      assertConfigured(config);
      expect(config.task).toBe("add hello world");
      expect(config.apiKey).toBe("test-key");
      expect(config.baseURL).toBe("https://api.fireworks.ai/inference");
      expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
      expect(config.providerName).toBe("fireworks");
      expect(config.globalSettingsPath).toBe(NO_SETTINGS);
      expect(config.globalDefaultProvider).toBeUndefined();
      expect(config.force).toBe(false);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("throws when no provider can be resolved (allowUnconfigured false)", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
      await expect(
        loadConfig(["--cwd", cwd, "do it"], { globalSettingsPath: NO_SETTINGS }),
      ).rejects.toThrow(/apiKey/);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("returns UnconfiguredConfig when allowUnconfigured is true and provider is missing", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      const result = await loadConfig(["--cwd", cwd, "do it"], {
        globalSettingsPath: NO_SETTINGS,
        allowUnconfigured: true,
      });
      expect(result.configured).toBe(false);
      if (result.configured === false) {
        expect(result.cwd).toBe(cwd);
        expect(result.task).toBe("do it");
        expect(result.providerError).toMatch(/missing/);
        expect(result.globalSettingsPath).toBe(NO_SETTINGS);
      }
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("UnconfiguredConfig.globalSettingsPath reflects --config path, not the global default", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      const configPath = join(cwd, "custom.json");
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const result = await loadConfig(["--cwd", cwd, "--config", configPath, "task"], {
        allowUnconfigured: true,
      });
      expect(result.configured).toBe(false);
      if (result.configured === false) {
        expect(result.globalSettingsPath).toBe(configPath);
      }
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses --force", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      const config = await loadConfig(["--cwd", cwd, "--force", "run task"], {
        globalSettingsPath: NO_SETTINGS,
      });
      expect(config.force).toBe(true);
      expect(config.task).toBe("run task");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects unknown flags", async () => {
    const stash = stashEnv();
    try {
      setRequiredEnv();
      await expect(
        loadConfig(["--unknown"], { globalSettingsPath: NO_SETTINGS }),
      ).rejects.toThrow(/unrecognized flag/);
    } finally {
      restoreEnv(stash);
    }
  });

  test("defaults dangerouslySkipPermissions to false", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      const config = await loadConfig(["--cwd", cwd, "do something"], {
        globalSettingsPath: NO_SETTINGS,
      });
      expect(config.dangerouslySkipPermissions).toBe(false);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses --dangerously-skip-permissions", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      const config = await loadConfig(
        ["--cwd", cwd, "--dangerously-skip-permissions", "do something"],
        { globalSettingsPath: NO_SETTINGS },
      );
      expect(config.dangerouslySkipPermissions).toBe(true);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reads provider and model from a --config settings file", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      // No env: resolution must come entirely from the file.
      const settingsPath = join(cwd, "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({
          defaultProvider: "firepass",
          providers: {
            firepass: {
              baseURL: "https://firepass.example/v1",
              apiKey: "fp-key",
              models: ["fp-large", "fp-small"],
              defaultModel: "fp-large",
            },
          },
        }),
      );
      const config = await loadConfig(["--cwd", cwd, "--config", settingsPath, "task"]);
      assertConfigured(config);
      expect(config.providerName).toBe("firepass");
      expect(config.baseURL).toBe("https://firepass.example/v1");
      expect(config.apiKey).toBe("fp-key");
      expect(config.model).toBe("fp-large");
      expect(config.globalDefaultProvider).toBe("firepass");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--model overrides the provider default model", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      const settingsPath = join(cwd, "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({
          defaultProvider: "firepass",
          providers: {
            firepass: {
              baseURL: "https://firepass.example/v1",
              apiKey: "fp-key",
              models: ["fp-large", "fp-small"],
              defaultModel: "fp-large",
            },
          },
        }),
      );
      const config = await loadConfig([
        "--cwd",
        cwd,
        "--config",
        settingsPath,
        "--model",
        "fp-small",
        "task",
      ]);
      assertConfigured(config);
      expect(config.model).toBe("fp-small");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--config pointing at a missing file throws", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      await expect(
        loadConfig(["--cwd", cwd, "--config", join(cwd, "nope.json"), "task"]),
      ).rejects.toThrow(/not found or empty/);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a single env var overrides while the rest come from the settings file", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "firepass",
          providers: {
            firepass: {
              baseURL: "https://firepass.example/v1",
              apiKey: "file-key",
              models: ["fp-large"],
            },
          },
        }),
      );
      process.env.OPENAI_COMPATIBLE_API_KEY = "env-key";
      const config = await loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.apiKey).toBe("env-key");
      expect(config.providerName).toBe("firepass");
      expect(config.baseURL).toBe("https://firepass.example/v1");
      expect(config.model).toBe("fp-large");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--profile flag surfaces profile name and model from project profile.json", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      // Unset model env so the profile model (layer below env) can apply.
      delete process.env.OPENAI_COMPATIBLE_MODEL;
      await mkdir(join(cwd, ".intercode"), { recursive: true });
      await writeFile(
        join(cwd, ".intercode", "profile.json"),
        JSON.stringify({ model: "profile-model", maxTurns: 25, systemPromptExtensions: ["ext1"] }),
      );
      const config = await loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: NO_SETTINGS });
      assertConfigured(config);
      expect(config.model).toBe("profile-model");
      expect(config.maxTurns).toBe(25);
      expect(config.systemPromptExtensions).toEqual(["ext1"]);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--model flag overrides profile model", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      setRequiredEnv();
      await mkdir(join(cwd, ".intercode"), { recursive: true });
      await writeFile(
        join(cwd, ".intercode", "profile.json"),
        JSON.stringify({ model: "profile-model" }),
      );
      const config = await loadConfig(["--cwd", cwd, "--model", "accounts/fireworks/routers/kimi-k2p6-turbo", "task"], {
        globalSettingsPath: NO_SETTINGS,
      });
      assertConfigured(config);
      expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("per-repo local settings select the provider", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      await mkdir(join(cwd, ".intercode"), { recursive: true });
      await writeFile(
        join(cwd, ".intercode", "settings.json"),
        JSON.stringify({ provider: "b", model: "b-model" }),
      );
      const globalPath = join(cwd, "global.json");
      await writeFile(
        globalPath,
        JSON.stringify({
          defaultProvider: "a",
          providers: {
            a: { baseURL: "https://a/v1", apiKey: "a-key", models: ["a-model"] },
            b: { baseURL: "https://b/v1", apiKey: "b-key", models: ["b-model"] },
          },
        }),
      );
      const config = await loadConfig(["--cwd", cwd, "task"], { globalSettingsPath: globalPath });
      assertConfigured(config);
      expect(config.providerName).toBe("b");
      expect(config.model).toBe("b-model");
      expect(config.apiKey).toBe("b-key");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildOpenAISource", () => {
  test("normalizes the runtime source baseURL", () => {
    const source = buildOpenAISource({
      id: "fp",
      baseURL: "https://fp/v1/chat/completions",
      apiKey: "fp-key",
      model: "fp-large",
    });
    expect(source.baseURL).toBe("https://fp/v1");
  });
});

describe("buildProviderCatalog", () => {
  const resolved: ResolvedProvider = {
    providerName: "fp",
    baseURL: "https://fp/v1",
    apiKey: "fp-key",
    model: "fp-large",
  };

  test("lists every provider from the settings file", () => {
    const settings: Settings = {
      defaultProvider: "fp",
      providers: {
        fp: { baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large", "fp-small"], defaultModel: "fp-large" },
        oa: { baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    expect(catalog.map((c) => c.name).sort()).toEqual(["fp", "oa"]);
    const fp = catalog.find((c) => c.name === "fp")!;
    expect(fp.models).toEqual(["fp-large", "fp-small"]);
    expect(fp.defaultModel).toBe("fp-large");
    expect(catalog.find((c) => c.name === "oa")!.defaultModel).toBeUndefined();
  });

  test("normalizes provider base URLs from the settings file", () => {
    const settings: Settings = {
      providers: {
        fp: {
          baseURL: "https://fp/v1/chat/completions/",
          apiKey: "fp-key",
          models: ["fp-large"],
        },
      },
    };
    const catalog = buildProviderCatalog(settings, resolved);
    expect(catalog[0]?.baseURL).toBe("https://fp/v1");
  });

  test("env-only mode yields the single resolved provider", () => {
    const catalog = buildProviderCatalog(null, resolved);
    expect(catalog).toEqual([
      { name: "fp", baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] },
    ]);
  });

  test("converts a provider catalog back to global settings", () => {
    const settings = providerCatalogToSettings(
      [
        {
          name: "fp",
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large", "fp-small"],
          defaultModel: "fp-large",
        },
        { name: "oa", baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
      ],
      "oa",
    );
    expect(settings).toEqual({
      defaultProvider: "oa",
      providers: {
        fp: {
          baseURL: "https://fp/v1",
          apiKey: "fp-key",
          models: ["fp-large", "fp-small"],
          defaultModel: "fp-large",
        },
        oa: { baseURL: "https://oa/v1", apiKey: "oa-key", models: ["o-1"] },
      },
    });
  });

  test("normalizes provider catalog URLs when converting back to settings", () => {
    const settings = providerCatalogToSettings(
      [{ name: "fp", baseURL: "https://fp/v1/chat/completions", apiKey: "fp-key", models: ["fp-large"] }],
      undefined,
    );
    expect(settings.providers.fp?.baseURL).toBe("https://fp/v1");
  });

  test("rejects invalid provider catalog URLs when converting back to settings", () => {
    expect(() =>
      providerCatalogToSettings(
        [{ name: "fp", baseURL: "fp/v1", apiKey: "fp-key", models: ["fp-large"] }],
        undefined,
      ),
    ).toThrow(/Invalid OpenAI-compatible baseURL/);
  });

  test("omits defaultProvider when no global default is known", () => {
    const settings = providerCatalogToSettings(
      [{ name: "fp", baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] }],
      undefined,
    );
    expect(settings).toEqual({
      providers: {
        fp: { baseURL: "https://fp/v1", apiKey: "fp-key", models: ["fp-large"] },
      },
    });
  });
});
