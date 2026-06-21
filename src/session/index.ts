import { mkdir, readdir, readlink, stat, symlink, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

import { loadState, type RunState } from "./state.js";

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

const SESSION_BASE = ".agent-state";

/** Full path to a session's root directory. */
export function sessionDir(cwd: string, sessionId: string): string {
  return join(cwd, SESSION_BASE, sessionId);
}

/** Full path to a session's context subdirectory. */
export function sessionContextDir(cwd: string, sessionId: string): string {
  return join(cwd, SESSION_BASE, sessionId, "context");
}

/** Path to the latest-session symlink. */
function latestSymlinkPath(cwd: string): string {
  return join(cwd, SESSION_BASE, "latest");
}

/**
 * Create a session directory and update the `latest` symlink.
 * Returns the session directory path.
 */
export async function initSessionDir(cwd: string, sessionId: string): Promise<string> {
  const dir = sessionDir(cwd, sessionId);
  await mkdir(join(dir, "context"), { recursive: true });

  // Update the `latest` symlink to point to this session.
  const linkPath = latestSymlinkPath(cwd);
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
): Promise<{ sessionId: string; dir: string; contextDir: string } | null> {
  try {
    const linkPath = latestSymlinkPath(cwd);
    const sessionId = await readlink(linkPath);
    return {
      sessionId,
      dir: sessionDir(cwd, sessionId),
      contextDir: sessionContextDir(cwd, sessionId),
    };
  } catch {
    return null;
  }
}

export type SessionSummary = {
  sessionId: string;
  task: string;
  startedAt: number;
  status: RunState["status"];
};

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** List on-disk sessions for a repo, newest first. */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const base = join(cwd, SESSION_BASE);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (entry === "latest" || !SESSION_ID_RE.test(entry)) continue;
    const state = await loadState(cwd, entry);
    if (state !== null) {
      summaries.push({
        sessionId: entry,
        task: state.task,
        startedAt: state.startedAt,
        status: state.status,
      });
      continue;
    }
    // TUI sessions persist conversation under context/ before run.json exists.
    try {
      const dirStat = await stat(sessionDir(cwd, entry));
      await stat(sessionContextDir(cwd, entry));
      summaries.push({
        sessionId: entry,
        task: "(conversation)",
        startedAt: dirStat.mtimeMs,
        status: "running",
      });
    } catch {
      // Not a resumable session directory.
    }
  }

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries;
}
