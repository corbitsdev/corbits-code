import type { PricingCache } from "./pricing-fetcher.js";

/**
 * Pricing cache shared by the cost test files: metered glm-5.1, metered
 * gpt-5.6-luna, zero-priced free-model, and gpt-4 for the lookup tests.
 * Prices are exact — session-cost assertions compare computed totals.
 */
export const testPricingCache: PricingCache = {
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
    "free-model": {
      inputPricePerToken: 0,
      outputPricePerToken: 0,
      cacheReadPricePerToken: 0,
    },
    "gpt-4": {
      inputPricePerToken: 0.00003,
      outputPricePerToken: 0.00006,
      cacheReadPricePerToken: 0,
    },
  },
};
