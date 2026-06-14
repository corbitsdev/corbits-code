import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";

import type { ProviderTier } from "../config/settings.js";

export type CapabilityMode = "exclude" | "allow";

export type CapabilityFilter = {
  mode: CapabilityMode;
  tools: string[];
};

export type AgentProfile = {
  id: string;
  description?: string;
  tier?: ProviderTier;
  capabilities?: CapabilityFilter;
  systemPromptRole?: string;
};

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

export async function loadAgentProfiles(dir: string): Promise<AgentProfile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }

  const profiles: AgentProfile[] = [];
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
    profiles.push(result as AgentProfile);
  }
  return profiles;
}
