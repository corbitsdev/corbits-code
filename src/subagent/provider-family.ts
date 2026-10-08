import { GROK_RESPONSES_PROVIDER } from "../provider/grok-responses.js";
import { isXaiProviderName } from "../config/xai-providers.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { isDeepSeekModel } from "../provider/deepseek-v4-effort.js";

/** True when the leaf inference path is xAI / Grok. For small prompt
 * residuals only. */
export function isXaiGrokLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  const name = input.providerName.toLowerCase();
  if (isXaiProviderName(name)) return true;
  if (name === GROK_RESPONSES_PROVIDER || name.includes("grok")) return true;
  if (input.model !== undefined && /^grok/i.test(input.model.trim()))
    return true;
  return false;
}

/** True when the provider/model is Moonshot's Kimi family. */
export function isKimiLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  const name = input.providerName.toLowerCase();
  if (name.includes("moonshot") || name.includes("kimi")) return true;
  if (input.model !== undefined && /^(moonshot|kimi)/i.test(input.model.trim()))
    return true;
  return false;
}

/** True when the provider/model is the OpenCode Go Muse Spark family. */
export function isMuseSparkLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  return input.model !== undefined && /^muse-spark/i.test(input.model.trim());
}

/** True when the provider/model is Anthropic's Claude family. */
export function isClaudeLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  const name = input.providerName.toLowerCase();
  if (name.includes("anthropic") || name.includes("claude")) return true;
  if (input.model !== undefined && /^claude/i.test(input.model.trim()))
    return true;
  return false;
}

/**
 * True when the model id is the served gpt-6-astra cell. Forensics showed it
 * doom-looping on trivial argument deltas, so it gets its own family with an
 * evasion-specific residual; other served cells keep the generic gpt match.
 */
export function isAstraLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  return input.model !== undefined && /^gpt-6-astra/i.test(input.model.trim());
}

/**
 * True when the model is the DeepSeek family. Single-sourced from the shared
 * effort module (isDeepSeekModel, /(^|\/)deepseek/i) so the adapter family,
 * effort routing, and model-family key stay consistent.
 */
export function isDeepSeekLeafProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  return input.model !== undefined && isDeepSeekModel(input.model);
}

/**
 * True when the inference path is the GPT family: a Codex provider name
 * (codex/ OAuth profiles, the codex-responses adapter, bare codex) or a
 * gpt-* model id on any provider. Served codex cells (sol/terra/luna) match
 * the generic gpt-* shape — never name them here.
 */
export function isGptProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  const name = input.providerName.toLowerCase();
  if (isCodexProviderName(name) || name === "codex" || name.includes("codex"))
    return true;
  if (input.model !== undefined && /^gpt-/i.test(input.model.trim()))
    return true;
  return false;
}

/** Model families the shared directors branch on via ModelFamilyPolicy. */
export type ModelFamily =
  | "grok"
  | "kimi"
  | "muse"
  | "claude"
  | "gpt"
  | "astra"
  | "deepseek"
  | "default";

/**
 * Resolve a provider/model to a ModelFamily for ModelFamilyPolicy. Directors
 * consume the resolved family/policy, never these provider checks directly.
 */
export function detectModelFamily(input: {
  providerName: string;
  model?: string;
}): ModelFamily {
  if (isXaiGrokLeafProvider(input)) return "grok";
  if (isKimiLeafProvider(input)) return "kimi";
  if (isMuseSparkLeafProvider(input)) return "muse";
  if (isClaudeLeafProvider(input)) return "claude";
  if (isAstraLeafProvider(input)) return "astra";
  if (isDeepSeekLeafProvider(input)) return "deepseek";
  if (isGptProvider(input)) return "gpt";
  return "default";
}

/**
 * The finish-bias residual only fits leaf workers: telling an orchestrator to
 * "stop calling tools and write the report" would cut off dispatching.
 */
export function shouldApplyGrokAntiThrash(input: {
  providerName: string;
  model?: string;
  orchestrator: boolean;
}): boolean {
  return !input.orchestrator && isXaiGrokLeafProvider(input);
}
