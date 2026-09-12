// Zen provider identity: detect a Zen-configured provider from an explicit
// provider id or a bare Zen base URL. Mirrors the OpenCode Go identity
// helpers; Go's own URL and id keep matching Go first, never Zen.

import { ZEN_DISPLAY_NAME, ZEN_PROVIDER_ID } from "./constants.js";

function hostMatchesOpencodeDotAi(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "opencode.ai" || normalized.endsWith(".opencode.ai");
}

/**
 * Match a bare Zen base URL: an opencode.ai URL whose first path segment is
 * "zen". The Go catalog URL (https://opencode.ai/zen/go/...) matches Go,
 * never Zen — callers must check Go first.
 */
export function isZenURL(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!hostMatchesOpencodeDotAi(url.hostname)) return false;
    const segments = url.pathname.split("/").filter((part) => part !== "");
    return (
      segments[0]?.toLowerCase() === "zen" &&
      segments[1]?.toLowerCase() !== "go"
    );
  } catch {
    return false;
  }
}

/** Match the Zen provider id or display name (case-insensitive). */
export function isZenProviderId(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === ZEN_PROVIDER_ID ||
    normalized === ZEN_DISPLAY_NAME.toLowerCase()
  );
}

/** Match either an explicit Zen provider id or a bare Zen base URL. */
export function isZenProvider(ref: {
  name?: string;
  baseURL?: string;
}): boolean {
  return isZenProviderId(ref.name) || isZenURL(ref.baseURL);
}
