import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config, UnconfiguredConfig } from "../config/index.js";
import type { ProviderSetupConfig } from "./provider-setup.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let testHome = "";
let setup: (config: ProviderSetupConfig) => Promise<void> = async () => {};
let tuiConfig: Config | undefined;

await withMockedModule(import.meta.resolve("node:os"), (real: typeof import("node:os")) => ({
  ...real,
  homedir: () => testHome,
}));
await withMockedModule(
  import.meta.resolve("./provider-setup.js"),
  (real: typeof import("./provider-setup.js")) => ({
    ...real,
    runProviderSetup: async (config: ProviderSetupConfig) => {
      await setup(config);
      return true;
    },
  }),
);
await withMockedModule(
  import.meta.resolve("./runner.js"),
  (real: typeof import("./runner.js")) => ({
    ...real,
    runTUI: async (config: Config) => {
      tuiConfig = config;
      return 0;
    },
  }),
);

const { loadConfig } = await import("../config/index.js");
const { runOnboarding } = await import("./onboarding.js");

async function unconfiguredConfig(
  cwd: string,
  paths: { cliConfigPath?: string; programmaticConfigPath?: string },
): Promise<UnconfiguredConfig> {
  const argv = ["--cwd", cwd];
  if (paths.cliConfigPath !== undefined) argv.push("--config", paths.cliConfigPath);

  const config = await loadConfig(argv, {
    ...(paths.programmaticConfigPath !== undefined
      ? { globalSettingsPath: paths.programmaticConfigPath }
      : {}),
    allowUnconfigured: true,
  });
  if (config.configured) throw new Error("Expected onboarding config");
  return config;
}

async function writeXAIAuthProfile(home: string, profile: string): Promise<void> {
  await mkdir(join(home, ".corbits"), { recursive: true });
  await writeFile(
    join(home, ".corbits", "xai-auth.json"),
    JSON.stringify({
      profiles: {
        [profile]: {
          name: profile,
          tokens: {
            access: `${profile}-access-token`,
            refresh: `${profile}-refresh-token`,
            expiresAt: Date.now() + 3_600_000,
          },
          createdAt: Date.now(),
        },
      },
    }),
  );
}

afterEach(() => {
  setup = async () => {};
  tuiConfig = undefined;
});

describe("runOnboarding settings source", () => {
  test("reloads CLI --config with the selected OAuth profile projection", async () => {
    testHome = await mkdtemp(join(tmpdir(), "corbits-onboarding-oauth-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "corbits-onboarding-oauth-cwd-"));
    const configPath = join(cwd, "custom-settings.json");
    try {
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(cwd, { cliConfigPath: configPath });

      setup = async ({ onSubmit }) => {
        await writeXAIAuthProfile(testHome, "work");
        await onSubmit(
          {
            name: "xai/work",
            baseURL: "https://api.x.ai/v1",
            apiKey: "",
            model: "grok-4",
            oauthProfile: "work",
          },
          () => {},
          {
            skipValidation: true,
            oauth: { kind: "xai", profile: "work", providerName: "xai/work" },
          },
        );
      };

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("xai/work");
      expect(tuiConfig?.model).toBe("grok-4");
      expect(tuiConfig?.globalSettingsPath).toBe(configPath);
      expect(tuiConfig?.providers.some((provider) => provider.name === "xai/work")).toBe(true);

      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        defaultProvider?: string;
        providers?: Record<string, unknown>;
      };
      expect(persisted.defaultProvider).toBe("xai/work");
      expect(persisted.providers).toEqual({
        "xai/work": { baseURL: "https://api.x.ai/v1", models: ["grok-4"], defaultModel: "grok-4" },
      });
      expect(JSON.stringify(persisted)).not.toContain("apiKey");
    } finally {
      await rm(testHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps API-key onboarding writes and reloads on CLI --config", async () => {
    testHome = await mkdtemp(join(tmpdir(), "corbits-onboarding-key-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "corbits-onboarding-key-cwd-"));
    const configPath = join(cwd, "custom-settings.json");
    try {
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(cwd, { cliConfigPath: configPath });

      setup = async ({ onSubmit }) => {
        await onSubmit(
          {
            name: "custom",
            baseURL: "https://provider.example.com/v1",
            apiKey: "test-key",
            model: "test-model",
            oauthProfile: "",
          },
          () => {},
          { skipValidation: true },
        );
      };

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("custom");
      expect(tuiConfig?.model).toBe("test-model");
      expect(tuiConfig?.globalSettingsPath).toBe(configPath);

      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        providers?: Record<string, unknown>;
      };
      expect(persisted.providers).toHaveProperty("custom");
    } finally {
      await rm(testHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps OAuth profiles isolated when CLI and programmatic paths are both supplied", async () => {
    testHome = await mkdtemp(join(tmpdir(), "corbits-onboarding-both-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "corbits-onboarding-both-cwd-"));
    const cliConfigPath = join(cwd, "cli-settings.json");
    const programmaticConfigPath = join(cwd, "programmatic-settings.json");
    try {
      await writeXAIAuthProfile(testHome, "hidden");
      await writeFile(cliConfigPath, JSON.stringify({ providers: {} }));
      await writeFile(programmaticConfigPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(cwd, {
        cliConfigPath,
        programmaticConfigPath,
      });
      expect(config.cliConfigPath).toBe(cliConfigPath);
      expect(config.programmaticSettingsPath).toBe(true);

      setup = async ({ onSubmit }) => {
        await onSubmit(
          {
            name: "isolated",
            baseURL: "https://isolated.example.com/v1",
            apiKey: "isolated-key",
            model: "isolated-model",
            oauthProfile: "",
          },
          () => {},
          { skipValidation: true },
        );
      };

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("isolated");
      expect(tuiConfig?.providers.map((provider) => provider.name)).toEqual(["isolated"]);
      expect(tuiConfig?.globalSettingsPath).toBe(cliConfigPath);
    } finally {
      await rm(testHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a default-path programmatic override isolated after reload", async () => {
    testHome = await mkdtemp(join(tmpdir(), "corbits-onboarding-isolated-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "corbits-onboarding-isolated-cwd-"));
    const configPath = join(testHome, ".corbits", "settings.json");
    try {
      await writeXAIAuthProfile(testHome, "hidden");
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(cwd, { programmaticConfigPath: configPath });

      setup = async ({ onSubmit }) => {
        await onSubmit(
          {
            name: "isolated",
            baseURL: "https://isolated.example.com/v1",
            apiKey: "isolated-key",
            model: "isolated-model",
            oauthProfile: "",
          },
          () => {},
          { skipValidation: true },
        );
      };

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("isolated");
      expect(tuiConfig?.providers.map((provider) => provider.name)).toEqual(["isolated"]);
      expect(tuiConfig?.globalSettingsPath).toBe(configPath);
    } finally {
      await rm(testHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
