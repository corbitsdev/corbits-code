import type { TokenUsage } from "@intx/types/runtime";

export type FaremeterConfig = {
  inputPricePerToken: number;
  outputPricePerToken: number;
};

export type Faremeter = {
  addUsage(usage: TokenUsage): void;
  getTotalCost(): number;
  getTotalTokens(): number;
};

const DEFAULT_CONFIG: FaremeterConfig = {
  inputPricePerToken: 0.000002,
  outputPricePerToken: 0.00001,
};

export function createFaremeter(config: Partial<FaremeterConfig> = {}): Faremeter {
  const { inputPricePerToken, outputPricePerToken } = { ...DEFAULT_CONFIG, ...config };
  let totalTokens = 0;
  let totalCost = 0;

  return {
    addUsage(usage: TokenUsage): void {
      totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.thinking;
      totalCost += usage.input * inputPricePerToken + usage.output * outputPricePerToken;
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
