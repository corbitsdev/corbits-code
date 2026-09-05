import { isKnownGoModel, isOpenCodeGoProvider } from "../../packages/opencode-go/src/index.js";

/** How the provider is billed when known (Go subscription vs Zen PAYG credits). */
export type BillingProduct = "subscription" | "credits";

export interface BillingProductProvider {
  name?: string;
  baseURL?: string;
  opencodeGo?: boolean;
}

const BARE_ZEN_BASES = new Set([
  "https://opencode.ai/zen/v1",
  "https://opencode.ai/zen",
  "http://opencode.ai/zen/v1",
  "http://opencode.ai/zen",
]);

/** True when baseURL is bare OpenCode Zen PAYG (no /go segment). */
export function isBareZenBaseURL(baseURL: string): boolean {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (BARE_ZEN_BASES.has(trimmed)) return true;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "opencode.ai" && !url.hostname.endsWith(".opencode.ai")) {
      return false;
    }
    const path = url.pathname.replace(/\/+$/, "");
    // /zen/v1 or /zen — exclude /zen/go and /zen/go/v1
    return path === "/zen/v1" || path === "/zen";
  } catch {
    return false;
  }
}

/**
 * Resolve the billing product for a catalog/provider entry.
 * - OpenCode Go (flag, known id/label, or Go baseURL) → subscription
 * - Zen by name or bare zen baseURL → credits
 */
export function billingProductForProvider(
  entry: BillingProductProvider,
): BillingProduct | undefined {
  if (isOpenCodeGoProvider(entry)) {
    return "subscription";
  }
  if (entry.name === "zen") return "credits";
  if (entry.baseURL !== undefined && isBareZenBaseURL(entry.baseURL)) {
    return "credits";
  }
  return undefined;
}

/**
 * True when a protocol-map Go model id is configured on a Zen-billed provider path.
 * "Known" is local PROTOCOL_BY_ID membership, not live-picker membership.
 * Used to surface a cross-product warning (Go model would bill as Zen PAYG).
 */
export function isGoModelOnZenPath(modelId: string, provider: BillingProductProvider): boolean {
  if (!isKnownGoModel(modelId)) return false;
  if (isOpenCodeGoProvider(provider)) return false;
  return billingProductForProvider(provider) === "credits";
}
