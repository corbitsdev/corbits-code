import { afterEach, describe, expect, it } from "bun:test";

import { setModelContextWindows } from "../provider/context-window.js";
import {
  buildCostSummary,
  formatCostCommandOutput,
  formatStatusBarSegments,
  maskContextMeterWhenNoTurns,
} from "./cost-summary.js";
import type { CostSummaryInput } from "./cost-summary.js";

afterEach(() => setModelContextWindows(undefined));

const baseInput: CostSummaryInput = {
  modelId: "test-model",
  pricingCache: null,
  totalCost: 0.0123,
  formattedCost: "$0.0123",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 200,
  contextTokens: 64_000,
  contextIsEstimate: false,
};

describe("buildCostSummary", () => {
  it("computes context window and percent used from the model's default window", () => {
    const summary = buildCostSummary(baseInput);
    expect(summary.contextWindow).toBe(128_000);
    expect(summary.contextPercentUsed).toBe(50);
  });

  it("caps percent used at 100", () => {
    const summary = buildCostSummary({ ...baseInput, contextTokens: 500_000 });
    expect(summary.contextPercentUsed).toBe(100);
  });

  it("reports percent as unknown when the context window is non-positive", () => {
    setModelContextWindows({ "test-model": 0 });
    const summary = buildCostSummary(baseInput);
    expect(summary.contextPercentUsed).toBeNull();
  });

  it("hides cost for a free-named model", () => {
    const summary = buildCostSummary({ ...baseInput, modelId: "qwen3:free" });
    expect(summary.costHiddenReason).toBe("free-model");
  });

  it("hides cost for a coding-plan base URL", () => {
    const summary = buildCostSummary({
      ...baseInput,
      baseURL: "https://api.z.ai/api/coding/paas/v4",
    });
    expect(summary.costHiddenReason).toBe("coding-plan");
  });

  it("hides cost for a Codex ChatGPT subscription identity", () => {
    const summary = buildCostSummary({
      ...baseInput,
      modelId: "gpt-5.6-luna",
      providerName: "codex/default",
      baseURL: "https://api.openai.com/v1",
    });
    expect(summary.costHiddenReason).toBe("chatgpt-subscription");
  });

  it("hides cost for a provider marked free", () => {
    const summary = buildCostSummary({ ...baseInput, providerFree: true });
    expect(summary.costHiddenReason).toBe("provider-free");
  });

  it("shows cost for a normal metered model", () => {
    const summary = buildCostSummary(baseInput);
    expect(summary.costHiddenReason).toBeNull();
  });
});

describe("maskContextMeterWhenNoTurns", () => {
  it("hides the meter on a zero-turn session even when contextTokens are non-zero", () => {
    const summary = buildCostSummary(baseInput);
    expect(summary.contextPercentUsed).toBe(50);

    const masked = maskContextMeterWhenNoTurns(summary, 0);
    expect(masked.contextPercentUsed).toBeNull();
    expect(masked.contextIsEstimate).toBe(false);
    // Cost totals stay untouched — only occupancy display is suppressed.
    expect(masked.totalCost).toBe(summary.totalCost);
    expect(masked.formattedCost).toBe(summary.formattedCost);
  });

  it("leaves a session with turns unchanged", () => {
    const summary = buildCostSummary(baseInput);
    expect(maskContextMeterWhenNoTurns(summary, 1)).toEqual(summary);
  });
});

describe("formatStatusBarSegments", () => {
  it("includes both cost and context when cost is not hidden", () => {
    const summary = buildCostSummary(baseInput);
    expect(formatStatusBarSegments(summary)).toEqual({
      costLabel: "$0.0123",
      contextLabel: "Ctx 50%",
      contextPercentUsed: 50,
    });
  });

  it("omits cost but keeps context when cost is hidden", () => {
    const summary = buildCostSummary({ ...baseInput, modelId: "qwen3:free" });
    expect(formatStatusBarSegments(summary)).toEqual({
      contextLabel: "Ctx 50%",
      contextPercentUsed: 50,
    });
  });

  it("omits dollar cost for a Codex ChatGPT subscription session", () => {
    const summary = buildCostSummary({
      ...baseInput,
      modelId: "gpt-5.6-luna",
      providerName: "codex/default",
      baseURL: "https://api.openai.com/v1",
      totalCost: 1.1897,
      formattedCost: "$1.1897",
    });
    expect(formatStatusBarSegments(summary)).toEqual({
      contextLabel: "Ctx 16%",
      contextPercentUsed: 16,
    });
  });

  it("renders an unknown context window as --% rather than 0%", () => {
    setModelContextWindows({ "test-model": 0 });
    const summary = buildCostSummary(baseInput);
    const segments = formatStatusBarSegments(summary);
    expect(segments.contextLabel).toBe("Ctx --%");
    expect(segments.contextPercentUsed).toBeNull();
  });

  it("flags an estimated context percentage with a tilde", () => {
    const summary = buildCostSummary({ ...baseInput, contextIsEstimate: true });
    expect(formatStatusBarSegments(summary).contextLabel).toBe("Ctx ~50%");
  });
});

describe("formatCostCommandOutput", () => {
  it("prints a full breakdown for a normal metered model", () => {
    const summary = buildCostSummary(baseInput);
    expect(formatCostCommandOutput(summary)).toBe(
      [
        "Model: test-model",
        "Cost: $0.0123",
        "Tokens: 1000 in / 500 out / 200 cache-read",
        "Context: 64000/128000 (50%)",
      ].join("\n"),
    );
  });

  it("reports the reason cost is hidden for a free model", () => {
    const summary = buildCostSummary({ ...baseInput, modelId: "qwen3:free" });
    expect(formatCostCommandOutput(summary)).toContain("Cost: hidden (free model)");
  });

  it("reports the reason cost is hidden for a coding-plan endpoint", () => {
    const summary = buildCostSummary({
      ...baseInput,
      baseURL: "https://api.z.ai/api/coding/paas/v4",
    });
    expect(formatCostCommandOutput(summary)).toContain("Cost: hidden (coding-plan endpoint)");
  });

  it("reports ChatGPT subscription coverage instead of a hidden dollar figure", () => {
    const summary = buildCostSummary({
      ...baseInput,
      modelId: "gpt-5.6-luna",
      providerName: "codex/default",
      baseURL: "https://api.openai.com/v1",
    });
    expect(formatCostCommandOutput(summary)).toBe(
      [
        "Model: gpt-5.6-luna",
        "Cost: covered by ChatGPT subscription (not billed per token)",
        "Tokens: 1000 in / 500 out / 200 cache-read",
        "Context: 64000/400000 (16%)",
      ].join("\n"),
    );
  });

  it("reports the reason cost is hidden for a provider marked free", () => {
    const summary = buildCostSummary({ ...baseInput, providerFree: true });
    expect(formatCostCommandOutput(summary)).toContain("Cost: hidden (provider marked free)");
  });

  it("prints unknown for a non-positive context window", () => {
    setModelContextWindows({ "test-model": 0 });
    const summary = buildCostSummary(baseInput);
    expect(formatCostCommandOutput(summary)).toContain("Context: 64000/unknown (--%)");
  });

  it("flags an estimated context percentage with a tilde", () => {
    const summary = buildCostSummary({ ...baseInput, contextIsEstimate: true });
    expect(formatCostCommandOutput(summary)).toContain("(~50%)");
  });
});
