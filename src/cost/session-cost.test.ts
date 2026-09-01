import { describe, expect, it } from "bun:test";
import type { TokenUsage } from "@intx/types/runtime";

import { createFaremeter, formatCost } from "./faremeter.js";
import type { PricingCache } from "./pricing-fetcher.js";
import { billingIdentityFromSource, createSessionCostAccumulator } from "./session-cost.js";

const pricingCache: PricingCache = {
  timestamp: 0,
  models: {
    "glm-5.1": {
      inputPricePerToken: 0.000002,
      outputPricePerToken: 0.00001,
      cacheReadPricePerToken: 0,
    },
    "gpt-5.6-luna": {
      inputPricePerToken: 0.000001,
      outputPricePerToken: 0.000008,
      cacheReadPricePerToken: 0,
    },
  },
};

const usage = (input: number, output: number): TokenUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
});

const CODEX_USAGE = usage(100_000, 20_000);
const METERED_USAGE = usage(1_000, 500);

function recastAtLiveModel(modelId: string, turns: TokenUsage[]): number {
  const faremeter = createFaremeter({ modelId, pricingCache });
  const combined: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
  };
  for (const turn of turns) {
    combined.input += turn.input;
    combined.output += turn.output;
    combined.cacheRead += turn.cacheRead;
    combined.cacheWrite += turn.cacheWrite;
    combined.thinking += turn.thinking;
  }
  faremeter.addUsage(combined);
  return faremeter.getTotalCost();
}

describe("createSessionCostAccumulator", () => {
  it("prices Codex then metered as the metered turns only, not a live-model recast of the sink", () => {
    const acc = createSessionCostAccumulator({ pricingCache: () => pricingCache });
    acc.addTurn(CODEX_USAGE, { modelId: "gpt-5.6-luna", providerName: "codex/default" });
    acc.addTurn(METERED_USAGE, { modelId: "glm-5.1", providerName: "openai" });

    const meteredOnly = createFaremeter({ modelId: "glm-5.1", pricingCache });
    meteredOnly.addUsage(METERED_USAGE);
    const snapshot = acc.snapshot();

    expect(snapshot.mix).toBe("mixed");
    expect(snapshot.meteredCost).toBe(meteredOnly.getTotalCost());
    expect(snapshot.meteredCost).toBeLessThan(
      recastAtLiveModel("glm-5.1", [CODEX_USAGE, METERED_USAGE]),
    );
    expect(formatCost(snapshot.meteredCost)).toBe(formatCost(meteredOnly.getTotalCost()));
  });

  it("prices metered then Codex as mixed with only the metered turns billed", () => {
    const acc = createSessionCostAccumulator({ pricingCache: () => pricingCache });
    acc.addTurn(METERED_USAGE, { modelId: "glm-5.1", providerName: "openai" });
    acc.addTurn(CODEX_USAGE, { modelId: "gpt-5.6-luna", providerName: "codex/default" });

    const meteredOnly = createFaremeter({ modelId: "glm-5.1", pricingCache });
    meteredOnly.addUsage(METERED_USAGE);
    const snapshot = acc.snapshot();

    expect(snapshot.mix).toBe("mixed");
    expect(snapshot.hiddenReason).toBe("chatgpt-subscription");
    expect(snapshot.meteredCost).toBe(meteredOnly.getTotalCost());
    expect(snapshot.meteredCost).toBeGreaterThan(0);
  });

  it("keeps a Codex-only session hidden with the subscription reason", () => {
    const acc = createSessionCostAccumulator({ pricingCache: () => pricingCache });
    acc.addTurn(CODEX_USAGE, { modelId: "gpt-5.6-luna", providerName: "codex/default" });

    const snapshot = acc.snapshot();
    expect(snapshot.mix).toBe("hidden-only");
    expect(snapshot.hiddenReason).toBe("chatgpt-subscription");
    expect(snapshot.meteredCost).toBe(0);
  });

  it("maps Codex catalog identity from sourceId, not the adapter kind", () => {
    expect(
      billingIdentityFromSource({
        sourceId: "codex/default",
        provider: "codex-responses",
        model: "gpt-5.6-luna",
      }),
    ).toEqual({ modelId: "gpt-5.6-luna", providerName: "codex/default" });

    const acc = createSessionCostAccumulator({ pricingCache: () => pricingCache });
    acc.addTurn(
      CODEX_USAGE,
      billingIdentityFromSource({
        sourceId: "codex/default",
        provider: "codex-responses",
        model: "gpt-5.6-luna",
      }),
    );
    expect(acc.snapshot()).toEqual({
      mix: "hidden-only",
      meteredCost: 0,
      hiddenReason: "chatgpt-subscription",
    });
  });

  it("resets mix and metered cost for a new session", () => {
    const acc = createSessionCostAccumulator({ pricingCache: () => pricingCache });
    acc.addTurn(METERED_USAGE, { modelId: "glm-5.1", providerName: "openai" });
    acc.addTurn(CODEX_USAGE, { modelId: "gpt-5.6-luna", providerName: "codex/default" });
    acc.reset();

    expect(acc.snapshot()).toEqual({ mix: "none", meteredCost: 0, hiddenReason: null });
  });
});
