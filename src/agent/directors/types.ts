// Closed director package contract for the v1 fleet (CL-5818).
// Prompt-first: system prompt is the opinionated core; skills are optional.

import type { OutputType } from "../../subagent/submit-result.js";

export const DIRECTOR_IDS = [
  "dispatch",
  "explorer",
  "planner",
  "coder",
  "reviewer",
  "designer",
  "artist",
  "warden",
  "shakespeare",
  "prober",
] as const;

export type DirectorId = (typeof DIRECTOR_IDS)[number];

export type TaskIntent =
  | "explore"
  | "implement"
  | "plan"
  | "review"
  | "general";

/**
 * Fleet authority (runtime-enforced at the tool-mount point).
 *
 * Dispatch is the only orchestrator. Everyone else is a specialist worker.
 * There is no nested orchestrator and no "leaf" role.
 */
export type SubagentTier = "orchestrator" | "worker";

/** Static model-role tag used by resolveEffortForRole / defaultEffortForDirector. */
export type ModelRole =
  | "orchestrator"
  | "implement"
  | "explore"
  | "review"
  | "plan"
  | "docs"
  | "test";

export interface ToolEnvelope {
  /** Tools mounted when present — prefer small allowlists over deny-everything. */
  readonly allow?: readonly string[];
  /** Tools denied even if present in the session registry. Prefer allow when possible. */
  readonly deny?: readonly string[];
}

export interface SpawnRights {
  /** Whether this director may call fleet delegation tools. */
  readonly maySpawn: boolean;
  /** When set, only these director ids may be spawned. */
  readonly allowlist?: readonly DirectorId[];
}

export interface NudgePolicy {
  /** Stall silence budget in ms before a parent-facing stall notice. */
  readonly stallMs?: number;
}

/**
 * Optional structured-output contract for a director's worker (CL-6946).
 * Additive alongside the markdown envelope (Summary/Findings/Blockers/Paths,
 * see subagent/report.ts) — declaring `outputSchema` lets a Tier 3 worker also
 * submit a JSON payload via `submit_result`, validated against this schema.
 * Omit entirely to keep a director on the markdown-only path.
 */
export interface ReportContract {
  /** Shape of submit_result's payload, validated with arktype (see subagent/submit-result.ts). */
  readonly outputType?: OutputType;
}

/**
 * One shipped director: hard primary intent + package fields.
 * Packages land in later levels; registry holds the closed set.
 */
export interface DirectorPackage {
  readonly id: DirectorId;
  /** Hard primary intent lane — one job. */
  readonly primaryIntent: string;
  /** Explicit out-of-lane work this director must refuse or reclassify. */
  readonly outOfLane: readonly string[];
  readonly description: string;
  /** Opinionated core prompt (prompt-first). */
  readonly systemPrompt: string;
  /**
   * Skill names whose bodies are injected once into the worker system prompt
   * at spawn (zero extra turn). Do not duplicate these names in optionalSkills.
   * Dispatch/primary leaves this unset.
   */
  readonly attachedSkills?: readonly string[];
  /** Optional skill names (ordered). Workers load matching bodies on demand with skill_search + use_skill, scoped to the union of attachedSkills and optionalSkills; the primary orchestrator keeps them use_skill-loadable. */
  readonly optionalSkills?: readonly string[];
  readonly tools?: ToolEnvelope;
  readonly spawn: SpawnRights;
  readonly nudge?: NudgePolicy;
  readonly modelRole: ModelRole;
  /** Fleet authority tier — data on the package, gated at mount, not prose. */
  readonly tier: SubagentTier;
  /** Optional typed output contract (CL-6946); Tier 3 leaves only. */
  readonly reportContract?: ReportContract;
}

export interface ResolveDirectorInput {
  readonly agentId?: string;
  readonly intent?: TaskIntent;
}

export type ResolveDirectorResult =
  | { readonly ok: true; readonly package: DirectorPackage }
  | { readonly ok: false; readonly error: string; readonly hint: string };
