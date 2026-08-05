import { OPENCODE_GO_DISPLAY_NAME, OPENCODE_GO_PROVIDER_ID } from "./constants.js";

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
 * True when a provider entry is OpenCode Go — explicit flag or known id/label.
 */
export function isOpenCodeGoProvider(entry: {
  name?: string;
  opencodeGo?: boolean;
}): boolean {
  return entry.opencodeGo === true || isOpenCodeGoProviderId(entry.name);
}
