import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type XaiTokens = {
  access: string;
  refresh: string;
  expiresAt: number;
  idToken?: string;
};

export type XaiProfile = {
  name: string;
  tokens: XaiTokens;
  createdAt: number;
};

type XaiAuthFile = {
  profiles: Record<string, XaiProfile>;
};

export function xaiAuthPath(home: string = homedir()): string {
  return join(home, ".intercode", "xai-auth.json");
}

function isXaiTokens(value: unknown): value is XaiTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.idToken === undefined || typeof t.idToken === "string")
  );
}

function isXaiProfile(value: unknown): value is XaiProfile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.name === "string" && typeof p.createdAt === "number" && isXaiTokens(p.tokens);
}

async function readAuthFile(home: string): Promise<XaiAuthFile> {
  let raw: string;
  try {
    raw = await readFile(xaiAuthPath(home), "utf8");
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
        const valid: Record<string, XaiProfile> = {};
        for (const [name, entry] of Object.entries(profiles)) {
          if (isXaiProfile(entry)) valid[name] = entry;
        }
        return { profiles: valid };
      }
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return { profiles: {} };
}

async function writeAuthFile(file: XaiAuthFile, home: string): Promise<void> {
  const path = xaiAuthPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function listXaiProfiles(home: string = homedir()): Promise<XaiProfile[]> {
  const file = await readAuthFile(home);
  return Object.values(file.profiles).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadXaiProfile(name: string, home: string = homedir()): Promise<XaiProfile | undefined> {
  const file = await readAuthFile(home);
  return file.profiles[name];
}

export async function saveXaiProfile(profile: XaiProfile, home: string = homedir()): Promise<void> {
  const file = await readAuthFile(home);
  file.profiles[profile.name] = profile;
  await writeAuthFile(file, home);
}

export async function updateXaiTokens(name: string, tokens: XaiTokens, home: string = homedir()): Promise<void> {
  const file = await readAuthFile(home);
  const existing = file.profiles[name];
  if (existing === undefined) return;
  file.profiles[name] = { ...existing, tokens };
  await writeAuthFile(file, home);
}

export async function removeXaiProfile(name: string | undefined, home: string = homedir()): Promise<string[]> {
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
