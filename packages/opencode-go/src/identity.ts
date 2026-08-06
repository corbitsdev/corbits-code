import { OPENCODE_GO_DISPLAY_NAME, OPENCODE_GO_PROVIDER_ID } from "./constants.js";

/**
 * True when the URL or base is the public OpenCode Go gateway.
 *
 * Host must be `opencode.ai` or a subdomain, and path must start with `/zen/go`
 * as a segment (not `/zen/goodies` or a query-embedded substring). Path matching
 * is case-insensitive so product bases like `/Zen/Go` still pin.
 *
 * Intentional false negative: private reverse proxies / self-hosted gateways that
 * front Go under a non-opencode.ai host are not matched by URL alone. Those rows
 * must set `opencodeGo: true` or use the known provider id/label — there is no
 * host allowlist env. Product surface is public-host only.
 */
export function isOpenCodeGoURL(urlOrBase: string | undefined): boolean {
  if (urlOrBase === undefined || urlOrBase.length === 0) return false;
  const trimmed = urlOrBase.trim();
  if (trimmed.length === 0) return false;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "opencode.ai" && !url.hostname.endsWith(".opencode.ai")) {
      return false;
    }
    // Strip trailing slashes, then compare path segments case-insensitively.
    const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
    return path === "/zen/go" || path.startsWith("/zen/go/");
  } catch {
    return false;
  }
}

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
