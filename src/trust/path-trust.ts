import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SETTINGS_DIR_NAME } from "../branding.js";

/**
 * Global trust for path-origin plugins (`settings.pluginPaths` / add-by-path).
 * Unlike project trust, this is not keyed by working directory: explicit path
 * consent is user-global, matching where pluginPaths already lives.
 */
export type PathTrustStore = {
  trustedPluginPaths: string[];
};

const emptyStore = (): PathTrustStore => ({
  trustedPluginPaths: [],
});

export function pathTrustPath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "trust", "path-plugins.json");
}

export async function pathTrustStoreExists(home: string = homedir()): Promise<boolean> {
  try {
    await access(pathTrustPath(home));
    return true;
  } catch {
    return false;
  }
}

export async function loadPathTrust(home: string = homedir()): Promise<PathTrustStore> {
  try {
    const raw = await readFile(pathTrustPath(home), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return emptyStore();
    const o = parsed as Record<string, unknown>;
    const paths = Array.isArray(o.trustedPluginPaths)
      ? o.trustedPluginPaths.filter((p): p is string => typeof p === "string").map((p) => resolve(p))
      : [];
    return { trustedPluginPaths: paths };
  } catch {
    return emptyStore();
  }
}

async function savePathTrust(store: PathTrustStore, home: string = homedir()): Promise<void> {
  const path = pathTrustPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function isPathPluginTrusted(store: PathTrustStore, pluginPath: string): boolean {
  const abs = resolve(pluginPath);
  return store.trustedPluginPaths.includes(abs);
}

export async function trustPathPlugin(
  pluginPath: string,
  home: string = homedir(),
): Promise<PathTrustStore> {
  const store = await loadPathTrust(home);
  const abs = resolve(pluginPath);
  if (!store.trustedPluginPaths.includes(abs)) {
    const next: PathTrustStore = {
      trustedPluginPaths: [...store.trustedPluginPaths, abs],
    };
    await savePathTrust(next, home);
    return next;
  }
  return store;
}

/** Grant trust for many absolute plugin paths in one read/write cycle. */
export async function trustPathPlugins(
  pluginPaths: string[],
  home: string = homedir(),
): Promise<PathTrustStore> {
  const store = await loadPathTrust(home);
  const known = new Set(store.trustedPluginPaths);
  let changed = false;
  const next = [...store.trustedPluginPaths];
  for (const p of pluginPaths) {
    const abs = resolve(p);
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
}

/**
 * One-shot migration: when the global path-trust file does not exist yet, seed
 * grants from registered pluginPaths so users who only had per-cwd trust keep
 * path plugins across projects. After the file exists, grants come only from
 * add-by-path / enable — marketplace growth and hand-edited settings do not
 * silently gain code-execution consent.
 *
 * `resolveMembers` maps each registered path to existing absolute plugin dirs
 * (expand marketplaces, drop missing paths). Callers supply expansion so this
 * module stays free of the plugin loader.
 */
export async function migratePathTrustFromPluginPaths(
  pluginPaths: string[],
  resolveMembers: (registeredPath: string) => Promise<string[]>,
  home: string = homedir(),
): Promise<PathTrustStore> {
  if (await pathTrustStoreExists(home)) {
    return loadPathTrust(home);
  }
  if (pluginPaths.length === 0) {
    return emptyStore();
  }
  const members: string[] = [];
  for (const p of pluginPaths) {
    members.push(...(await resolveMembers(p)));
  }
  if (members.length === 0) {
    // Create an empty store so we do not re-scan every launch when every
    // registered path is missing on disk.
    await savePathTrust(emptyStore(), home);
    return emptyStore();
  }
  return trustPathPlugins(members, home);
}
