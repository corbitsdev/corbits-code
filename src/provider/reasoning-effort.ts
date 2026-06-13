// OpenAI reasoning-effort is a provider-native request knob carried through
// InferenceSource.defaults.providerOptions.reasoning_effort. It is not a
// "variant" or a separate model — the same model accepts an effort level that
// trades latency and cost against reasoning depth.

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

// The effort levels every OpenAI reasoning model accepts. `none` is always
// available because it means "no override" rather than a request value.
const DEFAULT_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

// Models that additionally accept the `xhigh` level. Listed explicitly because
// xhigh is not universally supported; an unknown model must not be assumed to
// take it.
const XHIGH_MODELS: readonly string[] = ["gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max"];

// The safe subset offered for models we do not recognize. Conservative on
// purpose: these are the levels the broadest range of reasoning models accept.
const UNKNOWN_MODEL_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

function isKnownOpenAIReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
}

export function supportedEfforts(model: string): ReasoningEffort[] {
  if (XHIGH_MODELS.includes(model)) {
    return [...DEFAULT_EFFORTS, "xhigh"];
  }
  if (isKnownOpenAIReasoningModel(model)) {
    return [...DEFAULT_EFFORTS];
  }
  return [...UNKNOWN_MODEL_EFFORTS];
}

export function validateEffort(
  model: string,
  effort: ReasoningEffort,
): { ok: true } | { ok: false; error: string } {
  const supported = supportedEfforts(model);
  if (supported.includes(effort)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Model "${model}" does not support reasoning effort "${effort}" (supported: ${supported.join(", ")}).`,
  };
}
