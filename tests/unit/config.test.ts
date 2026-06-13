import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";

const envVars = {
  OPENAI_COMPATIBLE_API_KEY: "test-key",
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234",
  OPENAI_COMPATIBLE_MODEL: "test-model",
  OPENAI_COMPATIBLE_PROVIDER_NAME: "test-provider",
};

// A global settings path that does not exist, so the env vars above drive
// resolution and the test stays independent of the dev machine.
const NO_SETTINGS = join(tmpdir(), "intercode-tests-missing", ".interchange", "settings.json");

async function withEnv(fn: () => void | Promise<void>): Promise<void> {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envVars)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig defaults auto mode on", async () => {
  await withEnv(async () => {
    const config = await loadConfig(["do something"], { globalSettingsPath: NO_SETTINGS });
    expect(config.auto).toBe(true);
  });
});

test("loadConfig --no-auto disables auto mode", async () => {
  await withEnv(async () => {
    const config = await loadConfig(["--no-auto", "do something"], { globalSettingsPath: NO_SETTINGS });
    expect(config.auto).toBe(false);
  });
});

test("loadConfig parses --headless flag", async () => {
  await withEnv(async () => {
    const config = await loadConfig(["--headless", "do something"], { globalSettingsPath: NO_SETTINGS });
    expect(config.headless).toBe(true);
  });
});

test("loadConfig parses -h flag", async () => {
  await withEnv(async () => {
    const config = await loadConfig(["-h", "do something"], { globalSettingsPath: NO_SETTINGS });
    expect(config.headless).toBe(true);
  });
});

test("loadConfig defaults headless to false", async () => {
  await withEnv(async () => {
    const config = await loadConfig(["do something"], { globalSettingsPath: NO_SETTINGS });
    expect(config.headless).toBe(false);
  });
});

test("loadConfig headless flag does not consume positional args", async () => {
  await withEnv(async () => {
    const config = await loadConfig(["--headless", "read", "file"], { globalSettingsPath: NO_SETTINGS });
    expect(config.headless).toBe(true);
    expect(config.task).toBe("read file");
  });
});
