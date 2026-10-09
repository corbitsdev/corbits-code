import type { ReasoningEffort } from "../agent/profile-types.js";

// DeepSeek V4 effort translator shared by the adapter and the effort picker.
// V4 ships under several ids across two catalogs — deepseek-v4-pro/-flash/
// -flash-vision-exp — and under a vendor-qualified host id like
// deepseek-ai/DeepSeek-V4-Flash-0731. Match the `deepseek-v4` segment at the
// start or after a `/`, so both bare and qualified ids resolve while pre-V4
// ids (deepseek-coder, deepseek-chat) do not. This mirrors the grok/kimi/astra
// leaf predicates, which also accept an org-qualified segment.
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
 * `reasoning_effort:"none"` is illegal on the wire). Off-ladder values return
 * undefined — the caller leaves `reasoning_effort` untouched rather than
 * coercing it onto a V4 rung.
 */
export function mapV4Effort(
  effort: ReasoningEffort,
): "xhigh" | "max" | null | undefined {
  if (effort === "none") return null;
  return effort === "xhigh" || effort === "max" ? effort : undefined;
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
