// Closed director package contract for the v1 fleet. Prompt-first: system
// prompt is the opinionated core; skills are optional.

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
  "qa-lead",
] as const;

export type DirectorId = (typeof DIRECTOR_IDS)[number];

export type TaskIntent =
  | "explore"
  | "implement"
  | "plan"
  | "review"
  | "general";

/**
 * Fleet authority tier, enforced at the tool-mount point in subagent/run.ts
 * and by subagent/authority.ts — never by prompt wording.
 *
 * - "orchestrator": Tier 1, primary (dispatch). Full fleet control.
 * - "nested-orchestrator": Tier 2, scoped to its own subtree — own
 *   descendants only, never siblings or ancestors.
 * - "leaf": Tier 3 worker. No fleet verbs at all.
 */
export type SubagentTier = "orchestrator" | "nested-orchestrator" | "leaf";

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
 * Optional structured output for a worker, additive alongside the markdown
 * envelope (Summary/Findings/Blockers/Paths, see subagent/report.ts):
 * declaring `outputSchema` lets a Tier 3 worker also submit a JSON payload
 * via `submit_result`, validated against this schema. Omit to stay on the
 * markdown-only path.
 */
export interface ReportContract {
  /** Shape of submit_result's payload, validated with arktype (see subagent/submit-result.ts). */
  readonly outputType?: OutputType;
}

/**
 * One shipped director: hard primary intent + package fields. Registry holds
 * the closed set.
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
   * Primary leaves this unset.
   */
  readonly attachedSkills?: readonly string[];
  /** Optional skill names (ordered). Loaded on demand via skill_search +
   * use_skill, scoped to attachedSkills ∪ optionalSkills. */
  readonly optionalSkills?: readonly string[];
  readonly tools?: ToolEnvelope;
  readonly spawn: SpawnRights;
  readonly nudge?: NudgePolicy;
  readonly modelRole: ModelRole;
  /** Fleet authority tier — data on the package, gated at mount, not prose. */
  readonly tier: SubagentTier;
  /** Optional typed output contract; Tier 3 leaves only. */
  readonly reportContract?: ReportContract;
}

export interface ResolveDirectorInput {
  readonly agentId?: string;
  readonly intent?: TaskIntent;
}

export type ResolveDirectorResult =
  | { readonly ok: true; readonly package: DirectorPackage }
  | { readonly ok: false; readonly error: string; readonly hint: string };
