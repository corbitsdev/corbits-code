import type { LastCycleSource, TokenUsage } from "@intx/types/runtime";

import { costHiddenReason, type CostHiddenReason } from "./cost-visibility.js";
import { createFaremeter } from "./faremeter.js";
import type { PricingCache } from "./pricing-fetcher.js";

export type SessionBillingMix = "none" | "hidden-only" | "metered-only" | "mixed";

export interface TurnBillingIdentity {
  modelId: string;
  providerName?: string | undefined;
  baseURL?: string | undefined;
  providerFree?: boolean | undefined;
}

export interface SessionCostSnapshot {
  mix: SessionBillingMix;
  meteredCost: number;
  hiddenReason: CostHiddenReason | null;
}

export function sessionBillingMix(hasHidden: boolean, hasMetered: boolean): SessionBillingMix {
  if (hasHidden && hasMetered) return "mixed";
  if (hasHidden) return "hidden-only";
  if (hasMetered) return "metered-only";
  return "none";
}

// Catalog identity lives on sourceId (`codex/default`, `zai`). `provider` is the
// adapter kind (`codex-responses`) and would miss subscription / coding-plan hides.
export function billingIdentityFromSource(source: LastCycleSource): TurnBillingIdentity {
  return { modelId: source.model, providerName: source.sourceId };
}

export function createSessionCostAccumulator(args: { pricingCache: () => PricingCache | null }): {
  addTurn(usage: TokenUsage, identity: TurnBillingIdentity): void;
  reset(): void;
  snapshot(): SessionCostSnapshot;
} {
  let hasHidden = false;
  let hasMetered = false;
  let meteredCost = 0;
  let hiddenReason: CostHiddenReason | null = null;

  return {
    addTurn(usage, identity): void {
      const pricingCache = args.pricingCache();
      const reason = costHiddenReason({
        modelId: identity.modelId,
        baseURL: identity.baseURL,
        providerName: identity.providerName,
        providerFree: identity.providerFree,
        pricingCache,
      });
      if (reason !== null) {
        hasHidden = true;
        hiddenReason = reason;
        return;
      }
      hasMetered = true;
      const faremeter = createFaremeter({ modelId: identity.modelId, pricingCache });
      faremeter.addUsage(usage);
      meteredCost += faremeter.getTotalCost();
    },
    reset(): void {
      hasHidden = false;
      hasMetered = false;
      meteredCost = 0;
      hiddenReason = null;
    },
    snapshot(): SessionCostSnapshot {
      return {
        mix: sessionBillingMix(hasHidden, hasMetered),
        meteredCost,
        hiddenReason,
      };
    },
  };
}
