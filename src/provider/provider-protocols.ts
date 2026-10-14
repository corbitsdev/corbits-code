/**
 * Canonical provider/protocol identities shared by the cache consumers
 * (`cache-ttl.ts`, `anthropic-cache-breakpoint.ts`) so the TTL window and
 * the breakpoint pass cannot disagree about which providers speak the
 * Anthropic messages protocol. A new session-header wrapper joins both by
 * adding one entry.
 */

import {
  OPENCODE_GO_MESSAGES_PROVIDER,
  ZEN_MESSAGES_PROVIDER,
} from "./anthropic-session-adapter.js";

export const ANTHROPIC_MESSAGES_PROTOCOLS: ReadonlySet<string> = new Set([
  "anthropic",
  ZEN_MESSAGES_PROVIDER,
  OPENCODE_GO_MESSAGES_PROVIDER,
]);

// Canonical provider segment of a `provider/model` string: the account or
// adapter name before the first "/" (custom names like `xai/alice` carry the
// provider there), else the head before ":". Lowercased; catalog ids carry
// no consistent case.
export function canonicalProviderSegment(value: string): string {
  const lower = value.toLowerCase();
  const slash = lower.indexOf("/");
  const head = slash >= 0 ? lower.slice(0, slash) : lower;
  const colon = head.indexOf(":");
  return colon >= 0 ? head.slice(0, colon) : head;
}
