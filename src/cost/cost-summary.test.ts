import { describe, expect, it } from "bun:test";

import { buildCostSummary, formatCostCommandOutput, formatStatusBarSegments } from "./cost-summary.js";
import type { CostSummaryInput } from "./cost-summary.js";

const baseInput: CostSummaryInput = {
  modelId: "test-model",
  pricingCache: null,
  totalCost: 0.0123,
  formattedCost: "$0.0123",
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 200,
  contextTokens: 64_000,
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

  it("hides cost for a free-named model", () => {
    const summary = buildCostSummary({ ...baseInput, modelId: "qwen3:free" });
    expect(summary.hideCost).toBe(true);
  });

  it("shows cost for a normal metered model", () => {
    const summary = buildCostSummary(baseInput);
    expect(summary.hideCost).toBe(false);
  });
});

describe("formatStatusBarSegments", () => {
  it("includes both cost and context when cost is not hidden", () => {
    const summary = buildCostSummary(baseInput);
    expect(formatStatusBarSegments(summary)).toEqual({ costLabel: "$0.0123", contextLabel: "Ctx 50%" });
  });

  it("omits cost but keeps context when cost is hidden", () => {
    const summary = buildCostSummary({ ...baseInput, modelId: "qwen3:free" });
    expect(formatStatusBarSegments(summary)).toEqual({ contextLabel: "Ctx 50%" });
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

  it("reports cost as hidden for a free model", () => {
    const summary = buildCostSummary({ ...baseInput, modelId: "qwen3:free" });
    expect(formatCostCommandOutput(summary)).toContain("Cost: hidden (free model or coding plan)");
  });
});
