import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config.js";

const envVars = {
  OPENAI_COMPATIBLE_API_KEY: "test-key",
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234",
  OPENAI_COMPATIBLE_MODEL: "test-model",
  OPENAI_COMPATIBLE_PROVIDER_NAME: "test-provider",
};

function withEnv(fn: () => void): void {
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

test("loadConfig parses --headless flag", () => {
  withEnv(() => {
    const config = loadConfig(["--headless", "do something"]);
    expect(config.headless).toBe(true);
  });
});

test("loadConfig parses -h flag", () => {
  withEnv(() => {
    const config = loadConfig(["-h", "do something"]);
    expect(config.headless).toBe(true);
  });
});

test("loadConfig defaults headless to false", () => {
  withEnv(() => {
    const config = loadConfig(["do something"]);
    expect(config.headless).toBe(false);
  });
});

test("loadConfig headless flag does not consume positional args", () => {
  withEnv(() => {
    const config = loadConfig(["--headless", "read", "file"]);
    expect(config.headless).toBe(true);
    expect(config.task).toBe("read file");
  });
});
