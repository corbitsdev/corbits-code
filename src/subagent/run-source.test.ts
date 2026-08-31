import { describe, expect, test } from "bun:test";

import { KEYLESS_API_KEY } from "../config/index.js";
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
});
