import type { TokenUsage } from "@intx/types/runtime";

import { lookupModelPricing, type PricingCache } from "./pricing-fetcher.js";

export type FaremeterConfig = {
  inputPricePerToken: number;
  outputPricePerToken: number;
  cacheReadPricePerToken: number;
};

export type CreateFaremeterConfig = Partial<FaremeterConfig> & {
  modelId?: string;
  pricingCache?: PricingCache | null;
};

export type Faremeter = {
  addUsage(usage: TokenUsage): void;
  getTotalCost(): number;
  getTotalTokens(): number;
};

const DEFAULT_CONFIG: FaremeterConfig = {
  inputPricePerToken: 0.000002,
  outputPricePerToken: 0.00001,
  cacheReadPricePerToken: 0,
};

export function createFaremeter(config: CreateFaremeterConfig = {}): Faremeter {
  const modelPricing = config.modelId === undefined ? null : lookupModelPricing(config.pricingCache ?? null, config.modelId);
  const explicitConfig = { ...config };
  delete explicitConfig.modelId;
  delete explicitConfig.pricingCache;
  const { inputPricePerToken, outputPricePerToken, cacheReadPricePerToken } = {
    ...DEFAULT_CONFIG,
    ...modelPricing,
    ...explicitConfig,
  };
  let totalTokens = 0;
  let totalCost = 0;

  return {
    addUsage(usage: TokenUsage): void {
      totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.thinking;
      totalCost += usage.input * inputPricePerToken + usage.output * outputPricePerToken + usage.cacheRead * cacheReadPricePerToken;
    },
    getTotalCost(): number {
      return totalCost;
    },
    getTotalTokens(): number {
      return totalTokens;
    },
  };
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}
