import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// On-disk store for Codex OAuth profiles. A user may hold multiple Codex
// subscriptions (personal, work, ...), so credentials are keyed by a
// user-chosen profile name within a single file. The provider type is shared;
// the profile name is what differentiates instances throughout the app.
//
// Tokens are credentials, so the file is owner-only (0o600) and the directory
// 0o700, matching the MCP auth store. Writes go through a temp file + rename so
// a concurrent reader never observes a torn file.

export type CodexTokens = {
  // Subscription access token injected as the Bearer credential for inference.
  access: string;
  // Long-lived token used to mint a new access token without re-login.
  refresh: string;
  // Absolute expiry of `access`, in epoch milliseconds.
  expiresAt: number;
  // ChatGPT account id extracted from the id_token, required as the
  // `chatgpt-account-id` header on every Codex inference request.
  accountId?: string;
};

export type CodexProfile = {
  name: string;
  tokens: CodexTokens;
  // Epoch milliseconds the profile was first authorized; informational.
  createdAt: number;
};

type CodexAuthFile = {
  profiles: Record<string, CodexProfile>;
};

export function codexAuthPath(home: string = homedir()): string {
  return join(home, ".intercode", "codex-auth.json");
}

function isCodexTokens(value: unknown): value is CodexTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.accountId === undefined || typeof t.accountId === "string")
  );
}

function isCodexProfile(value: unknown): value is CodexProfile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.name === "string" && typeof p.createdAt === "number" && isCodexTokens(p.tokens);
}

async function readAuthFile(home: string): Promise<CodexAuthFile> {
  let raw: string;
  try {
    raw = await readFile(codexAuthPath(home), "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return { profiles: {} };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && "profiles" in parsed) {
      const profiles = (parsed as { profiles: unknown }).profiles;
      if (typeof profiles === "object" && profiles !== null) {
        // Drop any entry that fails validation rather than wedging the session
        // on a single corrupt profile; a fresh login overwrites it.
        const valid: Record<string, CodexProfile> = {};
        for (const [name, entry] of Object.entries(profiles)) {
          if (isCodexProfile(entry)) valid[name] = entry;
        }
        return { profiles: valid };
      }
    }
  } catch {
    // A corrupt file should not be fatal; treat it as no state.
  }
  return { profiles: {} };
}

async function writeAuthFile(file: CodexAuthFile, home: string): Promise<void> {
  const path = codexAuthPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function listCodexProfiles(home: string = homedir()): Promise<CodexProfile[]> {
  const file = await readAuthFile(home);
  return Object.values(file.profiles).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCodexProfile(name: string, home: string = homedir()): Promise<CodexProfile | undefined> {
  const file = await readAuthFile(home);
  return file.profiles[name];
}

export async function saveCodexProfile(profile: CodexProfile, home: string = homedir()): Promise<void> {
  const file = await readAuthFile(home);
  file.profiles[profile.name] = profile;
  await writeAuthFile(file, home);
}

// Persist refreshed tokens for an existing profile, preserving createdAt. A
// no-op if the profile no longer exists (e.g. removed in another session).
export async function updateCodexTokens(name: string, tokens: CodexTokens, home: string = homedir()): Promise<void> {
  const file = await readAuthFile(home);
  const existing = file.profiles[name];
  if (existing === undefined) return;
  file.profiles[name] = { ...existing, tokens };
  await writeAuthFile(file, home);
}

// Remove one profile, or all profiles when `name` is undefined. Returns the
// names removed.
export async function removeCodexProfile(name: string | undefined, home: string = homedir()): Promise<string[]> {
  const file = await readAuthFile(home);
  if (name === undefined) {
    const removed = Object.keys(file.profiles);
    await writeAuthFile({ profiles: {} }, home);
    return removed;
  }
  if (file.profiles[name] === undefined) return [];
  delete file.profiles[name];
  await writeAuthFile(file, home);
  return [name];
}
