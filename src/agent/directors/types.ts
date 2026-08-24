// Closed director package contract for the v1 fleet (CL-5818).
// Prompt-first: system prompt is the opinionated core; skills are optional.

export const DIRECTOR_IDS = [
  "skywalker",
  "build",
  "explore",
  "plan",
  "intern",
  "critique",
  "greybeard",
  "neckbeard",
  "bruckheimer",
  "gaasbot",
  "draper",
  "emil",
  "brand-reviewer",
  "shakespeare",
  "testsmith",
  "tester",
] as const;

export type DirectorId = (typeof DIRECTOR_IDS)[number];

export type TaskIntent = "explore" | "implement" | "plan" | "review" | "general";

/** Static model-role tag for CL-5816 stub resolution (not a full package yet). */
export type ModelRole =
  "orchestrator" | "implement" | "explore" | "review" | "plan" | "docs" | "test";

export interface ToolEnvelope {
  /** Tools mounted when present — prefer small allowlists over deny-everything. */
  readonly allow?: readonly string[];
  /** Tools denied even if present in the session registry. Prefer allow when possible. */
  readonly deny?: readonly string[];
}

export interface SpawnRights {
  /** Whether this director may call `task`. */
  readonly maySpawn: boolean;
  /** When set, only these director ids may be spawned. */
  readonly allowlist?: readonly DirectorId[];
}

export interface NudgePolicy {
  readonly maxTurns?: number;
  /** Stall silence budget in ms before a parent-facing stall notice. */
  readonly stallMs?: number;
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
  /** Optional skills the worker may load dynamically (ordered). */
  readonly optionalSkills?: readonly string[];
  readonly tools?: ToolEnvelope;
  readonly spawn: SpawnRights;
  readonly nudge?: NudgePolicy;
  readonly modelRole: ModelRole;
}

export interface ResolveDirectorInput {
  readonly agentId?: string;
  readonly intent?: TaskIntent;
}

export type ResolveDirectorResult =
  | { readonly ok: true; readonly package: DirectorPackage }
  | { readonly ok: false; readonly error: string; readonly hint: string };
