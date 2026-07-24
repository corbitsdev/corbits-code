// TEMPORARY migration shim for the Intercode -> Corbits Code rename.
//
// The settings directory moved from `.intercode` to `.corbits` (see
// SETTINGS_DIR_NAME in ../branding.js). This module copies a pre-existing
// legacy directory's contents into the new location the first time the new
// location is unclaimed (missing, empty, or pricing-cache only), so users
// upgrading in place do not lose settings, permissions, MEMORY.md, plugins, etc.
//
// REMOVE WITH (deletion checklist when the migration window closes):
// - this file and migrate-legacy-dir.test.ts
// - call sites in config/index.ts (migrate + markLegacyDirMigrated)
// - Settings fields migrationLegacyDirCopied / migrationLegacyDirPromptAnswered
//   and markLegacyDirMigrated / markLegacyDirPromptAnswered in settings.ts
// - TUI: legacy-dir-confirm.tsx, runner.tsx prompt gate, app.tsx resolve path
// - secret-guard dual `.intercode/settings.json` pattern + tests
// - .gitignore legacy `.intercode/*` entries
// - docs/IMPLEMENTATION.md legacy migration note

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT, SETTINGS_DIR_NAME } from "../branding.js";

export const LEGACY_SETTINGS_DIR_NAME = ".intercode";

const log = getLogger([LOG_NAMESPACE_ROOT, "config", "migrate-legacy-dir"]);

export function legacyGlobalDirPath(home: string = homedir()): string {
  return join(home, LEGACY_SETTINGS_DIR_NAME);
}

export function newGlobalDirPath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME);
}

export function legacyLocalDirPath(cwd: string): string {
  return join(cwd, LEGACY_SETTINGS_DIR_NAME);
}

export function newLocalDirPath(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME);
}

async function isMissingOrEmptyDir(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) return true;
    // Anything else (permission error, not-a-directory, ...) is treated as
    // "do not touch it" — the caller will skip the copy rather than guess.
    throw err;
  }
  return entries.length === 0;
}

// True when `dir` has no user settings yet. A pricing-cache-only tree is not a
// completed migration — bootstrap can create `~/.corbits/cache` independently
// of credentials and other state that still lives under the legacy name.
async function isUnclaimedSettingsDir(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) return true;
    throw err;
  }
  if (entries.length === 0) return true;
  if (entries.length === 1 && entries[0] === "cache") return true;
  return false;
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

export type MigrateResult = { copied: boolean };

// Copies `legacyDir` into `newDir` recursively when `newDir` is unclaimed
// (missing, empty, or only a pricing cache) and `legacyDir` exists. Never
// overwrites existing files, never deletes. Any failure is caught, logged as
// a warning, and reported as `{ copied: false }` so startup always continues.
async function migrateDir(legacyDir: string, newDir: string, label: string): Promise<MigrateResult> {
  try {
    if (!(await isUnclaimedSettingsDir(newDir))) return { copied: false };

    const legacyExists = !(await isMissingOrEmptyDir(legacyDir).catch((err) => {
      if (isENOENT(err)) return true;
      throw err;
    }));
    if (!legacyExists) return { copied: false };

    await mkdir(newDir, { recursive: true });
    await cp(legacyDir, newDir, { recursive: true, errorOnExist: false, force: false });
    return { copied: true };
  } catch (err) {
    log.warn(`Failed to migrate legacy ${label} directory ({legacyDir} -> {newDir}): {error}`, {
      legacyDir,
      newDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { copied: false };
  }
}

// Global `~/.intercode` -> `~/.corbits` migration. Safe to call on every
// startup; it is a no-op once the new directory holds user settings.
export async function migrateLegacyGlobalDir(home: string = homedir()): Promise<MigrateResult> {
  return migrateDir(legacyGlobalDirPath(home), newGlobalDirPath(home), "global settings");
}

// Per-repo `<cwd>/.intercode` -> `<cwd>/.corbits` migration. Same guarantees
// as the global case; no interactive prompt, the old directory is just left
// in place afterward.
export async function migrateLegacyLocalDir(cwd: string): Promise<MigrateResult> {
  return migrateDir(legacyLocalDirPath(cwd), newLocalDirPath(cwd), "repo-local settings");
}

// Recursively removes the legacy global directory. Called only after the user
// explicitly confirms via the TUI prompt. Errors are logged, not thrown, so a
// failed cleanup never breaks startup.
export async function removeLegacyGlobalDir(home: string = homedir()): Promise<void> {
  const dir = legacyGlobalDirPath(home);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`Failed to remove legacy global directory {dir}: {error}`, {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
