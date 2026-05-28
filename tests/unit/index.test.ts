import { test, expect, mock } from "bun:test";

const envVars = {
  OPENAI_COMPATIBLE_API_KEY: "test-key",
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234",
  OPENAI_COMPATIBLE_MODEL: "test-model",
  OPENAI_COMPATIBLE_PROVIDER_NAME: "test-provider",
};

function withEnv(fn: () => void | Promise<void>): void {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envVars)) {
    original[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      process.env[key] = value;
    }
  }
}

const mockRunAgent = mock(() => Promise.resolve(0));
const mockRunTUI = mock(() => Promise.resolve(0));

mock.module("../../src/run-agent.js", () => ({
  runAgent: mockRunAgent,
}));

mock.module("../../src/tui/runner.js", () => ({
  runTUI: mockRunTUI,
}));

async function loadMain(): Promise<typeof import("../../src/index.js")> {
  return import("../../src/index.js");
}

test("main requires task in headless mode", async () => {
  withEnv(async () => {
    const { main } = await loadMain();
    const code = await main(["--headless"]);
    expect(code).toBe(1);
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockRunTUI).not.toHaveBeenCalled();
  });
});

test("main does not require task in TUI mode", async () => {
  withEnv(async () => {
    const { main } = await loadMain();
    const code = await main([]);
    expect(code).toBe(0);
    expect(mockRunTUI).toHaveBeenCalled();
  });
});

test("main routes headless with task to runAgent", async () => {
  withEnv(async () => {
    const { main } = await loadMain();
    const code = await main(["--headless", "do something"]);
    expect(code).toBe(0);
    expect(mockRunAgent).toHaveBeenCalled();
  });
});
