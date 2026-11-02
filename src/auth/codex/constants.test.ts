import { describe, expect, test } from "bun:test";

import { CODEX_DEFAULT_MODELS } from "./constants.js";

describe("CODEX_DEFAULT_MODELS", () => {
  // The order the Codex backend listed these models in; the first is the
  // ChatGPT default. Nothing else pins it: the other tests read the constant.
  test("follows the order the Codex backend lists the models in", () => {
    expect([...CODEX_DEFAULT_MODELS]).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-6.1-terra",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
  });

  test("leaves out the models OpenAI's documentation lists as retired for ChatGPT", () => {
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]) {
      expect(CODEX_DEFAULT_MODELS as readonly string[]).not.toContain(retired);
    }
  });
});
