import { describe, expect, test } from "bun:test";

import { CODEX_DEFAULT_MODELS } from "./constants.js";

describe("CODEX_DEFAULT_MODELS", () => {
  // Recorded from GET /codex/models for a ChatGPT Plus account (client_version
  // 0.165.0, 2026-11-01). Nothing else pins the order or the default: the other
  // tests read the constant.
  test("follows the order the Codex backend listed the models in", () => {
    expect([...CODEX_DEFAULT_MODELS]).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  test("leaves out the models OpenAI retired for ChatGPT sign-in", () => {
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]) {
      expect(CODEX_DEFAULT_MODELS as readonly string[]).not.toContain(retired);
    }
  });
});
