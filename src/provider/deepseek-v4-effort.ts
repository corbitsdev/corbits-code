import type { ReasoningEffort } from "../agent/profile-types.js";

// DeepSeek V4 effort translator shared by the adapter and the effort picker.
// V4 ships under several ids across two catalogs — deepseek-v4-pro/-flash/
// -flash-vision-exp — so the family is matched by prefix rather than an exact
// id list, mirroring the grok/kimi/muse-spark prefix predicates elsewhere.
export function isDeepSeekV4Model(model: string): boolean {
  return /^deepseek-v4/i.test(model.trim());
}

// The native V4 rungs. `none` is a toggle, never a wire effort; `xhigh`/`max`
// are the wire rungs sent raw (the API docs' low/high/max is the gateway
// normalization layer, not what the model/encoder honors).
export const DEEPSEEK_V4_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "xhigh",
  "max",
];

// Translate a V4 effort to its raw wire value: `none` maps to null (the caller
// drops `reasoning_effort`, since `reasoning_effort:"none"` is illegal on the
// wire), otherwise `xhigh`/`max` pass through verbatim.
export function mapV4Effort(effort: ReasoningEffort): "xhigh" | "max" | null {
  if (effort === "none") return null;
  return effort === "max" ? "max" : "xhigh";
}

// chat_template_kwargs thinking toggle for a V4 effort: off for `none`, on for
// any wire effort. The caller pairs the dropped reasoning_effort with
// `{thinking:false}` so the encoder still bypasses the reasoning pass.
export function v4Thinking(effort: ReasoningEffort): { thinking: boolean } {
  return { thinking: effort !== "none" };
}
