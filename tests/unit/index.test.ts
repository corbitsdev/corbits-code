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

const mockRunAgent = mock(() => Promise.resolve(0));
const mockRunTUI = mock(() => Promise.resolve(0));

test("main requires task in headless mode", async () => {
  await withEnv(async () => {
    const code = await mainWithRunners(["--headless"], {
      runAgent: mockRunAgent,
      runTUI: mockRunTUI,
    });
    expect(code).toBe(1);
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockRunTUI).not.toHaveBeenCalled();
  });
});

test("main does not require task in TUI mode", async () => {
  await withEnv(async () => {
    const code = await mainWithRunners([], {
      runAgent: mockRunAgent,
      runTUI: mockRunTUI,
    });
    expect(code).toBe(0);
    expect(mockRunTUI).toHaveBeenCalled();
  });
});

test("main routes headless with task to runAgent", async () => {
  await withEnv(async () => {
    const code = await mainWithRunners(["--headless", "do something"], {
      runAgent: mockRunAgent,
      runTUI: mockRunTUI,
    });
    expect(code).toBe(0);
    expect(mockRunAgent).toHaveBeenCalled();
  });
});
