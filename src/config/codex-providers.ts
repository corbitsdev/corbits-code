import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js";
import type { CodexProfile } from "../auth/codex/store.js";
import type { ProviderSettings } from "./settings.js";

// Codex OAuth profiles surface through the same provider catalog as API-key
// providers so the /agent picker lists them inline. Each profile becomes a
// provider named "codex/<profile>"; the prefix namespaces them and signals the
// OAuth origin in the UI without special-casing the picker.

export const CODEX_PROVIDER_PREFIX = "codex/";

export function codexProviderName(profile: string): string {
  return `${CODEX_PROVIDER_PREFIX}${profile}`;
}

export function isCodexProviderName(name: string): boolean {
  return name.startsWith(CODEX_PROVIDER_PREFIX);
}

// The profile name embedded in a "codex/<profile>" provider name, or undefined
// if the name is not a Codex provider.
export function codexProfileFromProviderName(name: string): string | undefined {
  return isCodexProviderName(name) ? name.slice(CODEX_PROVIDER_PREFIX.length) : undefined;
}

// Project Codex profiles into synthetic ProviderSettings so resolveProvider can
// treat a selected "codex/<profile>" exactly like any configured provider. The
// apiKey seeds the stored access token; the send path refreshes it before use,
// so a stale seed never reaches the wire.
export function codexProvidersAsSettings(profiles: readonly CodexProfile[]): Record<string, ProviderSettings> {
  const entries: Record<string, ProviderSettings> = {};
  for (const profile of profiles) {
    entries[codexProviderName(profile.name)] = {
      name: codexProviderName(profile.name),
      baseURL: CODEX_BASE_URL,
      apiKey: profile.tokens.access,
      models: [...CODEX_DEFAULT_MODELS],
      defaultModel: CODEX_DEFAULT_MODELS[0],
    };
  }
  return entries;
}
