// Provider prompt-cache TTLs for idle recompression (CL-8745).
//
// The fold is a re-compress, not a cache play. It is allowed only after a
// published cache expiry, so the next turn rewrites a smaller prefix instead
// of compacting while a warm cache would still have been a cheap read.
//
// Anthropic is the only provider with a published idle expiry we actually
// use: the default ephemeral cache lasts 5 minutes and refreshes on each
// hit. The 1-hour TTL exists, costs more to write, and this client never
// sets it. `zen-messages` and `opencode-go-messages` speak that same
// messages protocol, so they share the 5-minute window.
//
// Everyone else is disabled. OpenAI GPT-5.6+ stays eligible for at least 30
// minutes. Gemini's implicit cache has no published eviction window and its
// explicit cache defaults to 1 hour. DeepSeek's disk cache is cleared over
// hours to days. xAI publishes no TTL. Guessing a shorter window folds a
// cache that is still warm. Ollama has no remote cache. Unknown providers
// stay off rather than inheriting a default.
//
// Deliberate non-goal: the summary call itself carries no `cache_control` —
// prompt-caching the fold is not attempted.

import { isOllamaProviderId } from "./ollama.js";

const MINUTE_MS = 60_000;

/** Published Anthropic ephemeral TTL. The only idle-recompress window. */
const ANTHROPIC_TTL_MS = 5 * MINUTE_MS;

const ANTHROPIC_PROTOCOL = new Set([
  "anthropic",
  "zen-messages",
  "opencode-go-messages",
]);

type CacheTtlIdentity = {
  sourceId?: string;
  provider?: string;
  model?: string;
};

// Canonical provider segment of a `provider/model` string: the account or
// adapter name before the first "/" (custom names like `xai/thegreataxios`
// carry the provider there), else the head before ":".
function canonicalSegment(model: string): string {
  const lower = model.toLowerCase();
  const slash = lower.indexOf("/");
  const head = slash >= 0 ? lower.slice(0, slash) : lower;
  const colon = head.indexOf(":");
  return colon >= 0 ? head.slice(0, colon) : head;
}

function ttlForSegment(segment: string): number | undefined {
  if (!ANTHROPIC_PROTOCOL.has(segment)) return undefined;
  return ANTHROPIC_TTL_MS;
}

/**
 * Milliseconds of provider-cache idle after which a recompress is allowed,
 * or `undefined` when idle recompress must not run. Never throws.
 *
 * Accepts a slash-form `provider/model` string or a LastCycleSource-shaped
 * identity. An explicit provider wins: only the Anthropic messages protocol
 * returns the 5-minute window. A non-Anthropic provider stays disabled even
 * when the model id contains "claude". Ollama is recognized from `sourceId`
 * (`isOllamaProviderId`) before that, because production stamps
 * `provider: openai-compatible` for local inference.
 */
export function cacheTtlMsFor(
  identity: string | CacheTtlIdentity | undefined,
): number | undefined {
  if (identity === undefined) return undefined;
  if (typeof identity === "string")
    return ttlForSegment(canonicalSegment(identity));

  if (identity.sourceId !== undefined && isOllamaProviderId(identity.sourceId))
    return undefined;
  if (identity.provider !== undefined && isOllamaProviderId(identity.provider))
    return undefined;

  if (identity.provider !== undefined && identity.provider.length > 0)
    return ttlForSegment(canonicalSegment(identity.provider));
  return ttlForSegment(canonicalSegment(identity.model ?? ""));
}

/**
 * Wall time to record as the last Anthropic-protocol cache write, or
 * `undefined` when this inference must not stamp one. Other providers stay
 * unstamped so a later resume does not treat their history as an expired
 * Anthropic prefix.
 */
export function anthropicCacheWriteAt(
  identity: string | CacheTtlIdentity | undefined,
  nowMs: number,
): number | undefined {
  if (cacheTtlMsFor(identity) === undefined) return undefined;
  return nowMs;
}

/**
 * Seed for a resumed session's pre-infer fold. Absent unless both the
 * identity that wrote the cache and the provider about to be called are
 * Anthropic-protocol. A stamp alone is not enough: a non-Anthropic model
 * on the run record must not fold.
 */
export function resumeCacheWriteSeed(args: {
  at: number | undefined;
  storedModel: string | undefined;
  liveProvider: string;
}): { at: number; model: string } | undefined {
  if (args.at === undefined) return undefined;
  if (args.storedModel === undefined) return undefined;
  if (cacheTtlMsFor(args.storedModel) === undefined) return undefined;
  if (cacheTtlMsFor(args.liveProvider) === undefined) return undefined;
  return { at: args.at, model: args.storedModel };
}
