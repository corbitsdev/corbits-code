// Closed director package contract for the v1 fleet (CL-5818).
// Prompt-first: system prompt is the opinionated core; skills are optional.

export const DIRECTOR_IDS = [
  "skywalker",
  "implement",
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
export type ModelRole = "orchestrator" | "implement" | "explore" | "review" | "plan" | "docs" | "test";

export type ToolEnvelope = {
  /** Tools mounted when present — prefer small allowlists over deny-everything. */
  readonly allow?: readonly string[];
  /** Tools denied even if present in the session registry. Prefer allow when possible. */
  readonly deny?: readonly string[];
};

export type SpawnRights = {
  /** Whether this director may call `task`. */
  readonly maySpawn: boolean;
  /** When set, only these director ids may be spawned. */
  readonly allowlist?: readonly DirectorId[];
};

export type NudgePolicy = {
  readonly maxTurns?: number;
  /** Stall silence budget in ms before a parent-facing stall notice. */
  readonly stallMs?: number;
};

export type ReportContract = {
  /** Required top-level sections in the leaf report. */
  readonly requiredSections: readonly string[];
};

/**
 * One shipped director: hard primary intent + package fields.
 * Packages land in later levels; registry holds the closed set.
 */
export type DirectorPackage = {
  readonly id: DirectorId;
  /** Hard primary intent lane — one job. */
  readonly primaryIntent: string;
  /** Explicit out-of-lane work this director must refuse or reclassify. */
  readonly outOfLane: readonly string[];
  readonly description: string;
  /** Opinionated core prompt (prompt-first). */
  readonly systemPrompt: string;
  /** Optional skills the leaf may load dynamically (ordered). */
  readonly optionalSkills?: readonly string[];
  readonly tools?: ToolEnvelope;
  /**
   * Authz write-path allowlist for write_file/edit_file/delete_file.
   * Enforced by the permission gate (not prompt policy). A bare filename (no
   * slash) matches only at the workspace root; a glob matches the resolved
   * workspace-relative path; anything outside the worker cwd is denied. yolo
   * mode bypasses this gate. Omitted = no path lock (tool allow/deny alone
   * decides whether writes exist).
   */
  readonly writePaths?: readonly string[];
  readonly spawn: SpawnRights;
  readonly nudge?: NudgePolicy;
  readonly report: ReportContract;
  readonly modelRole: ModelRole;
};

export type ResolveDirectorInput = {
  readonly agentId?: string;
  readonly intent?: TaskIntent;
};

export type ResolveDirectorResult =
  | { readonly ok: true; readonly package: DirectorPackage }
  | { readonly ok: false; readonly error: string; readonly hint: string };
