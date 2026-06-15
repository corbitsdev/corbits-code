import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";

// Writes a minimal valid global settings file with a single provider so that
// provider resolution succeeds; these tests only exercise flag parsing.
async function withSettings(
  fn: (opts: { cwd: string; globalSettingsPath: string }) => void | Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-"));
  const globalSettingsPath = join(cwd, "global.json");
  await writeFile(
    globalSettingsPath,
    JSON.stringify({
      defaultProvider: "test-provider",
      providers: {
        "test-provider": {
          baseURL: "http://localhost:1234",
          apiKey: "test-key",
          models: ["test-model"],
        },
      },
    }),
  );
  try {
    await fn({ cwd, globalSettingsPath });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("loadConfig defaults auto mode on", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const config = await loadConfig(["--cwd", cwd, "do something"], { globalSettingsPath });
    expect(config.auto).toBe(true);
  });
});

test("loadConfig --no-auto disables auto mode", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const config = await loadConfig(["--cwd", cwd, "--no-auto", "do something"], { globalSettingsPath });
    expect(config.auto).toBe(false);
  });
});

test("loadConfig parses --headless flag", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const config = await loadConfig(["--cwd", cwd, "--headless", "do something"], { globalSettingsPath });
    expect(config.headless).toBe(true);
  });
});

test("loadConfig parses -h flag", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const config = await loadConfig(["--cwd", cwd, "-h", "do something"], { globalSettingsPath });
    expect(config.headless).toBe(true);
  });
});

test("loadConfig defaults headless to false", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const config = await loadConfig(["--cwd", cwd, "do something"], { globalSettingsPath });
    expect(config.headless).toBe(false);
  });
});

test("loadConfig headless flag does not consume positional args", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const config = await loadConfig(["--cwd", cwd, "--headless", "read", "file"], { globalSettingsPath });
    expect(config.headless).toBe(true);
    expect(config.task).toBe("read file");
  });
});
