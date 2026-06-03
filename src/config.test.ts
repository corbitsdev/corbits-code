import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";

const ENV_KEYS = [
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_MODEL",
  "OPENAI_COMPATIBLE_PROVIDER_NAME",
];

// A global settings path guaranteed not to exist, so file resolution is inert
// and the env-based tests below stay hermetic regardless of the dev machine's
// real ~/.interchange/settings.json.
const NO_SETTINGS = join(tmpdir(), "interchange-code-tests-missing", ".interchange", "settings.json");

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
      expect(config.task).toBe("add hello world");
      expect(config.apiKey).toBe("test-key");
      expect(config.baseURL).toBe("https://api.fireworks.ai/inference");
      expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
      expect(config.providerName).toBe("fireworks");
      expect(config.force).toBe(false);
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("throws when no provider can be resolved", async () => {
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
      expect(config.providerName).toBe("firepass");
      expect(config.baseURL).toBe("https://firepass.example/v1");
      expect(config.apiKey).toBe("fp-key");
      expect(config.model).toBe("fp-large");
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
      expect(config.apiKey).toBe("env-key");
      expect(config.providerName).toBe("firepass");
      expect(config.baseURL).toBe("https://firepass.example/v1");
      expect(config.model).toBe("fp-large");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("per-repo local settings select the provider", async () => {
    const stash = stashEnv();
    const cwd = await emptyCwd();
    try {
      await mkdir(join(cwd, ".interchange"), { recursive: true });
      await writeFile(
        join(cwd, ".interchange", "settings.json"),
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
      expect(config.providerName).toBe("b");
      expect(config.model).toBe("b-model");
      expect(config.apiKey).toBe("b-key");
    } finally {
      restoreEnv(stash);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
