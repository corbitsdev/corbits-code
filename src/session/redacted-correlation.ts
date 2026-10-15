import { createHash } from "node:crypto";

// Log lines land in ~/.corbits settings logs unauthenticated. A correlation ID
// on the approval rail is a bearer capability: a leaked live ID plus a forged
// decision re-grants a parked call (see src/session/approval-provenance.ts).
// Warn-level log lines therefore carry only a truncated prefix plus a short
// hash — enough to tie receipts across lines, not enough to reconstruct the
// live ID (UUIDv4's ~122 random bits leave ~90 unknown after an 8-hex-char
// prefix is shown, so the shown prefix alone cannot reconstruct the ID; the
// hash suffix exists for cross-line correlation, not for secrecy). The full
// ID still flows on the in-memory transport that consumes it: message
// headers, the gate table and the operator approval surface. The file sink
// (src/logging/sink.ts) records debug level too, so no log line app-side
// carries the full ID at any level.
const PREFIX_CHARS = 8;
const HASH_CHARS = 8;

/** Truncated, hash-suffixed form of a correlation ID for log lines. */
export function redactedCorrelationId(correlationId: string): string {
  const digest = createHash("sha256").update(correlationId).digest("hex");
  return `${correlationId.slice(0, PREFIX_CHARS)}#${digest.slice(0, HASH_CHARS)}`;
}
