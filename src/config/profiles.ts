import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";

const ProfileSchema = type({
  "profile?": "string",
  "model?": "string",
  "maxTurns?": "number.integer >= 1",
  "systemPromptExtensions?": "string[]",
  "workflow?": "string",
  "+": "reject",
});

export type ProfileConfig = typeof ProfileSchema.infer;

export function profilesDir(home: string = homedir()): string {
  return join(home, ".intercode", "profiles");
}

export function projectProfilePath(cwd: string): string {
  return join(cwd, ".intercode", "profile.json");
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function validateProfileConfig(value: unknown, path: string): ProfileConfig {
  const result = ProfileSchema(value);
  if (result instanceof type.errors) {
    throw new Error(`Invalid profile at ${path}: ${result.summary}`);
  }
  return result;
}

export async function loadProfile(path: string): Promise<ProfileConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in profile file: ${path}`);
  }
  return validateProfileConfig(parsed, path);
}

// Resolves the effective profile for a run. Layer order (highest priority first):
//   profileName argument (CLI --profile flag)
//   project profile.json's "profile" key (named profile to inherit)
//   project profile.json itself
// Project profile field values override named profile field values.
export async function resolveProfile(cwd: string, profileName?: string): Promise<ProfileConfig> {
  const projectProfile = await loadProfile(projectProfilePath(cwd));

  const namedProfileName = profileName ?? projectProfile?.profile;

  let namedProfile: ProfileConfig | null = null;
  if (namedProfileName !== undefined) {
    const namedPath = join(profilesDir(), `${namedProfileName}.json`);
    namedProfile = await loadProfile(namedPath);
  }

  // Merge: project profile fields override named profile fields.
  const merged: ProfileConfig = { ...namedProfile };
  if (projectProfile !== null && projectProfile !== undefined) {
    if (projectProfile.model !== undefined) merged.model = projectProfile.model;
    if (projectProfile.maxTurns !== undefined) merged.maxTurns = projectProfile.maxTurns;
    if (projectProfile.systemPromptExtensions !== undefined) {
      merged.systemPromptExtensions = projectProfile.systemPromptExtensions;
    }
  }

  const resolvedName = profileName ?? projectProfile?.profile;
  if (resolvedName !== undefined) merged.profile = resolvedName;

  return merged;
}
