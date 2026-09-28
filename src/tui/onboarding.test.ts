import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config, UnconfiguredConfig } from "../config/index.js";
import type {
  ProviderFormValues,
  ProviderSetupConfig,
  SubmitOpts,
} from "./provider/types.js";
import type { WelcomeConfig } from "./welcome.js";
import { withMockedModule } from "../testkit/mock-module.js";
import { createTempDirs } from "../testkit/temporary-dirs.js";

let testHome = "";
let setup: (config: ProviderSetupConfig) => Promise<void> = async () =>
  undefined;
let welcome: (config: WelcomeConfig) => Promise<boolean> = async () => true;
let tuiConfig: Config | undefined;
const callOrder: string[] = [];

await withMockedModule(
  import.meta.resolve("node:os"),
  (real: typeof import("node:os")) => ({
    ...real,
    homedir: () => testHome,
  }),
);
await withMockedModule(
  import.meta.resolve("./welcome.js"),
  (real: typeof import("./welcome.js")) => ({
    ...real,
    runWelcome: async (config: WelcomeConfig = {}) => {
      callOrder.push("welcome");
      return welcome(config);
    },
  }),
);
await withMockedModule(
  import.meta.resolve("./provider/setup.js"),
  (real: typeof import("./provider/setup.js")) => ({
    ...real,
    runProviderSetup: async (config: ProviderSetupConfig) => {
      callOrder.push("setup");
      await setup(config);
      return true;
    },
  }),
);
await withMockedModule(
  import.meta.resolve("./runner/index.js"),
  (real: typeof import("./runner/index.js")) => ({
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
  if (paths.cliConfigPath !== undefined)
    argv.push("--config", paths.cliConfigPath);

  const config = await loadConfig(argv, {
    ...(paths.programmaticConfigPath !== undefined
      ? { globalSettingsPath: paths.programmaticConfigPath }
      : {}),
    allowUnconfigured: true,
  });
  if (config.configured) throw new Error("Expected onboarding config");
  return config;
}

const CUSTOM_PROVIDER: ProviderFormValues = {
  name: "custom",
  baseURL: "https://provider.example.com/v1",
  apiKey: "test-key",
  model: "test-model",
  oauthProfile: "",
};

const ISOLATED_PROVIDER: ProviderFormValues = {
  name: "isolated",
  baseURL: "https://isolated.example.com/v1",
  apiKey: "isolated-key",
  model: "isolated-model",
  oauthProfile: "",
};

/** Stub the setup flow to submit one provider form, validation skipped. */
function setupSubmits(values: ProviderFormValues, opts?: SubmitOpts): void {
  setup = async ({ onSubmit }) => {
    await onSubmit(values, () => undefined, opts ?? { skipValidation: true });
  };
}

async function writeXAIAuthProfile(
  home: string,
  profile: string,
): Promise<void> {
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
  setup = async () => undefined;
  welcome = async () => true;
  tuiConfig = undefined;
  callOrder.length = 0;
});

describe("runOnboarding welcome gate", () => {
  test("fresh user sees welcome before provider setup and marks onboarded", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-welcome-cwd-",
      "corbits-onboarding-welcome-home-",
    );
    testHome = dirs.home;
    const configPath = join(testHome, ".corbits", "settings.json");
    try {
      await mkdir(join(testHome, ".corbits"), { recursive: true });
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(dirs.cwd, {
        programmaticConfigPath: configPath,
      });

      setupSubmits(CUSTOM_PROVIDER);

      expect(await runOnboarding(config)).toBe(0);
      expect(callOrder).toEqual(["welcome", "setup"]);

      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        onboarded?: boolean;
      };
      expect(persisted.onboarded).toBe(true);
    } finally {
      dirs.cleanup();
    }
  });

  test("already-onboarded skips welcome and opens setup directly", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-skip-cwd-",
      "corbits-onboarding-skip-home-",
    );
    testHome = dirs.home;
    const configPath = join(testHome, ".corbits", "settings.json");
    try {
      await mkdir(join(testHome, ".corbits"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ providers: {}, onboarded: true }),
      );
      const config = await unconfiguredConfig(dirs.cwd, {
        programmaticConfigPath: configPath,
      });

      setupSubmits(CUSTOM_PROVIDER);

      expect(await runOnboarding(config)).toBe(0);
      expect(callOrder).toEqual(["setup"]);
    } finally {
      dirs.cleanup();
    }
  });

  test("cancelled welcome does not mark onboarded or open setup", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-cancel-cwd-",
      "corbits-onboarding-cancel-home-",
    );
    testHome = dirs.home;
    const configPath = join(testHome, ".corbits", "settings.json");
    try {
      await mkdir(join(testHome, ".corbits"), { recursive: true });
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(dirs.cwd, {
        programmaticConfigPath: configPath,
      });

      welcome = async () => false;

      expect(await runOnboarding(config)).toBe(1);
      expect(callOrder).toEqual(["welcome"]);

      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        onboarded?: boolean;
      };
      expect(persisted.onboarded).toBeUndefined();
    } finally {
      dirs.cleanup();
    }
  });
});

describe("runOnboarding settings source", () => {
  test("reloads CLI --config with the selected OAuth profile projection", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-oauth-cwd-",
      "corbits-onboarding-oauth-home-",
    );
    testHome = dirs.home;
    const configPath = join(dirs.cwd, "custom-settings.json");
    try {
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(dirs.cwd, {
        cliConfigPath: configPath,
      });

      setupSubmits(
        {
          name: "xai/work",
          baseURL: "https://api.x.ai/v1",
          apiKey: "",
          model: "grok-4",
          oauthProfile: "work",
        },
        {
          skipValidation: true,
          oauth: {
            kind: "xai",
            providerName: "xai/work",
            tokens: {
              access: "work-access-token",
              refresh: "work-refresh-token",
              expiresAt: 0,
            },
            commit: () => writeXAIAuthProfile(testHome, "work"),
          },
        },
      );

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("xai/work");
      expect(tuiConfig?.model).toBe("grok-4");
      expect(tuiConfig?.globalSettingsPath).toBe(configPath);
      expect(
        tuiConfig?.providers.some((provider) => provider.name === "xai/work"),
      ).toBe(true);

      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        defaultProvider?: string;
        providers?: Record<string, unknown>;
      };
      expect(persisted.defaultProvider).toBe("xai/work");
      expect(persisted.providers).toEqual({
        "xai/work": {
          baseURL: "https://api.x.ai/v1",
          models: ["grok-4"],
          defaultModel: "grok-4",
        },
      });
      expect(JSON.stringify(persisted)).not.toContain("apiKey");
    } finally {
      dirs.cleanup();
    }
  });

  test("keeps API-key onboarding writes and reloads on CLI --config", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-key-cwd-",
      "corbits-onboarding-key-home-",
    );
    testHome = dirs.home;
    const configPath = join(dirs.cwd, "custom-settings.json");
    try {
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(dirs.cwd, {
        cliConfigPath: configPath,
      });

      setupSubmits(CUSTOM_PROVIDER);

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("custom");
      expect(tuiConfig?.model).toBe("test-model");
      expect(tuiConfig?.globalSettingsPath).toBe(configPath);

      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        providers?: Record<string, unknown>;
      };
      expect(persisted.providers).toHaveProperty("custom");
    } finally {
      dirs.cleanup();
    }
  });

  test("keeps OAuth profiles isolated when CLI and programmatic paths are both supplied", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-both-cwd-",
      "corbits-onboarding-both-home-",
    );
    testHome = dirs.home;
    const cliConfigPath = join(dirs.cwd, "cli-settings.json");
    const programmaticConfigPath = join(dirs.cwd, "programmatic-settings.json");
    try {
      await writeXAIAuthProfile(testHome, "hidden");
      await writeFile(cliConfigPath, JSON.stringify({ providers: {} }));
      await writeFile(
        programmaticConfigPath,
        JSON.stringify({ providers: {} }),
      );
      const config = await unconfiguredConfig(dirs.cwd, {
        cliConfigPath,
        programmaticConfigPath,
      });
      expect(config.cliConfigPath).toBe(cliConfigPath);
      expect(config.programmaticSettingsPath).toBe(true);

      setupSubmits(ISOLATED_PROVIDER);

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("isolated");
      expect(tuiConfig?.providers.map((provider) => provider.name)).toEqual([
        "isolated",
      ]);
      expect(tuiConfig?.globalSettingsPath).toBe(cliConfigPath);
    } finally {
      dirs.cleanup();
    }
  });

  test("keeps a default-path programmatic override isolated after reload", async () => {
    const dirs = createTempDirs(
      "corbits-onboarding-isolated-cwd-",
      "corbits-onboarding-isolated-home-",
    );
    testHome = dirs.home;
    const configPath = join(testHome, ".corbits", "settings.json");
    try {
      await writeXAIAuthProfile(testHome, "hidden");
      await writeFile(configPath, JSON.stringify({ providers: {} }));
      const config = await unconfiguredConfig(dirs.cwd, {
        programmaticConfigPath: configPath,
      });

      setupSubmits(ISOLATED_PROVIDER);

      expect(await runOnboarding(config)).toBe(0);
      expect(tuiConfig?.providerName).toBe("isolated");
      expect(tuiConfig?.providers.map((provider) => provider.name)).toEqual([
        "isolated",
      ]);
      expect(tuiConfig?.globalSettingsPath).toBe(configPath);
    } finally {
      dirs.cleanup();
    }
  });
});
