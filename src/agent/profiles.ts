import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";

import { defaultAgentsPlugin as defaultPlugin } from "./default-agents.js";
import { REASONING_EFFORTS } from "./profile-types.js";

export type {
  AgentProfile,
  AgentPlugin,
  CapabilityFilter,
  CapabilityMode,
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
// through `unknown`. The schema is exercised by tests/unit/data-only-agent
// and the runtime ReasoningEffort re-export, so drift is caught.
const reasoningEffortLiteral = REASONING_EFFORTS.map((e) => `'${e}'`).join(" | ");
const ReasoningEffortSchema = type(reasoningEffortLiteral as unknown as "'none'");

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
  "maxTurns?": "number",
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
// .agents/agents/ directory) replaces the earlier one.
const registry: AgentProfile[] = [...defaultPlugin.agents];

// Merge a profile into a list: replace a same-id entry or append. Used to layer
// profiles by precedence (defaults < plugin < local).
function mergeProfileInto(list: AgentProfile[], profile: AgentProfile): void {
  const idx = list.findIndex((p) => p.id === profile.id);
  if (idx >= 0) list[idx] = profile;
  else list.push(profile);
}

// Load and merge profiles from three sources, in ascending precedence:
//   1. The built-in default registry
//   2. `extraProfiles` — profiles contributed by enabled agent-kind plugins
//   3. JSON/YAML files in the local .agents/agents/ directory
// A profile with a duplicate id loaded from a higher-precedence source replaces
// the earlier one.
export async function loadAgentProfiles(
  dir: string,
  extraProfiles: AgentProfile[] = [],
): Promise<AgentProfile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) {
      const merged = [...registry];
      for (const p of extraProfiles) mergeProfileInto(merged, p);
      return merged;
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
      continue;
    }
    let parsed: unknown;
    try {
      parsed = isJSON ? JSON.parse(raw) : Bun.YAML.parse(raw);
    } catch {
      continue;
    }
    const result = AgentProfileSchema(parsed);
    if (result instanceof type.errors) continue;
    const profile = result as AgentProfile;
    // Resolve systemPromptPath relative to this directory. The file content
    // becomes systemPromptRole; an explicit systemPromptRole takes precedence.
    if (profile.systemPromptPath !== undefined && profile.systemPromptRole === undefined) {
      try {
        const promptRaw = await readFile(join(dir, profile.systemPromptPath), "utf8");
        profile.systemPromptRole = promptRaw.trim();
      } catch {
        // Missing prompt file is non-fatal — the profile loads without a role.
      }
    }
    local.push(profile);
  }

  const merged = [...registry];
  for (const profile of extraProfiles) mergeProfileInto(merged, profile);
  for (const profile of local) mergeProfileInto(merged, profile);
  return merged;
}
