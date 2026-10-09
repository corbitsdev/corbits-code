import type { ReasoningEffort } from "../agent/profile-types.js";
import type { DirectorId } from "../agent/directors/types.js";

/**
 * Per-role V4 effort defaults. dispatch/planner/reviewer dispatch and judge —
 * max. coder defaults to max (operator-confirmed). Every other leaf reasons at
 * xhigh.
 */
export const DEEPSEEK_V4_ROLE_EFFORT: Record<DirectorId, ReasoningEffort> = {
  dispatch: "max",
  planner: "max",
  reviewer: "max",
  coder: "max",
  explorer: "xhigh",
  artist: "xhigh",
  "qa-lead": "xhigh",
  prober: "xhigh",
  designer: "xhigh",
  shakespeare: "xhigh",
  warden: "xhigh",
};

// DeepSeek family predicate shared by the adapter router and the family policy.
// The family ships under several ids across two catalogs — deepseek-v4-pro/
// -flash/-flash-vision-exp and deepseek-chat/deepseek-coder/deepseek-v3 — and
// under a vendor-qualified host id like deepseek-ai/DeepSeek-V4-Flash-0731.
// Match the `deepseek` segment at the start or after a `/`, so both bare and
// qualified ids resolve across the whole family (including future versions).
// This mirrors the grok/kimi/astra leaf predicates, which also accept an
// org-qualified segment.
export function isDeepSeekModel(model: string): boolean {
  return /(^|\/)deepseek/i.test(model.trim());
}

// V4-variant detection: distinguishes the V4 model line from pre-V4 DeepSeek
// (deepseek-chat, deepseek-coder, deepseek-v3). Only where the wire semantics
// genuinely differ between V4 and pre-V4 deepseek — the V4 adapter's model-card
// and effort quirks, the reasoning_content keep-vs-strip behavior, and the
// none/xhigh/max effort ladder — do callers gate on this variant predicate.
export function isDeepSeekV4Model(model: string): boolean {
  return /(^|\/)deepseek-v4/i.test(model.trim());
}

// The operator-confirmed native V4 rungs. `none` is a toggle, never a wire
// effort; `xhigh`/`max` are the wire rungs sent raw (the API docs' low/high/max
// is the gateway normalization layer, not what the model/encoder honors).
export const DEEPSEEK_V4_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "xhigh",
  "max",
];

/**
 * Translate a V4 effort to its raw wire value: `xhigh`/`max` pass through
 * verbatim, `none` maps to null (the caller drops `reasoning_effort`, since
 * `reasoning_effort:"none"` is illegal on the wire). The V4 ladder is strictly
 * none/xhigh/max: any off-ladder effort arriving on a manual/exec/config path
 * is rejected with a clear error rather than coerced or passed through, so no
 * off-ladder value can reach the wire for a V4 model.
 */
export function mapV4Effort(effort: ReasoningEffort): "xhigh" | "max" | null {
  if (effort === "none") return null;
  if (effort === "xhigh" || effort === "max") return effort;
  throw new Error(
    `DeepSeek V4 does not support reasoning effort "${effort}" (supported: none, xhigh, max).`,
  );
}

/**
 * chat_template_kwargs toggle for a V4 effort: thinking off for `none`,
 * thinking on for any wire effort. When the caller drops `reasoning_effort`
 * for `none` it supplies `{thinking:false}` so the encoder still knows to
 * bypass the reasoning pass.
 */
export function v4Thinking(effort: ReasoningEffort): { thinking: boolean } {
  return { thinking: effort !== "none" };
}

// Operator-confirmed V4 agentic model-card defaults: BOTH temperature 1.0 and
// top_p 0.95 (deliberate bypass of their temperature/topP mutual-exclusion).
// Absent-field-only — provider-set values always win.
export const DEEPSEEK_V4_MODEL_CARD = {
  temperature: 1.0,
  topP: 0.95,
} as const;

// Ask every V4 stream for per-chunk usage so vendor usage accounting can read
// it (`vendor/intx-inference/.../openai.ts` only emits inference.usage when the
// chunk carries it). Hoisted so the adapter reuses one object per build.
export const V4_STREAM_OPTIONS = {
  stream_options: { include_usage: true },
} as const;
