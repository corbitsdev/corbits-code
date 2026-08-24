import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { SETTINGS_DIR_NAME } from "../branding.js";

const ProfileSchema = type({
  "profile?": "string",
  "model?": "string",
  "systemPromptExtensions?": "string[]",
  "workflow?": "string",
  // Per-call inactivity timeout in milliseconds. If the provider yields no
  // inference event for this many ms, the call is aborted and the user sees
  // "Request timed out". Default in the inference harness is 120_000 (2 min).
  // Tune higher for reasoning models that exhibit long silent-thinking
  // stretches between token bursts.
  "inactivityTimeoutMs?": "number >= 1",
  // Per-call total wall-clock cap in milliseconds. Starts at fetch.
  // Default in the inference harness is 600_000 (10 min). Backstop for
  // streams that keep emitting forever without terminating.
  "totalTimeoutMs?": "number >= 1",
  "+": "reject",
});

export type ProfileConfig = typeof ProfileSchema.infer;

export function profilesDir(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "profiles");
}

export function projectProfilePath(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME, "profile.json");
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
    if (projectProfile.systemPromptExtensions !== undefined) {
      merged.systemPromptExtensions = projectProfile.systemPromptExtensions;
    }
    if (projectProfile.inactivityTimeoutMs !== undefined)
      merged.inactivityTimeoutMs = projectProfile.inactivityTimeoutMs;
    if (projectProfile.totalTimeoutMs !== undefined)
      merged.totalTimeoutMs = projectProfile.totalTimeoutMs;
  }

  const resolvedName = profileName ?? projectProfile?.profile;
  if (resolvedName !== undefined) merged.profile = resolvedName;

  return merged;
}
