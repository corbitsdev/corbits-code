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
  if (isXaiProviderName(input.providerName)) return true;
  if (name === GROK_RESPONSES_PROVIDER || name.includes("grok")) return true;
  if (input.model !== undefined && /^grok/i.test(input.model.trim())) return true;
  return false;
}
