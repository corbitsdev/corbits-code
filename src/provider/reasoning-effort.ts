// OpenAI reasoning-effort is a provider-native request knob carried through
// InferenceSource.defaults.providerOptions.reasoning_effort. It is not a
// "variant" or a separate model — the same model accepts an effort level that
// trades latency and cost against reasoning depth.

// The canonical literal set lives in the agent profile contract so the
// profile schema and the runtime cannot drift. Re-exported here for callers
// that already import from this module.
import { REASONING_EFFORTS as CANONICAL_EFFORTS } from "../agent/profile-types.js";

export const REASONING_EFFORTS = CANONICAL_EFFORTS;
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

// The gpt-5.6 family additionally accepts `max` and `ultra`. Listed explicitly,
// mirroring FULL_EFFORT_MODELS above, because older Codex models (gpt-5.5,
// gpt-5.4, gpt-5.4-mini) are not known to support these levels.
const MAX_EFFORT_CODEX_MODELS: readonly string[] = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

// The safe subset offered for models we do not recognize. Conservative on
// purpose: these are the levels the broadest range of reasoning models accept.
const UNKNOWN_MODEL_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

// grok-4.6 accepts xhigh; grok-4.5 and composer stay on the unknown-model subset.
const GROK_46_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const GROK_46_MODELS: readonly string[] = ["grok-4.6"];

function isKnownOpenAIReasoningModel(model: string): boolean {
  return (
    model.startsWith("gpt-5") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  );
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
    return MAX_EFFORT_CODEX_MODELS.includes(model)
      ? [...CODEX_EFFORTS, "max", "ultra"]
      : [...CODEX_EFFORTS];
  }
  if (FULL_EFFORT_MODELS.includes(model)) {
    return ["none", ...DEFAULT_EFFORTS, "xhigh"];
  }
  if (isKnownOpenAIReasoningModel(model)) {
    return [...DEFAULT_EFFORTS];
  }
  if (GROK_46_MODELS.includes(model)) {
    return [...GROK_46_EFFORTS];
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
    return {
      ok: false,
      error: `Model "${model}" does not support reasoning, so it cannot take a reasoning effort.`,
    };
  }
  return {
    ok: false,
    error: `Model "${model}" does not support reasoning effort "${effort}" (supported: ${supported.join(", ")}).`,
  };
}

/**
 * Next effort on the model's supported ladder (wraps around). Returns undefined
 * when the model supports no reasoning effort — callers flash a status and leave
 * the session config alone.
 *
 * Walks from resolveSessionEffort: unset and leftover unsupported current sit
 * on the family default, then the next rung. When there is no family default
 * but the ladder is non-empty, start at supported[0].
 */
export function cycleReasoningEffort(
  model: string,
  current: ReasoningEffort | undefined,
  isCodex = false,
): ReasoningEffort | undefined {
  const supported = supportedEfforts(model, undefined, isCodex);
  if (supported.length === 0) return undefined;
  const implicit = resolveSessionEffort(model, current, isCodex);
  if (implicit === undefined || !supported.includes(implicit)) {
    return supported[0];
  }
  const idx = supported.indexOf(implicit);
  return supported[(idx + 1) % supported.length];
}

/**
 * Product default effort for a live session model. Distinct from role defaults
 * (`defaultEffortForDirector`): this is what the prompt shows and what Shift+Tab
 * advances from when the operator has not picked a level.
 *
 * Family table: grok* → high; Codex → medium; gpt-5.1 chat (`none` on the
 * ladder, not Codex) → none; gpt-5/o1/o3/o4 → medium. Unknown models with a
 * conservative rung set stay undefined so we do not invent a family default.
 */
export function defaultEffortForModel(model: string, isCodex = false): ReasoningEffort | undefined {
  const supported = supportedEfforts(model, undefined, isCodex);
  if (supported.length === 0) return undefined;
  const pick = (desired: ReasoningEffort): ReasoningEffort | undefined =>
    supported.includes(desired) ? desired : undefined;
  if (model.startsWith("grok")) return pick("high");
  if (!isCodex && supported.includes("none")) return "none";
  if (isCodex || isKnownOpenAIReasoningModel(model)) return pick("medium");
  return undefined;
}

/**
 * Effort the session is currently on: a configured level when the model accepts
 * it, otherwise the family default. Empty ladders stay undefined. Does not
 * write back into session config — display and request wiring read this.
 */
export function resolveSessionEffort(
  model: string,
  configured: ReasoningEffort | undefined,
  isCodex = false,
): ReasoningEffort | undefined {
  const supported = supportedEfforts(model, undefined, isCodex);
  if (supported.length === 0) return undefined;
  if (configured !== undefined && supported.includes(configured)) return configured;
  return defaultEffortForModel(model, isCodex);
}

// ---------------------------------------------------------------------------
// Role-based product defaults (CL-5162)
//
// Orchestrators plan and fan out work — higher effort is worth the latency.
// Task leaves should stay cheaper/faster so multi-agent fleets do not multiply
// a sol+high cliff across every child. No operator UI: this is the silent
// product default until a profile/task pin says otherwise.
// ---------------------------------------------------------------------------

/** Product default effort by agent role (before model clamping). */
export const ROLE_DEFAULT_EFFORT = {
  orchestrator: "high",
  leaf: "medium",
} as const satisfies Record<"orchestrator" | "leaf", ReasoningEffort>;

/**
 * Nearest supported effort to `desired` by position on the canonical ladder.
 * Returns undefined only when `supported` is empty.
 */
export function clampEffort(
  desired: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(desired)) return desired;
  const desiredIdx = REASONING_EFFORTS.indexOf(desired);
  let best: ReasoningEffort = supported[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const level of supported) {
    const dist = Math.abs(REASONING_EFFORTS.indexOf(level) - desiredIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = level;
    }
  }
  return best;
}

export interface ResolveEffortForRoleOpts {
  /** True when the spawn is a built-in orchestrator director (may call fleet tools). */
  orchestrator: boolean;
  /** Explicit profile inference leg or task-tier pin — highest precedence. */
  pin?: ReasoningEffort;
  /**
   * Package modelRole default (CL-5816). When set, replaces the binary
   * orchestrator/leaf default so intern can be low while implement stays medium.
   */
  roleDefault?: ReasoningEffort;
  /** Parent session effort — used only when the role default is not supported. */
  parentEffort?: ReasoningEffort;
  model: string;
  isCodex?: boolean;
}

/**
 * Pure cascade used by `resolveEffortForRole`. Exported for unit tests of the
 * precedence table without depending on per-model supported sets.
 *
 * Precedence (first match wins):
 * 1. Explicit pin (clamped onto supported when the pin is not in the set)
 * 2. Role default when present in `supported`
 * 3. Parent effort when present in `supported`
 * 4. Clamp of role default onto `supported`
 * 5. undefined when `supported` is empty
 *
 * Pins are still highest precedence, but an unsupported pin is clamped so the
 * pure API owns the "never emit an unsupported effort" invariant (callers that
 * want hard-fail on bad pins should validateEffort first, as task-tool does).
 */
export function pickEffortFromCascade(opts: {
  pin?: ReasoningEffort;
  roleDefault: ReasoningEffort;
  parentEffort?: ReasoningEffort;
  supported: readonly ReasoningEffort[];
}): ReasoningEffort | undefined {
  if (opts.supported.length === 0) return undefined;
  if (opts.pin !== undefined) {
    return opts.supported.includes(opts.pin) ? opts.pin : clampEffort(opts.pin, opts.supported);
  }
  if (opts.supported.includes(opts.roleDefault)) return opts.roleDefault;
  if (opts.parentEffort !== undefined && opts.supported.includes(opts.parentEffort)) {
    return opts.parentEffort;
  }
  return clampEffort(opts.roleDefault, opts.supported);
}

/**
 * Resolve reasoning effort for a sub-agent spawn.
 *
 * Why parent is below role default: a /agent high selection on the primary must
 * not force every leaf onto high — that multiplies the sol+high latency cliff
 * across the fleet. Parent still fills gaps when the role default is not in the
 * model's supported set but the parent effort is.
 */
export function resolveEffortForRole(opts: ResolveEffortForRoleOpts): ReasoningEffort | undefined {
  const supported = supportedEfforts(opts.model, undefined, opts.isCodex === true);
  const roleDefault =
    opts.roleDefault ??
    (opts.orchestrator ? ROLE_DEFAULT_EFFORT.orchestrator : ROLE_DEFAULT_EFFORT.leaf);
  return pickEffortFromCascade({
    ...(opts.pin !== undefined ? { pin: opts.pin } : {}),
    roleDefault,
    ...(opts.parentEffort !== undefined ? { parentEffort: opts.parentEffort } : {}),
    supported,
  });
}
