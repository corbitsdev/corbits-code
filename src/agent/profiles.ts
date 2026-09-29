import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";

import { defaultAgentsPlugin as defaultPlugin } from "./default-agents.js";
import { isDirectorId } from "./directors/registry.js";
import { REASONING_EFFORTS } from "./profile-types.js";

export type {
  AgentProfile,
  CapabilityFilter,
  InferenceLeg,
  InferenceSpec,
  ReasoningEffort,
} from "./profile-types.js";
import type { AgentProfile } from "./profile-types.js";

// Exported so agent-kind plugins can validate contributed profiles.
export { AgentProfileSchema };

const CapabilityFilterSchema = type({
  mode: "'exclude' | 'allow'",
  tools: "string[]",
});

// Reasoning-effort schema derived from the canonical array. arktype's `type()`
// is statically typed for literal strings; a computed string requires a cast
// through `unknown`. The schema is exercised by src/plugins/data-only-agent
// and the runtime ReasoningEffort re-export, so drift is caught.
const reasoningEffortLiteral = REASONING_EFFORTS.map((e) => `'${e}'`).join(
  " | ",
);
const ReasoningEffortSchema = type(
  reasoningEffortLiteral as unknown as "'none'",
);

const InferenceLegSchema = type({
  provider: "string>0",
  model: "string>0",
  "reasoningEffort?": ReasoningEffortSchema,
});

const InferenceSpecSchema = type({
  "mode?": "'pin' | 'prefer'",
  order: InferenceLegSchema.array(),
});

const AgentProfileSchema = type({
  id: "string",
  "description?": "string",
  "inference?": InferenceSpecSchema,
  "capabilities?": CapabilityFilterSchema,
  "systemPromptRole?": "string",
  "systemPromptPath?": "string",
  "orchestrator?": "boolean",
});

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// Mutable registry seeded with the default plugin. Plugin-provided profiles
// are overridable: a profile with the same id loaded later (or from the local
// .agents/agents/ directory) replaces the earlier one — except closed
// DIRECTOR_IDS, which are reserved and skipped at load (CL-7015).
const registry: AgentProfile[] = [...defaultPlugin.agents];

// Load diagnostics: additive over loadAgentProfiles. `revision` stamps the
// profile snapshot a dispatch was verified against (agent-fleet records it on
// the session); `malformed` names local files that failed to load and why.
// A malformed file never blocks the load — it fails closed only when a
// dispatch's requires_tools preflight must verify against it (CL-9476).
export interface MalformedAgentProfile {
  path: string;
  reason: string;
}

export interface AgentProfileDiagnostics {
  revision: number;
  malformed: MalformedAgentProfile[];
}

let profileSnapshotRevision = 0;

/** Revision of the most recent profile snapshot load. */
export function currentProfileSnapshotRevision(): number {
  return profileSnapshotRevision;
}

// Merge a profile into a list: replace a same-id entry or append. Used to layer
// profiles by precedence (defaults < plugin < local).
function mergeProfileInto(list: AgentProfile[], profile: AgentProfile): void {
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) list[idx] = profile;
  else list.push(profile);
}

/** Skip profiles whose id collides with a closed director (no override/alias). */
function isReservedDirectorProfile(profile: AgentProfile): boolean {
  return isDirectorId(profile.id);
}

// Load and merge profiles from three sources, in ascending precedence:
//   1. The built-in default registry
//   2. `extraProfiles` — profiles contributed by enabled agent-kind plugins
//   3. JSON/YAML files in the local .agents/agents/ directory
// A profile with a duplicate id loaded from a higher-precedence source replaces
// the earlier one. Closed DIRECTOR_IDS are reserved: colliding plugin/local
// profiles are skipped so the fleet cannot be overridden or aliased.
export async function loadAgentProfiles(
  dir: string,
  extraProfiles: AgentProfile[] = [],
): Promise<AgentProfile[]> {
  return (await loadAgentProfilesWithDiagnostics(dir, extraProfiles)).profiles;
}

/**
 * loadAgentProfiles plus load diagnostics. Additive: profiles resolve
 * exactly as before; unreadable/unparseable/invalid local files are named in
 * `diagnostics.malformed` instead of skipped silently. Every call bumps the
 * snapshot revision a dispatch stamps on its session record.
 */
export async function loadAgentProfilesWithDiagnostics(
  dir: string,
  extraProfiles: AgentProfile[] = [],
): Promise<{ profiles: AgentProfile[]; diagnostics: AgentProfileDiagnostics }> {
  profileSnapshotRevision += 1;
  const revision = profileSnapshotRevision;
  const malformed: MalformedAgentProfile[] = [];
  const done = (
    profiles: AgentProfile[],
  ): { profiles: AgentProfile[]; diagnostics: AgentProfileDiagnostics } => ({
    profiles,
    diagnostics: { revision, malformed },
  });
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) {
      const merged = [...registry];
      for (const p of extraProfiles) {
        if (isReservedDirectorProfile(p)) continue;
        mergeProfileInto(merged, p);
      }
      return done(merged);
    }
    throw err;
  }

  const local: AgentProfile[] = [];
  for (const entry of entries) {
    // Accept .json, .yaml, and .yml for local agent configs.
    const isJSON = entry.endsWith(".json");
    const isYAML = entry.endsWith(".yaml") || entry.endsWith(".yml");
    if (!isJSON && !isYAML) continue;
    const filePath = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      malformed.push({ path: filePath, reason: "unreadable file" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = isJSON ? JSON.parse(raw) : Bun.YAML.parse(raw);
    } catch {
      malformed.push({
        path: filePath,
        reason: isJSON ? "invalid JSON" : "invalid YAML",
      });
      continue;
    }
    const result = AgentProfileSchema(parsed);
    if (result instanceof type.errors) {
      malformed.push({ path: filePath, reason: "schema validation failed" });
      continue;
    }
    const profile = result as AgentProfile;
    if (isReservedDirectorProfile(profile)) continue;
    // Resolve systemPromptPath relative to this directory. The file content
    // becomes systemPromptRole; an explicit systemPromptRole takes precedence.
    if (
      profile.systemPromptPath !== undefined &&
      profile.systemPromptRole === undefined
    ) {
      try {
        const promptRaw = await readFile(
          join(dir, profile.systemPromptPath),
          "utf8",
        );
        profile.systemPromptRole = promptRaw.trim();
      } catch {
        // Missing prompt file is non-fatal — the profile loads without a role.
      }
    }
    local.push(profile);
  }

  const merged = [...registry];
  for (const profile of extraProfiles) {
    if (isReservedDirectorProfile(profile)) continue;
    mergeProfileInto(merged, profile);
  }
  for (const profile of local) mergeProfileInto(merged, profile);
  return done(merged);
}
