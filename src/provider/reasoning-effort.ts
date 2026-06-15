// OpenAI reasoning-effort is a provider-native request knob carried through
// InferenceSource.defaults.providerOptions.reasoning_effort. It is not a
// "variant" or a separate model — the same model accepts an effort level that
// trades latency and cost against reasoning depth.

// The selectable effort levels — all real request values the model is asked to
// honor. `none` is OpenAI's value for disabling reasoning (gpt-5.1+), distinct
// from "no override": no override means the field is omitted and the model's own
// default applies, while `none` actively turns reasoning off. "No override" is
// represented as the absence of a value (undefined), not a member here.
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

// The effort levels common OpenAI reasoning models (gpt-5, o-series) accept.
// `none` and `xhigh` are not here — they are gpt-5.1-family-only (see below).
const DEFAULT_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

// The gpt-5.1 family additionally accepts `none` (disable reasoning) and `xhigh`.
// Listed explicitly because neither is universally supported; an unknown model
// must not be assumed to take them.
const FULL_EFFORT_MODELS: readonly string[] = ["gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max"];

// Codex backend models take low/medium/high/xhigh — no `minimal`, no `none`.
const CODEX_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

// The safe subset offered for models we do not recognize. Conservative on
// purpose: these are the levels the broadest range of reasoning models accept.
const UNKNOWN_MODEL_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

function isKnownOpenAIReasoningModel(model: string): boolean {
  return model.startsWith("gpt-5") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
}

// Per-model reasoning capability sourced from models.dev (populated at startup,
// see model-capabilities). The registry is the authority on "does this model
// reason at all"; the rung sets above are the local authority on "which levels".
// A model absent from the registry is unknown, not non-reasoning.
let reasoningCapableByModel: Record<string, boolean> = {};

export function setModelReasoningCapabilities(map: Record<string, boolean>): void {
  reasoningCapableByModel = map;
}

export function modelReasoningCapability(model: string): boolean | undefined {
  return reasoningCapableByModel[model];
}

// The effort levels to offer for a model. `reasoningCapable` defaults to the
// models.dev-backed registry: when it positively reports a model does not
// reason, no effort is offered; when it is unknown (offline, first run, or a
// model models.dev does not list) the local heuristic decides.
export function supportedEfforts(
  model: string,
  reasoningCapable: boolean | undefined = modelReasoningCapability(model),
  isCodex = false,
): ReasoningEffort[] {
  if (reasoningCapable === false) {
    return [];
  }
  if (isCodex) {
    return [...CODEX_EFFORTS];
  }
  if (FULL_EFFORT_MODELS.includes(model)) {
    return ["none", ...DEFAULT_EFFORTS, "xhigh"];
  }
  if (isKnownOpenAIReasoningModel(model)) {
    return [...DEFAULT_EFFORTS];
  }
  return [...UNKNOWN_MODEL_EFFORTS];
}

export function validateEffort(
  model: string,
  effort: ReasoningEffort,
  isCodex = false,
): { ok: true } | { ok: false; error: string } {
  const supported = supportedEfforts(model, undefined, isCodex);
  if (supported.includes(effort)) {
    return { ok: true };
  }
  if (supported.length === 0) {
    return { ok: false, error: `Model "${model}" does not support reasoning, so it cannot take a reasoning effort.` };
  }
  return {
    ok: false,
    error: `Model "${model}" does not support reasoning effort "${effort}" (supported: ${supported.join(", ")}).`,
  };
}
