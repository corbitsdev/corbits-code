import type { ReasoningEffort } from "../agent/profile-types.js";

// DeepSeek V4 effort translator shared by the adapter and the effort picker.
// V4 ships under several ids across two catalogs — deepseek-v4-pro/-flash/
// -flash-vision-exp — so the family is matched by prefix rather than an exact
// id list; the `^` anchor keeps hypothetical spaced/pre-V4 ids out. This shape
// mirrors the grok/kimi/muse-spark prefix predicates elsewhere in the tree.
export function isDeepSeekV4Model(model: string): boolean {
  return /^deepseek-v4/i.test(model.trim());
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
 * Translate a V4 effort to its raw wire value. `xhigh`/`max` pass through
 * verbatim; `none` maps to null — the caller drops `reasoning_effort` and
 * signals thinking off instead, because `reasoning_effort:"none"` is illegal
 * on the wire.
 */
export function mapV4Effort(effort: ReasoningEffort): "xhigh" | "max" | null {
  if (effort === "none") return null;
  return effort === "max" ? "max" : "xhigh";
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
