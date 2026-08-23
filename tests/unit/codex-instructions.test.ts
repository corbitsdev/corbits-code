import { test, expect, describe } from "bun:test";
import { isValidCodexPrompt, codexInstructions } from "../../src/auth/codex/instructions.js";
import { GPT_5_CODEX_PROMPT } from "../../src/auth/codex/prompts/gpt-5-codex.js";

describe("isValidCodexPrompt", () => {
  test("accepts the bundled prompt", () => {
    expect(isValidCodexPrompt(GPT_5_CODEX_PROMPT)).toBe(true);
  });

  test("rejects a CDN error page", () => {
    expect(
      isValidCodexPrompt("<!DOCTYPE html><html><body>429 Too Many Requests</body></html>"),
    ).toBe(false);
  });

  test("rejects an empty or too-short body", () => {
    expect(isValidCodexPrompt("")).toBe(false);
    expect(isValidCodexPrompt("You are Codex")).toBe(false);
  });
});

describe("codexInstructions", () => {
  test("falls back to the bundled prompt when no valid cache exists", () => {
    expect(isValidCodexPrompt(codexInstructions())).toBe(true);
  });
});
