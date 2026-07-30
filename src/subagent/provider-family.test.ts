import { describe, expect, test } from "bun:test";
import { isXaiGrokLeafProvider, shouldApplyGrokAntiThrash } from "./provider-family.js";

describe("isXaiGrokLeafProvider", () => {
  test("matches xai/ OAuth provider names", () => {
    expect(isXaiGrokLeafProvider({ providerName: "xai/default" })).toBe(true);
    expect(isXaiGrokLeafProvider({ providerName: "xai/work" })).toBe(true);
  });

  test("matches grok-responses adapter id", () => {
    expect(isXaiGrokLeafProvider({ providerName: "grok-responses" })).toBe(true);
  });

  test("matches model ids that start with grok", () => {
    expect(
      isXaiGrokLeafProvider({ providerName: "openai-compat", model: "grok-4.5" }),
    ).toBe(true);
  });

  test("rejects codex and generic providers", () => {
    expect(isXaiGrokLeafProvider({ providerName: "codex", model: "gpt-5.1" })).toBe(false);
    expect(
      isXaiGrokLeafProvider({ providerName: "anthropic", model: "claude-sonnet-4" }),
    ).toBe(false);
    expect(isXaiGrokLeafProvider({ providerName: "openai", model: "gpt-4.1" })).toBe(false);
  });

  test("matches xai/ OAuth provider names regardless of case", () => {
    expect(isXaiGrokLeafProvider({ providerName: "XAI/default" })).toBe(true);
  });
});

describe("shouldApplyGrokAntiThrash", () => {
  test("applies the residual to a Grok leaf worker", () => {
    expect(
      shouldApplyGrokAntiThrash({ providerName: "xai/default", orchestrator: false }),
    ).toBe(true);
  });

  test("withholds the residual from a Grok orchestrator", () => {
    expect(
      shouldApplyGrokAntiThrash({ providerName: "xai/default", orchestrator: true }),
    ).toBe(false);
  });

  test("withholds the residual from non-Grok leaves", () => {
    expect(
      shouldApplyGrokAntiThrash({ providerName: "anthropic", orchestrator: false }),
    ).toBe(false);
  });
});
