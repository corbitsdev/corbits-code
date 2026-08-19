import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SETTINGS_DIR_NAME } from "../../branding.js";
import { projectSessionsRoot } from "../../session/project-key.js";

export type CrashKind = "uncaughtException" | "unhandledRejection";

// projectSessionsRoot shells out to git synchronously with no timeout. A
// crash handler must never call it directly: a hung or corrupted git would
// block process.exit forever, the exact failure this module exists to
// prevent. primeCrashReporting resolves the root once during ordinary
// startup, well before any crash, and the handler only ever reads the
// cached value below with no I/O of its own.
let primedSessionsRoot: string | null = null;

export function primeCrashReporting(
  cwd: string,
  home: string = homedir(),
  resolveSessionsRoot: (cwd: string, home: string) => string = projectSessionsRoot,
): void {
  try {
    primedSessionsRoot = resolveSessionsRoot(cwd, home);
  } catch {
    primedSessionsRoot = null;
  }
}

// A crash before priming ever ran (or a priming failure) must still resolve
// to a path with no git call, so the report goes to an unresolved bucket
// rather than blocking mid-crash on project-root resolution.
function fallbackSessionsRoot(home: string): string {
  return join(home, SETTINGS_DIR_NAME, "projects", "unresolved");
}

export function crashReportDir(home: string = homedir()): string {
  return join(primedSessionsRoot ?? fallbackSessionsRoot(home), "errors");
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Best-effort crash report writer. Never logs on its own; failures here
 * must never mask the original crash, so every I/O error is swallowed and
 * reported as null for the caller to log.
 */
export async function writeCrashReport(
  kind: CrashKind,
  error: unknown,
  cwd: string = process.cwd(),
  home: string = homedir(),
): Promise<string | null> {
  try {
    const dir = crashReportDir(home);
    await mkdir(dir, { recursive: true });
    const now = new Date();
    const file = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}.txt`);
    const body = `kind: ${kind}\ntime: ${now.toISOString()}\ncwd: ${cwd}\n\n${describeError(error)}\n`;
    await writeFile(file, body, "utf8");
    return file;
  } catch {
    return null;
  }
}
