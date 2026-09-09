import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { SETTINGS_DIR_NAME } from "../branding.js";

// Per-server OAuth state persisted between sessions. Holding the PKCE verifier is
// necessary because authorization spans a process boundary (browser round-trip);
// tokens and dynamically-registered client info let later sessions reconnect
// without any user interaction.
export interface MCPAuthState {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export interface MCPAuthIdentity {
  serverName: string;
  serverURL: string;
}

export function mcpAuthDir(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "mcp-auth");
}

function legacyServerSlug(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_-]/g, "_") || "server";
}

function serverDisplaySlug(serverName: string): string {
  return legacyServerSlug(serverName).slice(0, 48);
}

export function normalizeMCPServerURL(serverURL: string): string {
  const url = new URL(serverURL);
  url.hash = "";
  return url.toString();
}

export function authFilePath(identity: MCPAuthIdentity, home: string = homedir()): string {
  const normalizedURL = normalizeMCPServerURL(identity.serverURL);
  const digest = createHash("sha256")
    .update(JSON.stringify([identity.serverName, normalizedURL]))
    .digest("hex");
  return join(mcpAuthDir(home), `${serverDisplaySlug(identity.serverName)}-${digest}.json`);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function parseAuthState(raw: string): MCPAuthState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as MCPAuthState;
  } catch {
    // A corrupt auth file should not wedge the session; treat it as no state and
    // let a fresh authorization overwrite it.
  }
  return undefined;
}

function stateFromRaw(raw: string | undefined): MCPAuthState {
  if (raw === undefined) return {};
  return parseAuthState(raw) ?? {};
}

function readAuthFileSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

async function readAuthFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

// Synchronous connect-contract load. Tolerates a missing (ENOENT) or corrupt
// file with empty state, matching loadAuthState; other read errors propagate.
export function loadAuthStateSync(
  identity: MCPAuthIdentity,
  home: string = homedir(),
): MCPAuthState {
  return stateFromRaw(readAuthFileSync(authFilePath(identity, home)));
}

export async function loadAuthState(
  identity: MCPAuthIdentity,
  home: string = homedir(),
): Promise<MCPAuthState> {
  return stateFromRaw(await readAuthFile(authFilePath(identity, home)));
}

// Cache refresh for a live provider: missing, unreadable, or corrupt files
// return undefined so the caller keeps its in-memory mirror. Empty-on-corrupt
// is loadAuthState's connect contract, not cache invalidation.
export function tryLoadAuthStateSync(
  identity: MCPAuthIdentity,
  home: string = homedir(),
): MCPAuthState | undefined {
  let raw: string | undefined;
  try {
    raw = readAuthFileSync(authFilePath(identity, home));
  } catch {
    return undefined;
  }
  if (raw === undefined) return undefined;
  return parseAuthState(raw);
}

// pid alone is not unique per call — concurrent saves in one process must not
// share a temp path or the second rename hits ENOENT after the first moves it.
let tmpWriteCounter = 0;

// Serialize read-modify-write per auth file so two OAuth provider instances for
// the same server cannot clobber each other's fields (classic lost-update: one
// session's saveCodeVerifier wiping another's just-written tokens).
const updateChains = new Map<string, Promise<unknown>>();

async function writeAuthFile(path: string, state: MCPAuthState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${(tmpWriteCounter += 1)}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

// Tokens are credentials, so the directory and file are restricted to the owner.
// Full replace — prefer updateAuthState when mutating a single field so concurrent
// writers merge instead of last-writer-wins on a stale snapshot.
export async function saveAuthState(
  identity: MCPAuthIdentity,
  state: MCPAuthState,
  home: string = homedir(),
): Promise<void> {
  const path = authFilePath(identity, home);
  const previous = updateChains.get(path) ?? Promise.resolve();
  const write = previous.then(
    () => writeAuthFile(path, state),
    () => writeAuthFile(path, state),
  );
  updateChains.set(
    path,
    write.then(
      () => undefined,
      () => undefined,
    ),
  );
  await write;
}

// Load → mutate → save under the per-file chain. Mutator receives a mutable
// snapshot of the latest on-disk state; the returned object is what was written.
export async function updateAuthState(
  identity: MCPAuthIdentity,
  mutator: (state: MCPAuthState) => void,
  home: string = homedir(),
): Promise<MCPAuthState> {
  const path = authFilePath(identity, home);
  const previous = updateChains.get(path) ?? Promise.resolve();
  const run = previous.then(
    async () => {
      const state = await loadAuthState(identity, home);
      mutator(state);
      await writeAuthFile(path, state);
      return state;
    },
    async () => {
      const state = await loadAuthState(identity, home);
      mutator(state);
      await writeAuthFile(path, state);
      return state;
    },
  );
  updateChains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function deleteAuthState(
  identity: MCPAuthIdentity,
  home: string = homedir(),
): Promise<void> {
  const path = authFilePath(identity, home);
  const previous = updateChains.get(path) ?? Promise.resolve();
  const run = previous.then(
    () => unlinkAuthFile(path),
    () => unlinkAuthFile(path),
  );
  updateChains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  await run;
}

async function unlinkAuthFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}
