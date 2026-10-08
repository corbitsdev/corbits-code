// Provider-native request knob carried via
// InferenceSource.defaults.providerOptions.reasoning_effort: same model,
// different latency/cost vs reasoning depth, not a variant or separate model.

// Canonical literal set lives in the agent profile contract so schema and
// runtime cannot drift; re-exported for existing callers.
import { REASONING_EFFORTS as CANONICAL_EFFORTS } from "../agent/profile-types.js";
import {
  DEEPSEEK_V4_EFFORTS,
  isDeepSeekV4Model,
} from "./deepseek-v4-effort.js";

export const REASONING_EFFORTS = CANONICAL_EFFORTS;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * Validate/dedupe a provider-declared effort set against the canonical ladder.
 * [] for empty/absent input.
 */
export function normalizeProviderEfforts(
  raw: readonly string[] | undefined,
): ReasoningEffort[] {
  if (raw === undefined || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: ReasoningEffort[] = [];
  for (const level of REASONING_EFFORTS) {
    if (raw.includes(level) && !seen.has(level)) {
      seen.add(level);
      out.push(level);
    }
  }
  return out;
}

// Levels OpenAI reasoning models (gpt-5, o-series) accept; none/xhigh
// are gpt-5.1-family-only (see below).
const DEFAULT_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

// gpt-5.1 family adds `none` (disable reasoning) and `xhigh`; neither is
// universal; unknown models are not assumed to take them.
const FULL_EFFORT_MODELS: readonly string[] = [
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
];

// Codex backend models take low/medium/high/xhigh — no `minimal`, no `none`.
const CODEX_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

// gpt-5.6 family adds `max` and `ultra`; older Codex models do not support
// them.
const MAX_EFFORT_CODEX_MODELS: readonly string[] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

// Safe subset for unrecognized models: levels the broadest range of reasoning
// models accept.
const UNKNOWN_MODEL_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
];

// Muse Spark (Responses protocol) takes minimal–high — DEFAULT_EFFORTS without
// `none` (the gateway 400s `reasoning.effort: none`).
const MUSE_SPARK_EFFORTS: readonly ReasoningEffort[] = DEFAULT_EFFORTS;

// Prefix match, not an id list: the family ships under ids across two catalogs
// and nothing normalizes the model string first. Mirrors the grok/kimi checks
// in src/subagent/provider-family.ts.
function isMuseSparkModel(model: string): boolean {
  return /^muse-spark/i.test(model.trim());
}

// grok-4.6/4.7 accept xhigh (CODEX_EFFORTS); grok-4.5 and composer stay on
// the unknown-model subset.
const GROK_46_AND_47_EFFORTS: readonly ReasoningEffort[] = CODEX_EFFORTS;
const GROK_46_AND_47_MODELS: readonly string[] = ["grok-4.6", "grok-4.7"];

// GPT-6 Astra accepts low–max on both surfaces; not ultra (gpt-5.6
// Codex-only), minimal, or none.
const GPT6_ASTRA_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// GLM-5.3 always reasons: vendor ladder low/high/max (no medium, no none),
// default max. Flash shares the same text parameters.
const GLM_53_EFFORTS: readonly ReasoningEffort[] = ["low", "high", "max"];
const GLM_53_MODELS: readonly string[] = ["glm-5.3", "glm-5.3-flash"];

function isKnownOpenAIReasoningModel(model: string): boolean {
  return (
    model.startsWith("gpt-5") ||
    model.startsWith("gpt-6") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  );
}

// Per-model "does it reason" from the models.dev registry at startup (see
// model-capabilities); the rung sets above decide which levels. Absent from
// the registry = unknown, not non-reasoning.
let reasoningCapableByModel: Record<string, boolean> = {};

export function setModelReasoningCapabilities(
  map: Record<string, boolean>,
): void {
  reasoningCapableByModel = map;
}

export function modelReasoningCapability(model: string): boolean | undefined {
  return reasoningCapableByModel[model];
}

// Effort levels to offer. `reasoningCapable` defaults to the models.dev
// registry; false → no effort; unknown (offline, unlisted) → local heuristic.
export function supportedEfforts(
  model: string,
  reasoningCapable: boolean | undefined = modelReasoningCapability(model),
  isCodex = false,
  providerEfforts: readonly ReasoningEffort[] = [],
): ReasoningEffort[] {
  if (reasoningCapable === false) {
    return [];
  }
  // Operator-declared ladder (custom provider) overrides the family table
  // entirely.
  if (providerEfforts.length > 0) {
    return [...providerEfforts];
  }
  if (model === "gpt-6-astra") {
    return [...GPT6_ASTRA_EFFORTS];
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
  if (GROK_46_AND_47_MODELS.includes(model)) {
    return [...GROK_46_AND_47_EFFORTS];
  }
  if (GLM_53_MODELS.includes(model)) {
    return [...GLM_53_EFFORTS];
  }
  if (isDeepSeekV4Model(model)) {
    return [...DEEPSEEK_V4_EFFORTS];
  }
  if (isMuseSparkModel(model)) {
    return [...MUSE_SPARK_EFFORTS];
  }
  return [...UNKNOWN_MODEL_EFFORTS];
}

export function validateEffort(
  model: string,
  effort: ReasoningEffort,
  isCodex = false,
  providerEfforts: readonly ReasoningEffort[] = [],
): { ok: true } | { ok: false; error: string } {
  const supported = supportedEfforts(
    model,
    undefined,
    isCodex,
    providerEfforts,
  );
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
 * Next effort on the model's ladder (wraps around); undefined when the model
 * supports none. Current effort resolves via resolveSessionEffort (configured
 * when accepted, else family default), then advances one rung; unresolvable
 * starts at supported[0].
 */
export function cycleReasoningEffort(
  model: string,
  current: ReasoningEffort | undefined,
  isCodex = false,
  providerEfforts: readonly ReasoningEffort[] = [],
  providerDefault?: ReasoningEffort,
): ReasoningEffort | undefined {
  const supported = supportedEfforts(
    model,
    undefined,
    isCodex,
    providerEfforts,
  );
  if (supported.length === 0) return undefined;
  const implicit = resolveSessionEffort(
    model,
    current,
    isCodex,
    providerEfforts,
    providerDefault,
  );
  if (implicit === undefined || !supported.includes(implicit)) {
    return supported[0];
  }
  const idx = supported.indexOf(implicit);
  return supported[(idx + 1) % supported.length];
}

/**
 * Product default effort for a live session model — what the prompt shows and
 * Shift+Tab advances from. Distinct from role defaults.
 *
 * Unknown models stay undefined so we do not invent a family default.
 */
export function defaultEffortForModel(
  model: string,
  isCodex = false,
  providerEfforts: readonly ReasoningEffort[] = [],
  providerDefault?: ReasoningEffort,
): ReasoningEffort | undefined {
  const supported = supportedEfforts(
    model,
    undefined,
    isCodex,
    providerEfforts,
  );
  if (supported.length === 0) return undefined;
  const pick = (desired: ReasoningEffort): ReasoningEffort | undefined =>
    supported.includes(desired) ? desired : undefined;
  // Operator-declared default (custom provider) wins when on the operator's
  // ladder.
  if (providerEfforts.length > 0 && providerDefault !== undefined) {
    return pick(providerDefault);
  }
  if (model.startsWith("grok")) return pick("high");
  if (GLM_53_MODELS.includes(model)) return pick("max");
  if (isDeepSeekV4Model(model)) return pick("max");
  if (isMuseSparkModel(model)) return pick("low");
  if (!isCodex && supported.includes("none")) return "none";
  if (isCodex || isKnownOpenAIReasoningModel(model)) return pick("medium");
  return undefined;
}

/**
 * Effort the session is on: the configured level when accepted, else the
 * family default. Read-only; display and request wiring read it.
 */
export function resolveSessionEffort(
  model: string,
  configured: ReasoningEffort | undefined,
  isCodex = false,
  providerEfforts: readonly ReasoningEffort[] = [],
  providerDefault?: ReasoningEffort,
): ReasoningEffort | undefined {
  const supported = supportedEfforts(
    model,
    undefined,
    isCodex,
    providerEfforts,
  );
  if (supported.length === 0) return undefined;
  if (configured !== undefined && supported.includes(configured))
    return configured;
  return defaultEffortForModel(
    model,
    isCodex,
    providerEfforts,
    providerDefault,
  );
}

// ---------------------------------------------------------------------------
// Role-based product defaults
//
// Orchestrators plan and fan out work — higher effort is worth the latency.
// Leaves stay cheaper so fleets do not multiply a high cliff across children.
// Silent product default; a profile/task pin overrides it.
// ---------------------------------------------------------------------------

/** Product default effort by agent role (before model clamping). */
export const ROLE_DEFAULT_EFFORT = {
  orchestrator: "high",
  leaf: "medium",
} as const satisfies Record<"orchestrator" | "leaf", ReasoningEffort>;

/**
 * Nearest supported effort to `desired` by position on the canonical ladder;
 * undefined when `supported` is empty.
 */
export function clampEffort(
  desired: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(desired)) return desired;
  const desiredIdx = REASONING_EFFORTS.indexOf(desired);
  const first = supported[0];
  if (first === undefined) return undefined;
  let best: ReasoningEffort = first;
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
  /** True for built-in orchestrator directors (may call fleet tools). */
  orchestrator: boolean;
  /** Explicit profile inference leg or task-tier pin — highest precedence. */
  pin?: ReasoningEffort;
  /**
   * Package modelRole default: replaces the binary orchestrator/leaf default.
   */
  roleDefault?: ReasoningEffort;
  /** Parent session effort, used only when the role default is unsupported. */
  parentEffort?: ReasoningEffort;
  /** Marker when the parent effort was operator-chosen (see SubAgentProvider). */
  explicitParentEffort?: true;
  model: string;
  isCodex?: boolean;
  providerEfforts?: readonly ReasoningEffort[];
}

/**
 * Pure cascade behind `resolveEffortForRole`; exported so tests can pin the
 * precedence without per-model supported sets.
 *
 * Precedence (first match wins):
 * 1. Explicit pin (clamped onto supported when the pin is not in the set)
 * 2. Explicit parent effort (operator-chosen fleet pin) when present in
 *    `supported` — clamped onto the set when not (CL-10227)
 * 3. Role default when present in `supported`
 * 4. Parent effort when present in `supported`
 * 5. Clamp of role default onto `supported`
 * 6. undefined when `supported` is empty
 *
 * Pins are still highest precedence, but an unsupported pin is clamped so the
 * pure API owns the "never emit an unsupported effort" invariant (callers that
 * want hard-fail on bad pins should validateEffort first, as spawn_agent does).
 */
export function pickEffortFromCascade(opts: {
  pin?: ReasoningEffort;
  roleDefault: ReasoningEffort;
  parentEffort?: ReasoningEffort;
  explicitParentEffort?: true;
  supported: readonly ReasoningEffort[];
}): ReasoningEffort | undefined {
  if (opts.supported.length === 0) return undefined;
  if (opts.pin !== undefined) {
    return opts.supported.includes(opts.pin)
      ? opts.pin
      : clampEffort(opts.pin, opts.supported);
  }
  // An explicit (operator-chosen) parent effort is a fleet-wide pin: it beats
  // the role default so a primary cycled to none really gives none workers.
  if (opts.explicitParentEffort === true && opts.parentEffort !== undefined) {
    return opts.supported.includes(opts.parentEffort)
      ? opts.parentEffort
      : clampEffort(opts.parentEffort, opts.supported);
  }
  if (opts.supported.includes(opts.roleDefault)) return opts.roleDefault;
  if (
    opts.parentEffort !== undefined &&
    opts.supported.includes(opts.parentEffort)
  ) {
    return opts.parentEffort;
  }
  return clampEffort(opts.roleDefault, opts.supported);
}

/**
 * Resolve reasoning effort for a sub-agent spawn.
 *
 * Precedence: explicit pin > explicit parent (operator-chosen fleet pin) > role
 * default > derived parent > clamp. An explicit primary effort — including
 * `none`/off — is fleet-wide, so it beats both the leaf (medium) and the
 * orchestrator (high) role default. The unset parent case keeps CL-5162: the
 * role default outranks a derived parent so a /agent high selection on the
 * primary does not force every leaf onto high (which would multiply the
 * sol+high latency cliff across the fleet).
 */
export function resolveEffortForRole(
  opts: ResolveEffortForRoleOpts,
): ReasoningEffort | undefined {
  const supported = supportedEfforts(
    opts.model,
    undefined,
    opts.isCodex === true,
    opts.providerEfforts,
  );
  const roleDefault =
    opts.roleDefault ??
    (opts.orchestrator
      ? ROLE_DEFAULT_EFFORT.orchestrator
      : ROLE_DEFAULT_EFFORT.leaf);
  return pickEffortFromCascade({
    ...(opts.pin !== undefined ? { pin: opts.pin } : {}),
    roleDefault,
    ...(opts.parentEffort !== undefined
      ? { parentEffort: opts.parentEffort }
      : {}),
    ...(opts.explicitParentEffort === true
      ? { explicitParentEffort: true }
      : {}),
    supported,
  });
}
