import { describe, test, expect } from "bun:test";

import { loadConfig } from "../../src/config.js";

const ENV_KEYS = [
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_MODEL",
  "OPENAI_COMPATIBLE_PROVIDER_NAME",
];

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

describe("loadConfig", () => {
  test("requires OPENAI_COMPATIBLE_API_KEY", () => {
    const stash = stashEnv();
    try {
      setRequiredEnv();
      delete process.env.OPENAI_COMPATIBLE_API_KEY;
      expect(() => loadConfig(["add hello world"])).toThrow(
        /OPENAI_COMPATIBLE_API_KEY/,
      );
    } finally {
      restoreEnv(stash);
    }
  });

  test("parses task from positional args", () => {
    const stash = stashEnv();
    try {
      setRequiredEnv();
      const config = loadConfig(["add", "hello", "world"]);
      expect(config.task).toBe("add hello world");
      expect(config.apiKey).toBe("test-key");
      expect(config.baseURL).toBe("https://api.fireworks.ai/inference");
      expect(config.model).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
      expect(config.providerName).toBe("fireworks");
      expect(config.maxTurns).toBe(30);
      expect(config.cwd).toBe(process.cwd());
    } finally {
      restoreEnv(stash);
    }
  });

  test("parses --cwd and --max-turns", () => {
    const stash = stashEnv();
    try {
      setRequiredEnv();
      const config = loadConfig([
        "--cwd",
        "/tmp/test",
        "--max-turns",
        "15",
        "fix bug",
      ]);
      expect(config.cwd).toBe("/tmp/test");
      expect(config.maxTurns).toBe(15);
      expect(config.task).toBe("fix bug");
    } finally {
      restoreEnv(stash);
    }
  });

  test("rejects unknown flags", () => {
    const stash = stashEnv();
    try {
      setRequiredEnv();
      expect(() => loadConfig(["--unknown"])).toThrow(/unrecognized flag/);
    } finally {
      restoreEnv(stash);
    }
  });
});
