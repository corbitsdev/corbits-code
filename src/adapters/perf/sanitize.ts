/**
 * Privacy fence for PerfTrace tags.
 *
 * Allowed: phase-related enums, provider/model ids, numeric durations/bytes/counts,
 * transport enum, short opaque ids.
 * Forbidden: prompts, completions, tool args, paths, free-text errors, stack traces.
 */

export type TransportKind = "http_sse" | "ws";

/** Permission-wait decision enum (allowlisted; never free text). */
export type DecisionKind = "allow" | "deny";

/** Tag keys that may appear on a span. Everything else is stripped. */
export const ALLOWED_TAG_KEYS = [
  "provider_id",
  "model_id",
  "transport",
  "decision",
  "duration_ms",
  "duration_ns",
  "bytes",
  "payload_bytes",
  "count",
  "input_tokens",
  "output_tokens",
  "turn_id",
  "subagent_id",
  "tool_id",
] as const;

export type AllowedTagKey = (typeof ALLOWED_TAG_KEYS)[number];

export type PerfTags = Partial<{
  provider_id: string;
  model_id: string;
  transport: TransportKind;
  decision: DecisionKind;
  duration_ms: number;
  duration_ns: number;
  bytes: number;
  payload_bytes: number;
  count: number;
  input_tokens: number;
  output_tokens: number;
  turn_id: string;
  subagent_id: string;
  tool_id: string;
}>;

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_TAG_KEYS);

const TRANSPORT_VALUES: ReadonlySet<string> = new Set(["http_sse", "ws"]);

const DECISION_VALUES: ReadonlySet<string> = new Set(["allow", "deny"]);

/** Numeric tag keys — only finite numbers are kept. */
const NUMERIC_KEYS: ReadonlySet<AllowedTagKey> = new Set([
  "duration_ms",
  "duration_ns",
  "bytes",
  "payload_bytes",
  "count",
  "input_tokens",
  "output_tokens",
]);

/** Opaque-id / model-id keys: short, no path separators or whitespace. */
const ID_KEYS: ReadonlySet<AllowedTagKey> = new Set([
  "provider_id",
  "model_id",
  "turn_id",
  "subagent_id",
  "tool_id",
]);

// Caps free-form id length so a dumped prompt never sneaks in as a "model_id".
const MAX_ID_LENGTH = 64;

// Opaque ids / model ids: alphanumerics, dots, underscores, hyphens, colons, @.
// No spaces, slashes, backslashes, or control characters.
export const OPAQUE_ID_RE = /^[A-Za-z0-9._:@-]{1,64}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True for short opaque id strings (no paths, whitespace, or free text). */
export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && OPAQUE_ID_RE.test(value);
}

/**
 * Strip unknown keys and non-allowlisted values.
 * Never throws; returns a new object with only safe tags (or undefined if empty).
 */
export function sanitizeTags(tags: Record<string, unknown> | undefined | null): PerfTags | undefined {
  if (tags === undefined || tags === null) return undefined;

  const out: PerfTags = {};
  let kept = 0;

  for (const key of Object.keys(tags)) {
    if (!ALLOWED_KEY_SET.has(key)) continue;
    const allowedKey = key as AllowedTagKey;
    const value = tags[key];

    if (allowedKey === "transport") {
      if (typeof value === "string" && TRANSPORT_VALUES.has(value)) {
        out.transport = value as TransportKind;
        kept += 1;
      }
      continue;
    }

    if (allowedKey === "decision") {
      if (typeof value === "string" && DECISION_VALUES.has(value)) {
        out.decision = value as DecisionKind;
        kept += 1;
      }
      continue;
    }

    if (NUMERIC_KEYS.has(allowedKey)) {
      if (isFiniteNumber(value)) {
        (out as Record<string, number>)[allowedKey] = value;
        kept += 1;
      }
      continue;
    }

    if (ID_KEYS.has(allowedKey)) {
      if (isOpaqueId(value)) {
        (out as Record<string, string>)[allowedKey] = value;
        kept += 1;
      }
    }
  }

  return kept === 0 ? undefined : out;
}
