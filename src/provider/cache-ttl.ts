// Provider prompt-cache TTLs for idle recompression (CL-8745).
//
// The fold is a re-compress, not a cache play: provider KV caches expire on
// their own schedule, and idle compression fires *after* that expiry so the
// next turn is a cheaper write (a smaller prefix to re-process) and later
// reads compound on the shrunk context. The interval therefore follows
// provider cache economics, not a single global N minutes.
//
// Mapping — idle recompress is allowed once `now - lastCacheWrite >= ttl`:
// - Anthropic (`anthropic`, plus `zen-messages` / `opencode-go-messages`,
//   which speak the Anthropic messages protocol): default 5-minute ephemeral
//   cache TTL. Hour-long breakpoints exist but we never set them. 5 min.
// - OpenAI family (`openai-responses`, `codex-responses`,
//   `openai-compatible`): in-memory prefixes are typically evicted after
//   5-10 minutes idle (retained up to an hour off-peak); GPT-5.6+ families
//   default to a 30-minute minimum TTL instead. 10 min splits the range.
// - xAI (`xai`, `grok-*`): per-server cache, no published TTL; assumed
//   OpenAI-style in-memory economics. 10 min.
// - Gemini (`gemini`, `gemini-*`): implicit caching on 2.5+ with no published
//   eviction window; explicit caches default to 1 hour. Conservative. 15 min.
// - DeepSeek (`deepseek`): on-disk context cache cleared only after
//   hours-to-days idle, so an early recompress would fold a still-warm cache.
//   60 min.
// - ollama: local inference has no remote cache to expire, so an idle
//   recompress would burn local compute for no cache benefit. Disabled.
//   Production LastCycleSource is `{ sourceId, provider, model }` with a
//   bare model; Ollama is `buildOpenAISource` (`provider: openai-compatible`,
//   `sourceId` like `ollama/default`, model `llama3` / `qwen3`). Identity is
//   `sourceId` via `isOllamaProviderId`, not a slash-form string the harness
//   never stamps.
// - Unknown/custom providers (bifrost proxy, `openai-compatible` fronting an
//   unlisted upstream, unrecognized strings): assumed OpenAI-style in-memory
//   economics. 10 min.
//
// Deliberate non-goal: the summary call itself carries no `cache_control` —
// prompt-caching the fold is not attempted.

import { isOllamaProviderId } from "./ollama.js";

const MINUTE_MS = 60_000;

const PROVIDER_TTLS_MS: Record<string, number | undefined> = {
  anthropic: 5 * MINUTE_MS,
  "zen-messages": 5 * MINUTE_MS,
  "opencode-go-messages": 5 * MINUTE_MS,
  "openai-responses": 10 * MINUTE_MS,
  "codex-responses": 10 * MINUTE_MS,
  "openai-compatible": 10 * MINUTE_MS,
  gemini: 15 * MINUTE_MS,
  deepseek: 60 * MINUTE_MS,
  xai: 10 * MINUTE_MS,
  // No remote cache to expire; idle recompress would only burn local compute.
  ollama: undefined,
};

const DEFAULT_TTL_MS = 10 * MINUTE_MS;

// Model-family fallback for unrecognized provider prefixes (custom proxies,
// account names). An exact provider-segment match always wins — e.g. an
// `openai-compatible` account fronting Claude keeps the generic 10-minute
// window rather than Claude's 5. Checked in order; first substring wins.
const FAMILY_TTLS_MS: readonly (readonly [string, number | undefined])[] = [
  ["claude", 5 * MINUTE_MS],
  ["anthropic", 5 * MINUTE_MS],
  ["gpt", 10 * MINUTE_MS],
  ["codex", 10 * MINUTE_MS],
  ["openai", 10 * MINUTE_MS],
  ["grok", 10 * MINUTE_MS],
  ["xai", 10 * MINUTE_MS],
  ["gemini", 15 * MINUTE_MS],
  ["deepseek", 60 * MINUTE_MS],
  ["ollama", undefined],
];

type CacheTtlIdentity = {
  sourceId?: string;
  provider?: string;
  model?: string;
};

// Canonical provider segment of a `provider:model` string: the account or
// adapter name before the first "/" (custom names like `xai/thegreataxios`
// carry the provider there), else the head before ":". Mirrors the
// segmentation in provider/context-window.ts without its window-table
// fallback semantics.
function canonicalSegment(model: string): string {
  const lower = model.toLowerCase();
  const slash = lower.indexOf("/");
  const head = slash >= 0 ? lower.slice(0, slash) : lower;
  const colon = head.indexOf(":");
  return colon >= 0 ? head.slice(0, colon) : head;
}

function ttlForModelString(model: string | undefined): number | undefined {
  if (model === undefined) return undefined;
  const segment = canonicalSegment(model);
  if (segment.length === 0) return undefined;
  if (Object.hasOwn(PROVIDER_TTLS_MS, segment))
    return PROVIDER_TTLS_MS[segment];
  const lower = model.toLowerCase();
  for (const [family, ttl] of FAMILY_TTLS_MS) {
    if (lower.includes(family)) return ttl;
  }
  return DEFAULT_TTL_MS;
}

/**
 * Milliseconds of provider-cache idle after which a recompress is allowed,
 * or `undefined` when the identity is missing/empty or the provider has no
 * remote cache (local inference). Never throws; unknown strings get the
 * default 10-minute window.
 *
 * Accepts a slash-form `provider/model` string or a LastCycleSource-shaped
 * identity. Production events stamp a bare `model`; Ollama is recognized
 * from `sourceId` (`isOllamaProviderId`), not from a combined string the
 * harness never stamps.
 */
export function cacheTtlMsFor(
  identity: string | CacheTtlIdentity | undefined,
): number | undefined {
  if (identity === undefined) return undefined;
  if (typeof identity === "string") return ttlForModelString(identity);

  if (identity.sourceId !== undefined && isOllamaProviderId(identity.sourceId))
    return undefined;
  if (identity.provider !== undefined && isOllamaProviderId(identity.provider))
    return undefined;

  if (identity.provider !== undefined) {
    const provider = identity.provider.toLowerCase();
    if (Object.hasOwn(PROVIDER_TTLS_MS, provider))
      return PROVIDER_TTLS_MS[provider];
  }

  return ttlForModelString(identity.model);
}
