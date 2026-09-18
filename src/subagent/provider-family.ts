import { GROK_RESPONSES_PROVIDER } from "../provider/grok-responses.js";
import { isXaiProviderName } from "../config/xai-providers.js";
import { isCodexProviderName } from "../config/codex-providers.js";

/**
 * True when the leaf inference path is xAI / Grok family.
 * Used only for tiny provider-specific prompt residuals — not for routing.
 */
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
 * True when the inference path is the GPT family: a Codex provider name
 * (codex/ OAuth profiles, the codex-responses adapter, bare codex) or a
 * gpt-* model id on any provider. Served codex cells (astra/sol/terra/luna)
 * all match the generic gpt-* model shape — never name them here; CL-8265
 * characterizes cells later.
 */
export function isGptProvider(input: {
  providerName: string;
  model?: string;
}): boolean {
  const name = input.providerName.toLowerCase();
  if (
    isCodexProviderName(name) ||
    name === "codex" ||
    name.includes("codex")
  )
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
  | "default";

/**
 * Resolves a provider/model to a ModelFamily. Generalizes
 * isXaiGrokLeafProvider / isKimiLeafProvider into one lookup for
 * ModelFamilyPolicy — directors consume the resolved family/policy, never
 * these provider checks directly.
 */
export function detectModelFamily(input: {
  providerName: string;
  model?: string;
}): ModelFamily {
  if (isXaiGrokLeafProvider(input)) return "grok";
  if (isKimiLeafProvider(input)) return "kimi";
  if (isMuseSparkLeafProvider(input)) return "muse";
  if (isClaudeLeafProvider(input)) return "claude";
  if (isGptProvider(input)) return "gpt";
  return "default";
}

/**
 * The finish-bias residual only makes sense on leaf workers: orchestrators
 * dispatch other agents rather than doing the work directly, so telling one
 * to "stop calling tools and write the report" would cut off dispatching.
 */
export function shouldApplyGrokAntiThrash(input: {
  providerName: string;
  model?: string;
  orchestrator: boolean;
}): boolean {
  return !input.orchestrator && isXaiGrokLeafProvider(input);
}
