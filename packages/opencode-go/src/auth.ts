export type GoApiKeyValidation =
  | { ok: true; apiKey: string }
  | { ok: false; error: string };

/**
 * Validate a pasted OpenCode Go API key at the boundary.
 * Keys are opaque bearer tokens from the Zen console; we only require
 * non-empty printable content (no whitespace-only paste).
 */
export function validateGoApiKey(raw: string): GoApiKeyValidation {
  const apiKey = raw.trim();
  if (apiKey.length === 0) {
    return { ok: false, error: "API key is required" };
  }
  if (/\s/.test(apiKey)) {
    return { ok: false, error: "API key must not contain whitespace" };
  }
  if (apiKey.length < 8) {
    return { ok: false, error: "API key looks too short" };
  }
  return { ok: true, apiKey };
}
