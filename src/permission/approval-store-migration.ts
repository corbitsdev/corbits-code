import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getLogger } from "@intx/log";

import { canonicalGrantTool } from "../agent/canonical-tool-name.js";
import { LOG_NAMESPACE_ROOT, SETTINGS_DIR_NAME } from "../branding.js";
import { sessionDir } from "../session/index.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "permission", "approval-migration"]);

export interface ApprovalStoreMigrationFileResult {
  path: string;
  purged: number;
  backupPath?: string | undefined;
}

export interface ApprovalStoreMigrationResult {
  purged: number;
  backups: string[];
  files: ApprovalStoreMigrationFileResult[];
}

// canonicalGrantTool is the single owner of "is an update_plan key": it maps
// update_plan (any case, default.-prefixed, or doubled) to null so the
// load-time normalizer drops it fail-closed. The migration delegates to it so
// disk and memory can never disagree about which keys purge.
function isUpdatePlanKey(tool: unknown): boolean {
  return typeof tool === "string" && canonicalGrantTool(tool) === null;
}

function isUpdatePlanEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    isUpdatePlanKey((entry as Record<string, unknown>).tool)
  );
}

function purgeList(
  list: unknown,
  onPurge: () => void,
): { kept: unknown[]; changed: boolean } {
  if (!Array.isArray(list)) return { kept: [], changed: false };
  const kept: unknown[] = [];
  for (const entry of list) {
    if (isUpdatePlanEntry(entry)) onPurge();
    else kept.push(entry);
  }
  return { kept, changed: kept.length !== list.length };
}

function isFileExistsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EEXIST"
  );
}

// Purge update_plan keys from one approvals file (session, project, or
// global store shape: an `approvals` array plus, for the global file, a
// `providerModels` map of arrays). Backup-then-rewrite: the pre-migration
// bytes are saved to `<path>.bak` first (an existing backup is kept, so the
// first backup always holds the true original), and a file with nothing to
// left untouched (no backup, byte-identical) so re-runs are no-ops. Entries
// that are not positive update_plan matches are kept verbatim — pure renames
// are never collapsed here; that stays the load-time normalizer's job.
// Missing, unreadable, or corrupt files are no-ops; write failures propagate.
export async function migrateApprovalStoreFile(
  path: string,
): Promise<ApprovalStoreMigrationFileResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { path, purged: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { path, purged: 0 };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { path, purged: 0 };
  }
  const record = parsed as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let purged = 0;
  const onPurge = (): void => {
    purged += 1;
  };
  if (Array.isArray(record.approvals)) {
    const { kept, changed } = purgeList(record.approvals, onPurge);
    if (changed) next.approvals = kept;
  }
  const providerModels = record.providerModels;
  if (
    typeof providerModels === "object" &&
    providerModels !== null &&
    !Array.isArray(providerModels)
  ) {
    const map = providerModels as Record<string, unknown>;
    const nextMap: Record<string, unknown> = {};
    let mapChanged = false;
    for (const [key, list] of Object.entries(map)) {
      const { kept, changed } = purgeList(list, onPurge);
      if (changed) {
        nextMap[key] = kept;
        mapChanged = true;
      } else {
        nextMap[key] = list;
      }
    }
    if (mapChanged) next.providerModels = nextMap;
  }
  if (purged === 0) return { path, purged: 0 };
  const backupPath = `${path}.bak`;
  try {
    await writeFile(backupPath, raw, { flag: "wx" });
  } catch (err) {
    if (!isFileExistsError(err)) {
      log.warn("Skipping approval-store migration for {path}: {error}", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return { path, purged: 0 };
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2));
  return { path, purged, backupPath };
}

// One-time migration over the persisted approval stores (session, project,
// global including provider-model grants): purge on-disk update_plan keys so
// removing the load-time normalizer later cannot resurrect the hole. The
// paths mirror store.ts; the files array in the result keeps them explicit.
// Best-effort and idempotent — never throws, and a clean tree is a no-op.
export async function migratePersistedApprovalStores(
  cwd: string,
  sessionId: string,
  home: string = homedir(),
): Promise<ApprovalStoreMigrationResult> {
  const paths = [
    join(sessionDir(cwd, sessionId, home), "permissions.json"),
    join(cwd, SETTINGS_DIR_NAME, "permissions.json"),
    join(home, SETTINGS_DIR_NAME, "permissions.json"),
  ];
  const files: ApprovalStoreMigrationFileResult[] = [];
  for (const path of paths) {
    try {
      files.push(await migrateApprovalStoreFile(path));
    } catch (err) {
      log.warn("Skipping approval-store migration for {path}: {error}", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      files.push({ path, purged: 0 });
    }
  }
  return {
    purged: files.reduce((total, file) => total + file.purged, 0),
    backups: files.flatMap((file) =>
      file.backupPath !== undefined ? [file.backupPath] : [],
    ),
    files,
  };
}
