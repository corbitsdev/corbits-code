import type { TokenUsage } from "@intx/types/runtime";

import { createFaremeter } from "../src/cost/faremeter.js";
import type { PricingCache } from "../src/cost/pricing-fetcher.js";

/** A usage record with only input/output tokens set. */
export function tokenUsage(input: number, output: number): TokenUsage {
  return { input, output, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

/**
 * Price all turns combined at a single model — the "recast" math a mixed
 * session must NOT do. Tests assert real blended billing stays below this.
 */
export function recastAtLiveModel(
  modelId: string,
  pricingCache: PricingCache,
  turns: TokenUsage[],
): number {
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
