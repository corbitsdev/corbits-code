import { mkdir, readdir, readlink, rename, rm, symlink, stat, cp, unlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";

import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { loadState, saveState, type RunState } from "./state.js";
import { resolveSessionLabel } from "./session-label.js";
import { projectRootFor, projectSessionsRoot } from "./project-key.js";

// ---------------------------------------------------------------------------
// UUIDv7 generator (no external dependencies)
// ---------------------------------------------------------------------------
// UUIDv7 is time-ordered: the first 48 bits are a Unix ms timestamp, followed
// by version/variant bits and random data. This makes IDs sortable by creation
// time, which lets us use `latest` as the highest sortable value.
//
// Format: tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx
//   t = timestamp (48 bits)
//   7 = version nibble (0111)
//   x = random (62 bits total)
//   y = variant (10xx = RFC 4122)
// ---------------------------------------------------------------------------

export function generateSessionId(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  // Overwrite bytes 0-5 with the 48-bit timestamp (big-endian)
  bytes[0] = (ts / 0x10000000000) & 0xff;
  bytes[1] = (ts / 0x100000000) & 0xff;
  bytes[2] = (ts / 0x1000000) & 0xff;
  bytes[3] = (ts / 0x10000) & 0xff;
  bytes[4] = (ts / 0x100) & 0xff;
  bytes[5] = ts & 0xff;

  // Set version to 7 (byte 6, high nibble)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;

  // Set variant to 10xx (byte 8, high nibble)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  // Format as hex string with dashes
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Session directory helpers
// ---------------------------------------------------------------------------
// Canonical layout: ~/.corbits/projects/<project-key>/<session-id>/
// Legacy in-repo layout: <cwd>/.agent-state/<session-id>/ (dual-read + migrate)

/** Legacy in-repo session base (compat / dual-read only). */
export const LEGACY_SESSION_BASE = ".agent-state";

/** Full path to a session's root directory (canonical global location). */
export function sessionDir(cwd: string, sessionId: string, home: string = homedir()): string {
  return join(projectSessionsRoot(cwd, home), sessionId);
}

/** Pre-move in-repo path for a session (migration dual-read). */
export function legacySessionDir(cwd: string, sessionId: string): string {
  return join(cwd, LEGACY_SESSION_BASE, sessionId);
}

/** Candidate legacy session dirs: cwd first, then git project root when different. */
function legacySessionCandidates(cwd: string, sessionId: string): string[] {
  const underCwd = legacySessionDir(cwd, sessionId);
  const projectRoot = projectRootFor(cwd);
  if (realpathSafe(projectRoot) === realpathSafe(cwd)) return [underCwd];
  return [underCwd, join(projectRoot, LEGACY_SESSION_BASE, sessionId)];
}

/** Legacy roots that may still hold unmigrated sessions (cwd + project root). */
function legacySessionRoots(cwd: string): string[] {
  const underCwd = join(cwd, LEGACY_SESSION_BASE);
  const projectRoot = projectRootFor(cwd);
  if (realpathSafe(projectRoot) === realpathSafe(cwd)) return [underCwd];
  return [underCwd, join(projectRoot, LEGACY_SESSION_BASE)];
}

function legacyLatestCandidates(cwd: string): string[] {
  return legacySessionRoots(cwd).map((base) => join(base, "latest"));
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * If the global session tree is empty and a legacy in-repo tree exists, move
 * it into the global location so resume never strands. Returns the canonical
 * session directory path (which may not exist yet for brand-new sessions).
 */
export async function migrateLegacySessionIfNeeded(
  cwd: string,
  sessionId: string,
  home: string = homedir(),
): Promise<string> {
  const dir = sessionDir(cwd, sessionId, home);
  if (existsSync(dir)) return dir;

  for (const legacy of legacySessionCandidates(cwd, sessionId)) {
    if (!existsSync(legacy)) continue;

    await mkdir(dirname(dir), { recursive: true });
    try {
      await rename(legacy, dir);
    } catch {
      // Cross-device or busy tree: copy then remove legacy.
      await cp(legacy, dir, { recursive: true });
      await rm(legacy, { recursive: true, force: true });
    }
    return dir;
  }
  return dir;
}

/** Full path to a session's context subdirectory. */
export function sessionContextDir(
  cwd: string,
  sessionId: string,
  home: string = homedir(),
): string {
  return join(sessionDir(cwd, sessionId, home), "context");
}

/** Path to the latest-session symlink (per project, under the global root). */
function latestSymlinkPath(cwd: string, home: string = homedir()): string {
  return join(projectSessionsRoot(cwd, home), "latest");
}

/**
 * Create a session directory and update the `latest` symlink.
 * Returns the session directory path.
 */
export async function initSessionDir(
  cwd: string,
  sessionId: string,
  home: string = homedir(),
): Promise<string> {
  const dir = await migrateLegacySessionIfNeeded(cwd, sessionId, home);
  await mkdir(join(dir, "context"), { recursive: true });

  // Update the `latest` symlink to point to this session.
  const linkPath = latestSymlinkPath(cwd, home);
  await mkdir(dirname(linkPath), { recursive: true });

  // Remove existing symlink first, then create new one.
  await unlink(linkPath).catch(() => undefined);
  await symlink(sessionId, linkPath);

  return dir;
}

/**
 * Resolve the latest session directory via the `latest` symlink.
 * Returns the session ID and directory path, or null if no session exists.
 */
export async function resolveLatestSession(
  cwd: string,
  home: string = homedir(),
): Promise<{ sessionId: string; dir: string; contextDir: string } | null> {
  try {
    const linkPath = latestSymlinkPath(cwd, home);
    const sessionId = await readlink(linkPath);
    await migrateLegacySessionIfNeeded(cwd, sessionId, home);
    return {
      sessionId,
      dir: sessionDir(cwd, sessionId, home),
      contextDir: sessionContextDir(cwd, sessionId, home),
    };
  } catch {
    // Fall back: legacy latest under cwd, then under the git project root
    // (nested cwd may not have its own .agent-state/latest).
    for (const legacyLink of legacyLatestCandidates(cwd)) {
      try {
        const sessionId = await readlink(legacyLink);
        const dir = await migrateLegacySessionIfNeeded(cwd, sessionId, home);
        return {
          sessionId,
          dir,
          contextDir: sessionContextDir(cwd, sessionId, home),
        };
      } catch {
        // try next candidate
      }
    }
    return null;
  }
}

export interface SessionSummary {
  sessionId: string;
  task: string;
  startedAt: number;
  status: RunState["status"];
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a UUID v7 session id Corbits would write on disk. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

async function collectSessionIds(cwd: string, home: string): Promise<string[]> {
  const ids = new Set<string>();
  const roots = [projectSessionsRoot(cwd, home), ...legacySessionRoots(cwd)];
  for (const base of roots) {
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "latest" || !SESSION_ID_RE.test(entry)) continue;
      ids.add(entry);
    }
  }
  return [...ids];
}

/** List on-disk sessions for a project, newest first. */
export async function listSessions(
  cwd: string,
  home: string = homedir(),
): Promise<SessionSummary[]> {
  const entries = await collectSessionIds(cwd, home);

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    await migrateLegacySessionIfNeeded(cwd, entry, home);
    const loaded = await loadState(cwd, entry, home);
    if (loaded.kind === "ok") {
      summaries.push({
        sessionId: entry,
        task: loaded.state.task,
        startedAt: loaded.state.startedAt,
        status: loaded.state.status,
      });
      continue;
    }
    if (loaded.kind === "unreadable") {
      continue;
    }
    // Missing run.json: a session directory with context/ never reached its
    // first saveState call (see src/tui/runner.ts's early "running" write)
    // and therefore isn't actually running: report it as crashed rather
    // than fabricating liveness.
    try {
      const dirStat = await stat(sessionDir(cwd, entry, home));
      await stat(sessionContextDir(cwd, entry, home));
      summaries.push({
        sessionId: entry,
        task: "(conversation)",
        startedAt: dirStat.birthtimeMs > 0 ? dirStat.birthtimeMs : dirStat.mtimeMs,
        status: "crashed",
      });
    } catch {
      // Not a resumable session directory.
    }
  }

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return Promise.all(
    summaries.map(async (row) => ({
      ...row,
      task: await resolveSessionLabel(cwd, row.sessionId, row.task, home),
    })),
  );
}

/** Set the display name shown in resume lists and the session header (`run.json` task). */
export async function renameSession(
  cwd: string,
  sessionId: string,
  name: string,
  home: string = homedir(),
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Session name cannot be empty");
  }
  await migrateLegacySessionIfNeeded(cwd, sessionId, home);
  const existing = await loadState(cwd, sessionId, home);
  if (existing.kind === "unreadable") {
    throw new Error("Session state is unreadable");
  }
  if (existing.kind === "missing") {
    let startedAt = Date.now();
    try {
      const dirStat = await stat(sessionDir(cwd, sessionId, home));
      startedAt = dirStat.birthtimeMs > 0 ? dirStat.birthtimeMs : dirStat.mtimeMs;
    } catch {
      // Session dir missing; fall back to now.
    }
    await saveState(
      cwd,
      sessionId,
      {
        status: "running",
        turnsUsed: 0,
        task: trimmed,
        startedAt,
      },
      home,
    );
    return;
  }
  await saveState(cwd, sessionId, { ...existing.state, task: trimmed }, home);
}

export { projectKeyFor, projectSessionsRoot, projectsRoot, projectRootFor } from "./project-key.js";
