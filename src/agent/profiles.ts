import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";

import { plugin as defaultPlugin } from "@intercode/default-agents";

// Public agent profile types live in @intercode/default-agents so plugin
// authors can depend on that package without pulling in the full runtime.
export type { AgentProfile, AgentPlugin, CapabilityFilter, CapabilityMode } from "@intercode/default-agents";
import type { AgentProfile } from "@intercode/default-agents";

const CapabilityFilterSchema = type({
  mode: "'exclude' | 'allow'",
  tools: "string[]",
});

const AgentProfileSchema = type({
  id: "string",
  "description?": "string",
  "tier?": "'fast' | 'standard' | 'clever'",
  "capabilities?": CapabilityFilterSchema,
  "systemPromptRole?": "string",
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

// Load JSON profiles from the local .agents/agents/ directory and merge them
// into the registry. Local profiles override any same-id plugin-provided profile.
export async function loadAgentProfiles(dir: string): Promise<AgentProfile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) return [...registry];
    throw err;
  }

  const local: AgentProfile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = AgentProfileSchema(parsed);
    if (result instanceof type.errors) continue;
    local.push(result as AgentProfile);
  }

  // Build merged list: start from registry, override/append with local profiles.
  const merged = [...registry];
  for (const profile of local) {
    const idx = merged.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      merged[idx] = profile;
    } else {
      merged.push(profile);
    }
  }
  return merged;
}
