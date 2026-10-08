import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT, SETTINGS_DIR_NAME } from "../branding.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "trust"]);

/**
 * Global trust for path-origin plugins (pluginPaths / add-by-path). Not keyed
 * by cwd, unlike project trust: explicit path consent is user-global, where
 * pluginPaths already lives.
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
 * Read the store and report why it is empty: missing means migration has not
 * run yet; invalid must not read as "already migrated", or every path plugin
 * stays metadata-only.
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
  // Grants are recorded absolute (see requireAbsolute); a relative entry
  // would bind to process.cwd(), so drop it here.
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

export async function loadPathTrust(
  home: string = homedir(),
): Promise<PathTrustStore> {
  return (await readPathTrustStore(home)).store;
}

// Temp-file + rename (as saveGlobalSettings) so a concurrent reader never
// sees a torn store — that would disable every path plugin.
async function savePathTrust(
  store: PathTrustStore,
  home: string = homedir(),
): Promise<void> {
  const path = pathTrustPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// Mutations re-read the store right before writing; two interleaved in-process
// mutations would drop grants. Chain them so each sees the previous result.
// Cross-process writers stay last-writer-wins of a whole file.
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(run, run);
  mutationQueue = next.catch(() => undefined);
  return next;
}

export function isPathPluginTrusted(
  store: PathTrustStore,
  pluginPath: string,
): boolean {
  if (!isAbsolute(pluginPath)) return false;
  return store.trustedPluginPaths.includes(resolve(pluginPath));
}

// Grants are caller-resolved absolute paths; resolving a relative one against
// cwd would trust a directory the user never consented to.
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
 * Withdraw a grant. Writes even when the store empties: the file's continued
 * existence is what stops migration re-seeding the revoked path next launch.
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
 * One-shot migration: seed the global store from `settings.pluginPaths`
 * when the store file is missing (first launch). Entries are consent in
 * the user's global settings, so every registered path resolving to a
 * plugin on disk is granted, UI confirmation or not. Once the file
 * exists, grants come only from add-by-path / enable; project stores
 * gate repo dirs, which never appear in pluginPaths.
 *
 * `resolveMembers` expands each registered path to its existing plugin
 * dirs (callers supply it, so this module stays free of the plugin
 * loader); `onMigrated` fires only on the seeding run.
 *
 * A corrupt store refuses to seed — re-granting would undo an explicit
 * revoke; the file stays untouched (plugins stay metadata-only) until
 * the user deletes it to re-seed or re-consents.
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
  if (existing.state === "invalid") {
    if (pluginPaths.length > 0) {
      logger.warn`refusing path-trust migration from a corrupt store at ${pathTrustPath(home)}: delete the file to re-seed from settings.pluginPaths or re-consent through add-by-path`;
    }
    return emptyStore();
  }
  if (pluginPaths.length === 0) {
    return emptyStore();
  }
  // A relative pluginPaths entry would bind to the launch cwd permanently;
  // drop it, matching readPathTrustStore on load.
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
