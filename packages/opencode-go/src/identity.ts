import { OPENCODE_GO_DISPLAY_NAME, OPENCODE_GO_PROVIDER_ID } from "./constants.js";
import { isOpenCodeGoURL } from "./errors.js";

/**
 * True when this catalog/settings name is the first-class OpenCode Go provider.
 * Accepts both the stable id and the human display label so mis-seeded rows still
 * route to the subscription gateway.
 */
export function isOpenCodeGoProviderId(name: string | undefined): boolean {
  if (name === undefined || name.length === 0) return false;
  return name === OPENCODE_GO_PROVIDER_ID || name === OPENCODE_GO_DISPLAY_NAME;
}

/**
 * True when a provider entry is OpenCode Go — explicit flag, known id/label, or
 * a `/zen/go` baseURL. URL identity wins even for odd names (hard cutover).
 */
export function isOpenCodeGoProvider(entry: {
  name?: string;
  opencodeGo?: boolean;
  baseURL?: string;
}): boolean {
  return (
    entry.opencodeGo === true ||
    isOpenCodeGoProviderId(entry.name) ||
    isOpenCodeGoURL(entry.baseURL)
  );
}
