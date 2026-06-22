import { test, expect, mock } from "bun:test";
import { mainWithRunners } from "../../src/index.js";

const envVars = {
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

const mockRunTUI = mock(() => Promise.resolve(0));
const mockRunOnboarding = mock(() => Promise.resolve(0));

test("main launches TUI when configured", async () => {
  await withEnv(async () => {
    const code = await mainWithRunners([], {
      runTUI: mockRunTUI,
      runOnboarding: mockRunOnboarding,
    });
    expect(code).toBe(0);
    expect(mockRunTUI).toHaveBeenCalled();
  });
});
