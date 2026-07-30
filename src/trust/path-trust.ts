import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT, SETTINGS_DIR_NAME } from "../branding.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "trust"]);

/**
 * Global trust for path-origin plugins (`settings.pluginPaths` / add-by-path).
 * Unlike project trust, this is not keyed by working directory: explicit path
 * consent is user-global, matching where pluginPaths already lives.
 */
const PathTrustStoreSchema = type({
  trustedPluginPaths: "string[]",
});

export type PathTrustStore = typeof PathTrustStoreSchema.infer;

const emptyStore = (): PathTrustStore => ({
  trustedPluginPaths: [],
});

export function pathTrustPath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "trust", "path-plugins.json");
}

/**
 * Read the store and report why it is empty when it is: a missing file means
 * the one-shot migration has not run yet, while an unreadable or malformed
 * file must not be mistaken for "already migrated" — that would silently lock
 * every path plugin into metadata-only forever.
 */
export async function readPathTrustStore(
  home: string = homedir(),
): Promise<{ state: "missing" | "invalid" | "valid"; store: PathTrustStore }> {
  const path = pathTrustPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", store: emptyStore() };
    }
    logger.warn`path trust store unreadable at ${path}: ${String(err)}`;
    return { state: "invalid", store: emptyStore() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn`path trust store is not valid JSON at ${path}: ${String(err)}`;
    return { state: "invalid", store: emptyStore() };
  }
  const validated = PathTrustStoreSchema(parsed);
  if (validated instanceof type.errors) {
    logger.warn`path trust store has an invalid shape at ${path}: ${validated.summary}`;
    return { state: "invalid", store: emptyStore() };
  }
  // Grants are recorded as absolute paths; a relative entry would resolve
  // against whatever process.cwd() happens to be, so drop it here.
  const paths: string[] = [];
  for (const p of validated.trustedPluginPaths) {
    if (!isAbsolute(p)) {
      logger.warn`ignoring non-absolute path trust entry: ${p}`;
      continue;
    }
    paths.push(resolve(p));
  }
  return { state: "valid", store: { trustedPluginPaths: paths } };
}

export async function loadPathTrust(home: string = homedir()): Promise<PathTrustStore> {
  return (await readPathTrustStore(home)).store;
}

// Written via temp-file + rename (same pattern as saveGlobalSettings) so a
// concurrent reader never sees a truncated or half-written store — a torn read
// would disable every path plugin for that session.
async function savePathTrust(store: PathTrustStore, home: string = homedir()): Promise<void> {
  const path = pathTrustPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// The grant helpers re-read the store immediately before writing, but two
// in-process mutations interleaving between that read and the write would
// still drop grants. Chain them so each mutation sees the previous one's
// result. (Cross-process writers remain last-writer-wins of a complete file.)
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(run, run);
  mutationQueue = next.catch(() => undefined);
  return next;
}

export function isPathPluginTrusted(store: PathTrustStore, pluginPath: string): boolean {
  if (!isAbsolute(pluginPath)) return false;
  return store.trustedPluginPaths.includes(resolve(pluginPath));
}

// Grants are always for a caller-resolved absolute path; resolving a relative
// one here (against process.cwd()) would trust a different directory than the
// user consented to.
function requireAbsolute(pluginPath: string): string {
  if (!isAbsolute(pluginPath)) {
    throw new Error(`path trust requires an absolute path, got: ${pluginPath}`);
  }
  return resolve(pluginPath);
}

export async function trustPathPlugin(
  pluginPath: string,
  home: string = homedir(),
): Promise<PathTrustStore> {
  return trustPathPlugins([pluginPath], home);
}

/** Grant trust for many absolute plugin paths in one read/write cycle. */
export async function trustPathPlugins(
  pluginPaths: string[],
  home: string = homedir(),
): Promise<PathTrustStore> {
  const absPaths = pluginPaths.map(requireAbsolute);
  return enqueueMutation(async () => {
    const store = await loadPathTrust(home);
    const known = new Set(store.trustedPluginPaths);
    let changed = false;
    const next = [...store.trustedPluginPaths];
    for (const abs of absPaths) {
      if (!known.has(abs)) {
        known.add(abs);
        next.push(abs);
        changed = true;
      }
    }
    if (!changed) return store;
    const updated: PathTrustStore = { trustedPluginPaths: next };
    await savePathTrust(updated, home);
    return updated;
  });
}

/**
 * Withdraw a grant. Always writes, even when the store ends up empty: the
 * file's continued existence is what stops the one-shot migration from
 * re-seeding the revoked path on the next launch.
 */
export async function revokePathPlugin(
  pluginPath: string,
  home: string = homedir(),
): Promise<PathTrustStore> {
  const abs = requireAbsolute(pluginPath);
  return enqueueMutation(async () => {
    const store = await loadPathTrust(home);
    const next: PathTrustStore = {
      trustedPluginPaths: store.trustedPluginPaths.filter((p) => p !== abs),
    };
    await savePathTrust(next, home);
    return next;
  });
}

/**
 * One-shot migration: seed the global store from `settings.pluginPaths` when
 * no valid store file exists yet. Every registered entry that resolves to a
 * plugin on disk is granted — pluginPaths lives in the user's global settings,
 * so each entry was put there by the user (add-by-path or a hand edit) and
 * registration is taken as consent at the moment the store is created, even
 * for entries never confirmed through the UI. Per-cwd project trust stores are
 * deliberately not consulted: they gate repo-controlled directories, which
 * never appear in pluginPaths. After the file exists, grants come only from
 * add-by-path / enable — marketplace growth and newly hand-edited settings do
 * not silently gain code-execution consent.
 *
 * `resolveMembers` maps each registered path to existing absolute plugin dirs
 * (expand marketplaces, drop missing paths). Callers supply expansion so this
 * module stays free of the plugin loader. `onMigrated` fires only on the run
 * that seeds grants, so callers can surface the one-time event to the user.
 */
export async function migratePathTrustFromPluginPaths(
  pluginPaths: string[],
  resolveMembers: (registeredPath: string) => Promise<string[]>,
  home: string = homedir(),
  opts: { onMigrated?: (grantedPaths: string[]) => void } = {},
): Promise<PathTrustStore> {
  const existing = await readPathTrustStore(home);
  if (existing.state === "valid") {
    return existing.store;
  }
  if (pluginPaths.length === 0) {
    return emptyStore();
  }
  // A relative pluginPaths entry has no fixed meaning until resolved against
  // some cwd; minting a grant for it here would trust whatever directory the
  // user happened to launch from first, permanently. Drop it, matching the
  // same rule readPathTrustStore enforces on load.
  const absolutePaths: string[] = [];
  for (const p of pluginPaths) {
    if (!isAbsolute(p)) {
      logger.warn`skipping relative pluginPaths entry during path-trust migration: ${p}`;
      continue;
    }
    absolutePaths.push(p);
  }
  const members: string[] = [];
  for (const p of absolutePaths) {
    members.push(...(await resolveMembers(p)));
  }
  if (members.length === 0) {
    // Create an empty store so we do not re-scan every launch when every
    // registered path is missing on disk.
    await savePathTrust(emptyStore(), home);
    return emptyStore();
  }
  const store = await trustPathPlugins(members, home);
  opts.onMigrated?.(store.trustedPluginPaths);
  return store;
}

/** One-line seeding notice shared by the TUI and exec entry points. */
export function reportPathTrustMigration(grantedPaths: string[]): void {
  const n = grantedPaths.length;
  process.stderr.write(
    `plugins: one-time migration granted code-execution trust to ${n} path plugin${n === 1 ? "" : "s"} from settings.pluginPaths — review in /plugins or ${pathTrustPath()}\n`,
  );
}
