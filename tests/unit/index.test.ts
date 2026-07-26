import { test, expect, mock } from "bun:test";
import type { Config } from "../../src/config/index.js";
import { mainWithRunners } from "../../src/index.js";

const envVars = {
  // Unit tests must never export telemetry or write an installationId into
  // the developer's real global settings file.
  CORBITS_TELEMETRY: "0",
  OPENAI_COMPATIBLE_API_KEY: "test-key",
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234",
  OPENAI_COMPATIBLE_MODEL: "test-model",
  OPENAI_COMPATIBLE_PROVIDER_NAME: "test-provider",
};

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
      process.env[key] = value;
    }
  }
}

test("main launches TUI when configured", async () => {
  await withEnv(async () => {
    const runTUI = mock((_config: Config) => Promise.resolve(0));
    const runExec = mock((_config: Config) => Promise.resolve(0));
    const runOnboarding = mock(() => Promise.resolve(0));
    const code = await mainWithRunners([], {
      runTUI,
      runExec,
      runOnboarding,
    });
    expect(code).toBe(0);
    expect(runTUI).toHaveBeenCalled();
    expect(runExec).not.toHaveBeenCalled();
  });
});

test("main launches exec when configured with exec subcommand", async () => {
  await withEnv(async () => {
    const runTUI = mock((_config: Config) => Promise.resolve(0));
    const runExec = mock((_config: Config) => Promise.resolve(0));
    const runOnboarding = mock(() => Promise.resolve(0));
    const code = await mainWithRunners(["exec", "say hello"], {
      runTUI,
      runExec,
      runOnboarding,
    });
    expect(code).toBe(0);
    expect(runExec).toHaveBeenCalled();
    expect(runTUI).not.toHaveBeenCalled();
    const cfg = runExec.mock.calls[0]![0];
    expect(cfg.command).toBe("exec");
    expect(cfg.task).toBe("say hello");
  });
});

test("main launches exec for run alias", async () => {
  await withEnv(async () => {
    const runTUI = mock((_config: Config) => Promise.resolve(0));
    const runExec = mock((_config: Config) => Promise.resolve(0));
    const runOnboarding = mock(() => Promise.resolve(0));
    const code = await mainWithRunners(["run", "do the thing"], {
      runTUI,
      runExec,
      runOnboarding,
    });
    expect(code).toBe(0);
    expect(runExec).toHaveBeenCalled();
    const cfg = runExec.mock.calls[0]![0];
    expect(cfg.command).toBe("exec");
    expect(cfg.task).toBe("do the thing");
  });
});
