import { describe, expect, test } from "bun:test";

import { KEYLESS_API_KEY } from "../config/index.js";
import { OPENCODE_GO_BASE_URL } from "../../packages/opencode-go/src/index.js";
import { buildSubAgentPrimarySource } from "./run.js";

describe("buildSubAgentPrimarySource", () => {
  test("projects an Ollama root into the subagent OpenAI-compatible source", () => {
    const bundle = buildSubAgentPrimarySource({
      providerName: "ollama/default",
      baseURL: "http://localhost:11434",
      keyless: true,
      model: "qwen3",
    });

    expect(bundle.defaultSource).toBe("ollama/default");
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]).toMatchObject({
      id: "ollama/default",
      provider: "openai-compatible",
      baseURL: "http://localhost:11434/v1",
      apiKey: KEYLESS_API_KEY,
      model: "qwen3",
    });
  });

  test.each([
    ["canonical provider id", "opencode-go", "https://example.com/v1"],
    ["canonical base URL", "custom-go", OPENCODE_GO_BASE_URL],
  ])(
    "routes no-catalog OpenCode Go by %s with a non-empty session ID",
    (_, providerName, baseURL) => {
      const bundle = buildSubAgentPrimarySource({
        providerName,
        baseURL,
        apiKey: "sk-go",
        model: "gpt-5.6-luna",
      });

      const source = bundle.sources[0];
      const sessionId = source?.defaults?.providerOptions?.opencodeSessionId;
      expect(bundle.defaultSource).toBe(providerName);
      expect(source).toMatchObject({
        id: providerName,
        provider: "openai-responses",
        apiKey: "sk-go",
        model: "gpt-5.6-luna",
      });
      expect(typeof sessionId).toBe("string");
      expect(sessionId).not.toHaveLength(0);
      expect(source?.defaults?.providerOptions?.openaiSessionId).toBe(
        sessionId,
      );
    },
  );

  test("forwards a session ID through the catalog OpenCode Go path", () => {
    const bundle = buildSubAgentPrimarySource(
      {
        providerName: "opencode-go",
        baseURL: OPENCODE_GO_BASE_URL,
        apiKey: "sk-go",
        model: "kimi-k2.7-code",
      },
      [
        {
          name: "opencode-go",
          baseURL: OPENCODE_GO_BASE_URL,
          apiKey: "sk-go",
          models: ["kimi-k2.7-code"],
          opencodeGo: true,
        },
      ],
    );

    const source = bundle.sources[0];
    const sessionId = source?.defaults?.providerOptions?.opencodeSessionId;
    expect(bundle.defaultSource).toBe("opencode-go");
    expect(source?.provider).toBe("opencode-go");
    expect(typeof sessionId).toBe("string");
    expect(sessionId).not.toHaveLength(0);
  });
});
