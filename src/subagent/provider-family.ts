import { GROK_RESPONSES_PROVIDER } from "../provider/grok-responses-adapter.js";
import { isXaiProviderName } from "../config/xai-providers.js";

/**
 * True when the leaf inference path is xAI / Grok family.
 * Used only for tiny provider-specific prompt residuals — not for routing.
 */
export function isXaiGrokLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  const name = input.providerName.toLowerCase();
  if (isXaiProviderName(name)) return true;
  if (name === GROK_RESPONSES_PROVIDER || name.includes("grok")) return true;
  if (input.model !== undefined && /^grok/i.test(input.model.trim())) return true;
  return false;
}

/**
 * The finish-bias residual only makes sense on leaf workers: orchestrators
 * dispatch other agents rather than doing the work directly, so telling one
 * to "stop calling tools and write the report" would cut off dispatching.
 */
export function shouldApplyGrokAntiThrash(input: {
  providerName: string;
  model?: string;
  orchestrator: boolean;
}): boolean {
  return !input.orchestrator && isXaiGrokLeafProvider(input);
}
