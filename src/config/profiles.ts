import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProfileConfig = {
  profile?: string;
  model?: string;
  maxTurns?: number;
  systemPromptExtensions?: string[];
  // Name of a workflow to auto-start when a session begins on this profile.
  workflow?: string;
};

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "profile",
  "model",
  "maxTurns",
  "systemPromptExtensions",
  "workflow",
]);

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
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid profile at ${path}: expected a JSON object.`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `Invalid profile at ${path}: unknown key "${key}". Allowed keys: ${[...ALLOWED_KEYS].join(", ")}.`,
      );
    }
  }
  if (obj.profile !== undefined && typeof obj.profile !== "string") {
    throw new Error(`Invalid profile at ${path}: "profile" must be a string.`);
  }
  if (obj.model !== undefined && typeof obj.model !== "string") {
    throw new Error(`Invalid profile at ${path}: "model" must be a string.`);
  }
  if (
    obj.maxTurns !== undefined &&
    (typeof obj.maxTurns !== "number" ||
      !Number.isInteger(obj.maxTurns) ||
      obj.maxTurns < 1)
  ) {
    throw new Error(`Invalid profile at ${path}: "maxTurns" must be a positive integer.`);
  }
  if (obj.systemPromptExtensions !== undefined) {
    if (
      !Array.isArray(obj.systemPromptExtensions) ||
      !obj.systemPromptExtensions.every((e) => typeof e === "string")
    ) {
      throw new Error(
        `Invalid profile at ${path}: "systemPromptExtensions" must be an array of strings.`,
      );
    }
  }
  if (obj.workflow !== undefined && typeof obj.workflow !== "string") {
    throw new Error(`Invalid profile at ${path}: "workflow" must be a string.`);
  }
  return obj as unknown as ProfileConfig;
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
