import { describe, test, expect } from "bun:test";

import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  test("requires XAI_API_KEY", () => {
    const original = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      expect(() => loadConfig(["add hello world"])).toThrow(/XAI_API_KEY/);
    } finally {
      if (original !== undefined) {
        process.env.XAI_API_KEY = original;
      }
    }
  });

  test("parses task from positional args", () => {
    const original = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    try {
      const config = loadConfig(["add", "hello", "world"]);
      expect(config.task).toBe("add hello world");
      expect(config.apiKey).toBe("test-key");
      expect(config.baseURL).toBe("https://api.x.ai/v1");
      expect(config.model).toBe("default-model");
      expect(config.maxTurns).toBe(30);
      expect(config.cwd).toBe(process.cwd());
    } finally {
      if (original !== undefined) {
        process.env.XAI_API_KEY = original;
      } else {
        delete process.env.XAI_API_KEY;
      }
    }
  });

  test("parses --cwd and --max-turns", () => {
    const original = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    try {
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
      if (original !== undefined) {
        process.env.XAI_API_KEY = original;
      } else {
        delete process.env.XAI_API_KEY;
      }
    }
  });

  test("rejects unknown flags", () => {
    const original = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-key";
    try {
      expect(() => loadConfig(["--unknown"])).toThrow(/unrecognized flag/);
    } finally {
      if (original !== undefined) {
        process.env.XAI_API_KEY = original;
      } else {
        delete process.env.XAI_API_KEY;
      }
    }
  });
});
