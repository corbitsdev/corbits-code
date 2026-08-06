import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { WorkflowPlugin } from "../workflows/types.js";
import { SETTINGS_DIR_NAME } from "../branding.js";
import type { CommandPlugin } from "../tui/commands/registry.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";
import { loadDataOnlyPlugin } from "./data-only.js";
import {
  originRequiresTrust,
  type PluginOrigin,
  type ProjectTrustStore,
} from "../trust/project-trust.js";

export type PluginModule = {
  // Self-description (id, name, kind, credential fields), when the module
  // exports a valid `manifest`. Drives the /plugins UI and web-provider wiring.
  manifest?: PluginManifest;
  // Absolute directory the module was loaded from. Used by resolvers that need
  // to resolve relative paths declared by the plugin (e.g. systemPromptPath).
  dir?: string;
  workflowPlugin?: WorkflowPlugin;
  commandPlugin?: CommandPlugin;
  // Agent profiles contributed by a kind:"agent" plugin. Validated by
  // resolveAgentPluginProfiles before they reach the sub-agent dispatcher.
  agentPlugin?: { agents: unknown[] };
  // A web provider factory: (options: unknown) => WebProvider | Promise<WebProvider>.
  // Typed as unknown here so this module doesn't pull in the full web type graph.
  createWebProvider?: unknown;
  // A tool plugin factory: (options: unknown) => ToolPlugin | Promise<ToolPlugin>.
  // Typed as unknown so this module doesn't pull in the tools-posix type graph.
  createToolPlugin?: unknown;
  /** Discovery origin; used for project-trust gating. */
  origin?: PluginOrigin;
  /** Absolute path used for path-bound trust (plugin directory or file). */
  pluginPath?: string;
  /**
   * True when only manifest/metadata was read — no JS import, no markdown agent
   * or command bodies. Untrusted project/path plugins stay in this state until
   * the user records trust for that path.
   */
  metadataOnly?: boolean;
  /**
   * Optional provenance label stamped onto contributed agent profiles
   * (e.g. "claude" for Claude Code marketplace installs). Distinct from
   * `origin`, which drives trust gating.
   */
  source?: string;
};

// Read and validate a manifest.json beside the module. Plugins may declare
// their manifest as a JS export (mod.manifest) or a sibling manifest.json file;
// this covers the JSON path so plugins that are pure data + commands work too.
async function readManifestJson(dir: string): Promise<PluginManifest | null> {
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    return parsePluginManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Safe metadata-only view: never import()s and never loads markdown agents/commands.
async function readPluginMetadataOnly(
  entryPath: string,
  origin: PluginOrigin,
): Promise<PluginModule | null> {
  let dir = entryPath;
  try {
    const info = await stat(entryPath);
    if (!info.isDirectory()) dir = dirname(entryPath);
  } catch {
    return null;
  }
  const abs = resolve(dir);
  const manifest =
    (await readManifestJson(abs))
    ?? (await readManifestJson(join(abs, ".claude-plugin")));
  if (manifest === null) {
    return null;
  }
  return {
    dir: abs,
    manifest,
    origin,
    pluginPath: abs,
    metadataOnly: true,
  };
}

// Attempt to load a single plugin directory entry (a file or a directory with
// an index file). Returns null if the entry cannot be resolved to a module.
// Exported so the /plugins UI can register a plugin from an arbitrary path.
//
// `cwd` is the project root used for skill resolution inside data-only plugins
// (corbitsdev-format agents declare skills by name; the resolver searches
// project-local skill directories relative to cwd). Defaults to
// process.cwd() for direct callers; internal discovery functions thread the
// session cwd through so a non-default working directory (test harness,
// future server-mode) resolves skills correctly.
export async function loadPluginEntry(
  entryPath: string,
  opts: {
    cwd?: string;
    onWarning?: (msg: string) => void;
    origin?: PluginOrigin;
  } = {},
): Promise<PluginModule | null> {
  const cwd = opts.cwd ?? process.cwd();
  const onWarning = opts.onWarning ?? ((msg: string) => process.stderr.write(`plugins: ${msg}\n`));
  const origin = opts.origin;
  let target = entryPath;
  let pluginDir = entryPath;
  try {
    const info = await stat(entryPath);
    if (info.isDirectory()) {
      pluginDir = entryPath;
      // Prefer src/index.ts, then index.ts, then index.js.
      for (const candidate of ["src/index.ts", "index.ts", "index.js"]) {
        const candidatePath = join(entryPath, candidate);
        try {
          await stat(candidatePath);
          target = candidatePath;
          break;
        } catch {
          // not found, try next
        }
      }
      // No JS entry — fall back to a data-only plugin (agents/*.md and/or
      // commands/*.md). Lets a plugin be pure data + skills, no index.ts.
      if (target === entryPath) {
        const dataOnly = await loadDataOnlyPlugin(entryPath, { cwd, onWarning });
        if (dataOnly !== null) {
          const mod: PluginModule = { dir: entryPath, manifest: dataOnly.manifest };
          if (dataOnly.agentPlugin !== undefined) mod.agentPlugin = dataOnly.agentPlugin;
          if (dataOnly.commandPlugin !== undefined) mod.commandPlugin = dataOnly.commandPlugin;
          if (origin !== undefined) {
            mod.origin = origin;
            mod.pluginPath = resolve(entryPath);
          }
          return mod;
        }
        return null;
      }
    } else {
      pluginDir = dirname(entryPath);
    }
  } catch {
    return null;
  }

  try {
    // Dynamic import resolves relative specifiers against this module, not cwd,
    // so resolve to an absolute path first (callers may pass a relative path).
    const importTarget = isAbsolute(target) ? target : resolve(target);
    const mod = await import(importTarget) as Record<string, unknown>;
    const result: PluginModule = { dir: dirname(importTarget) };
    const manifest = parsePluginManifest(mod.manifest)
      ?? (await readManifestJson(dirname(importTarget)))
      ?? (await readManifestJson(dirname(dirname(importTarget))));
    if (manifest !== null) result.manifest = manifest;
    if (mod.workflowPlugin != null && typeof mod.workflowPlugin === "object" && "workflows" in mod.workflowPlugin) {
      result.workflowPlugin = mod.workflowPlugin as WorkflowPlugin;
    }
    if (mod.commandPlugin != null && typeof mod.commandPlugin === "object" && "commands" in mod.commandPlugin) {
      result.commandPlugin = mod.commandPlugin as CommandPlugin;
    }
    if (mod.agentPlugin != null && typeof mod.agentPlugin === "object" && "agents" in mod.agentPlugin) {
      result.agentPlugin = mod.agentPlugin as { agents: unknown[] };
    }
    if (typeof mod.createWebProvider === "function") result.createWebProvider = mod.createWebProvider;
    if (typeof mod.createToolPlugin === "function") result.createToolPlugin = mod.createToolPlugin;
    // A default-exported factory maps strictly to the factory for the manifest's
    // kind, so web and tool plugins can both just `export default` — and a tool
    // plugin's default never leaks into the web slot (or vice versa).
    if (typeof mod.default === "function") {
      if (manifest?.kind === "web" && result.createWebProvider === undefined) {
        result.createWebProvider = mod.default;
      } else if (manifest?.kind === "tool" && result.createToolPlugin === undefined) {
        result.createToolPlugin = mod.default;
      }
    }
    if (origin !== undefined) {
      result.origin = origin;
      result.pluginPath = resolve(pluginDir);
    }
    return result;
  } catch (err) {
    process.stderr.write(`plugins: failed to load "${target}": ${String(err)}\n`);
    return null;
  }
}

// A Claude Code marketplace is a directory that bundles several plugins under a
// `plugins/` subtree and declares them in `.claude-plugin/marketplace.json`
// (`{ plugins: [{ name, source: "./plugins/<name>" }] }`). When a path points at
// a marketplace root, expand it to its member plugin directories so each loads
// as its own plugin (one id, one enable toggle). A plain plugin directory is
// returned unchanged as a single-element array.
//
// Marketplace `source` entries must be relative. Absolute sources are rejected.
// Resolved paths must stay under `containRoot` when set; when omitted, path
// plugins default to the parent of the marketplace root (any relative under that
// parent tree, e.g. `../agents/x` or deeper). Claude discovery passes
// `~/.claude/plugins`. Existing paths are realpath-checked so a symlink under
// the contain root that points outside is rejected (see list-dir.ts).
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Why a marketplace `source` entry was not expanded to a member path. */
export type ExpandPluginPathSkipReason =
  | "absolute"
  | "outside-contain-root"
  | "missing"
  | "invalid-entry";

export type ExpandPluginPathSkip = {
  source: string;
  reason: ExpandPluginPathSkipReason;
  /** Absolute path after resolve, when known. */
  resolved?: string;
};

export type ExpandPluginPathOptions = {
  /**
   * Resolved member directories must stay under this root (or equal it).
   * Claude installs: `~/.claude/plugins`. Path/pluginPaths marketplaces omit
   * this and get the parent of the marketplace root (any path under that parent
   * tree is allowed — multi-level relatives ok).
   */
  containRoot?: string;
  /** Called for each skipped marketplace source (never silent). */
  onSkip?: (skip: ExpandPluginPathSkip) => void;
};

/** Default skip reporter: stderr, same shape as Claude discovery. */
function defaultExpandSkip(skip: ExpandPluginPathSkip): void {
  const where = skip.resolved !== undefined ? ` → ${skip.resolved}` : "";
  process.stderr.write(
    `plugins: skipped marketplace source ${JSON.stringify(skip.source)} (${skip.reason})${where}\n`,
  );
}

/**
 * Containment check with symlink safety. Lexical reject first; when both the
 * candidate and the contain root exist, realpath both and re-check so a symlink
 * under the root that points outside is refused.
 *
 * Soft-allow when one realpath fails: a missing candidate (create-later member)
 * still expands if it is lexically under the root — the existence filter later
 * drops absent paths. Fail-closed only when both realpaths succeed and the
 * resolved target escapes (symlink-out case). A realpath failure on an existing
 * candidate while the root resolves is treated as soft-allow too (permission /
 * race); tightening that would break create-later members that race with mkdir.
 */
async function pathContainedUnder(abs: string, root: string): Promise<boolean> {
  if (!pathIsInsideOrEqual(abs, root)) return false;
  let realAbs: string | undefined;
  let realRoot: string | undefined;
  try {
    realAbs = await realpath(abs);
  } catch {
    // Candidate missing or unresolvable — keep lexical allow (create-later).
  }
  try {
    realRoot = await realpath(root);
  } catch {
    // Root missing is pathological; keep lexical allow.
  }
  if (realAbs !== undefined && realRoot !== undefined) {
    return pathIsInsideOrEqual(realAbs, realRoot);
  }
  return true;
}

/**
 * Default contain root for path/pluginPaths marketplaces: parent of the
 * marketplace directory (siblings like `../agents/x` stay allowed). Refuse the
 * parent when it is the filesystem root — that would make every absolute path
 * "inside" and defeat containment; fall back to the marketplace root itself.
 */
function defaultContainRoot(marketplaceRoot: string): string {
  const parent = dirname(marketplaceRoot);
  if (resolve(parent) === parse(parent).root) return marketplaceRoot;
  return parent;
}

export async function expandPluginPath(
  path: string,
  opts: ExpandPluginPathOptions = {},
): Promise<string[]> {
  const marketplaceRoot = resolve(path);
  const report = (skip: ExpandPluginPathSkip): void => {
    (opts.onSkip ?? defaultExpandSkip)(skip);
  };

  // 1. Declared marketplace: relative `source` list, contained under containRoot
  // (or parent of marketplace root for path plugins — any depth under that parent).
  try {
    const raw = await readFile(
      join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object"
      && parsed !== null
      && Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) {
      const containRoot = resolve(
        opts.containRoot ?? defaultContainRoot(marketplaceRoot),
      );
      const candidates: Array<{ source: string; resolved: string }> = [];
      for (const p of (parsed as { plugins: unknown[] }).plugins) {
        if (typeof p !== "object" || p === null) {
          report({ source: "", reason: "invalid-entry" });
          continue;
        }
        const src = (p as { source?: unknown }).source;
        if (typeof src !== "string" || src.length === 0) {
          report({ source: typeof src === "string" ? src : "", reason: "invalid-entry" });
          continue;
        }
        // Absolute `source` would jump any relative contain check.
        if (isAbsolute(src)) {
          report({ source: src, reason: "absolute" });
          continue;
        }
        const resolved = resolve(marketplaceRoot, src);
        if (!(await pathContainedUnder(resolved, containRoot))) {
          report({ source: src, reason: "outside-contain-root", resolved });
          continue;
        }
        candidates.push({ source: src, resolved });
      }
      const existing = await Promise.all(
        candidates.map((c) => pathExists(c.resolved)),
      );
      const surviving: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        if (existing[i]) {
          surviving.push(c.resolved);
        } else {
          // `source` is the original relative string (same shape as other reasons).
          report({ source: c.source, reason: "missing", resolved: c.resolved });
        }
      }
      // Declared marketplace with zero surviving members: return [] — do not
      // fall through to the layout heuristic or [marketplaceRoot].
      return surviving;
    }
  } catch {
    // not a declared marketplace — fall through to the layout heuristic
  }

  // 2. Layout heuristic: a `plugins/` subdir whose root is not itself a plugin.
  // Covers a marketplace checkout without a marketplace.json. We only expand
  // when the root carries no single-plugin markers, so a normal plugin dir that
  // happens to contain a `plugins/` folder is never mis-expanded.
  const hasPluginsSubdir = await pathExists(join(marketplaceRoot, "plugins"));
  const rootIsPlugin =
    (await pathExists(join(marketplaceRoot, "agents"))) ||
    (await pathExists(join(marketplaceRoot, "skills"))) ||
    (await pathExists(join(marketplaceRoot, "commands"))) ||
    (await pathExists(join(marketplaceRoot, "command"))) ||
    (await pathExists(join(marketplaceRoot, "manifest.json"))) ||
    (await pathExists(join(marketplaceRoot, ".claude-plugin", "plugin.json"))) ||
    (await pathExists(join(marketplaceRoot, "index.ts"))) ||
    (await pathExists(join(marketplaceRoot, "src", "index.ts")));
  if (hasPluginsSubdir && !rootIsPlugin) {
    const containRoot = resolve(
      opts.containRoot ?? defaultContainRoot(marketplaceRoot),
    );
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(marketplaceRoot, "plugins"), { withFileTypes: true });
    } catch {
      return [marketplaceRoot];
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(marketplaceRoot, "plugins", entry.name);
      if (!(await pathExists(child))) continue;
      if (!(await pathContainedUnder(child, containRoot))) {
        report({ source: child, reason: "outside-contain-root", resolved: child });
        continue;
      }
      dirs.push(child);
    }
    if (dirs.length > 0) return dirs;
  }

  return [marketplaceRoot];
}

// Resolve a registered pluginPaths entry to the member plugin directories that
// exist on disk: relative entries resolve against cwd, marketplace roots expand
// to their members. Missing paths are dropped so trust decisions made from this
// list never pre-grant a directory that could appear later with other content.
export async function expandExistingPluginMembers(
  registeredPath: string,
  cwd: string,
): Promise<string[]> {
  const abs = isAbsolute(registeredPath) ? registeredPath : resolve(cwd, registeredPath);
  const members = await expandPluginPath(abs);
  const existing = await Promise.all(members.map((m) => pathExists(m)));
  return members.filter((_, i) => existing[i]);
}

// Scan a plugins root directory and return all loaded plugin modules.
// `cwd` is forwarded to loadPluginEntry for skill resolution in data-only plugins.
// When `isTrusted` is set and origin requires trust, untrusted paths load
// metadata-only (no import).
async function scanPluginsDir(
  dir: string,
  cwd: string,
  origin: PluginOrigin,
  isTrusted?: (pluginPath: string) => boolean,
): Promise<PluginModule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: PluginModule[] = [];
  for (const entry of entries) {
    // Each entry may itself be a marketplace, so expand before loading.
    const dirs = await expandPluginPath(join(dir, entry));
    for (const d of dirs) {
      const abs = resolve(d);
      if (originRequiresTrust(origin) && isTrusted !== undefined && !isTrusted(abs)) {
        const meta = await readPluginMetadataOnly(abs, origin);
        if (meta !== null) results.push(meta);
        continue;
      }
      const plugin = await loadPluginEntry(d, { cwd, origin });
      if (plugin !== null) results.push(plugin);
    }
  }
  return results;
}

// Discover user-installed plugins from:
//   <cwd>/.corbits/plugins/   (project-local — requires project trust to execute)
//   ~/.corbits/plugins/       (user-global — auto-trusted)
//
// Pass `isPluginTrusted` to gate project plugins. When omitted, project plugins
// still load fully (backward compatible for tests/callers that do not pass trust).
export async function discoverUserPlugins(
  cwd: string,
  opts: { isPluginTrusted?: (pluginPath: string) => boolean } = {},
): Promise<PluginModule[]> {
  const projectDir = join(cwd, SETTINGS_DIR_NAME, "plugins");
  const userDir = join(homedir(), SETTINGS_DIR_NAME, "plugins");
  const [project, user] = await Promise.all([
    scanPluginsDir(projectDir, cwd, "project", opts.isPluginTrusted),
    scanPluginsDir(userDir, cwd, "user"),
  ]);
  return [...project, ...user];
}

// Collapse modules sharing a manifest id, keeping the last occurrence. Callers
// concatenate sources in precedence order (repo, then user, then explicit
// paths), so "last wins" means an explicit path overrides a user plugin, which
// overrides a bundled one. Modules without a manifest carry no id and are kept
// as-is.
export function dedupePluginModules(modules: PluginModule[]): PluginModule[] {
  const indexById = new Map<string, number>();
  const result: PluginModule[] = [];
  for (const mod of modules) {
    const id = mod.manifest?.id;
    if (id === undefined) {
      result.push(mod);
      continue;
    }
    const existing = indexById.get(id);
    if (existing !== undefined) {
      result[existing] = mod;
    } else {
      indexById.set(id, result.length);
      result.push(mod);
    }
  }
  return result;
}

// Load plugins from explicit file/directory paths (from settings.pluginPaths).
// Relative paths resolve against cwd. Unresolvable entries are skipped. A path
// may point at a Claude Code marketplace, in which case it expands to its member
// plugin directories before loading.
// Untrusted path origins load metadata-only when isPluginTrusted is provided.
export async function loadPluginsFromPaths(
  paths: string[],
  cwd: string,
  opts: { isPluginTrusted?: (pluginPath: string) => boolean } = {},
): Promise<PluginModule[]> {
  const resolved = await Promise.all(
    paths.map(async (p) => {
      const abs = isAbsolute(p) ? p : join(cwd, p);
      return expandPluginPath(abs);
    }),
  );
  // Anything under <cwd>/.corbits/plugins/ is project origin no matter how it
  // was registered: discoverUserPlugins already loads it behind per-cwd project
  // trust, and loading it here as origin "path" would let enabling the stub
  // record a machine-wide grant for a repo-controlled directory.
  const projectPluginsDir = resolve(cwd, SETTINGS_DIR_NAME, "plugins");
  const loaded = await Promise.all(
    resolved
      .flat()
      .filter((p) => !pathIsInsideOrEqual(resolve(p), projectPluginsDir))
      .map(async (p) => {
        const abs = resolve(p);
        if (opts.isPluginTrusted !== undefined && !opts.isPluginTrusted(abs)) {
          return readPluginMetadataOnly(abs, "path");
        }
        return loadPluginEntry(p, { cwd, origin: "path" });
      }),
  );
  return loaded.filter((m): m is PluginModule => m !== null);
}

// Discover built-in repo plugins from the plugins/ directory that lives
// alongside this source file (two levels up: src/plugins/ -> plugins/).
// Repo plugins resolve skills against the session cwd, not the repo root,
// so project-local skills stay in scope when Corbits Code is invoked from a
// different working directory. Product-shipped plugins are auto-trusted.
export async function discoverRepoPlugins(cwd: string): Promise<PluginModule[]> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const pluginsDir = join(repoRoot, "plugins");
  return scanPluginsDir(pluginsDir, cwd, "repo");
}

// Claude Code records marketplace installs in
// `~/.claude/plugins/installed_plugins.json` (versioned object keyed by
// install id → array of { installPath, version, ... }). Only those paths are
// loaded — never a full walk of the cache — so removed installs stay out.
// Origin is `user` (home install, auto-trusted for import); modules still
// need settings.plugins[id].enabled. Stamp source "claude" for search_agents.
//
// `home` is injectable for tests; defaults to the process home directory.
// Marketplace member expansion uses containRoot=`~/.claude/plugins` so relative
// sources like `../agents/<name>` resolve when still under that root; absolute
// sources and escapes outside the root are rejected with skip reporting.
export async function discoverClaudeInstalledPlugins(
  cwd: string,
  opts: {
    home?: string;
    onExpandSkip?: (skip: ExpandPluginPathSkip) => void;
  } = {},
): Promise<PluginModule[]> {
  const home = opts.home ?? homedir();
  const registryPath = join(home, ".claude", "plugins", "installed_plugins.json");
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`plugins: failed to parse ${registryPath}\n`);
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const pluginsField = (parsed as { plugins?: unknown }).plugins;
  if (typeof pluginsField !== "object" || pluginsField === null || Array.isArray(pluginsField)) {
    return [];
  }

  const pluginsRoot = resolve(home, ".claude", "plugins");
  const onExpandSkip = opts.onExpandSkip ?? defaultExpandSkip;
  const installPaths: Array<{ abs: string; registryKey: string }> = [];
  const seen = new Set<string>();
  for (const [registryKey, entries] of Object.entries(
    pluginsField as Record<string, unknown>,
  )) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const installPath = (entry as { installPath?: unknown }).installPath;
      if (typeof installPath !== "string" || installPath.length === 0) continue;
      // Relative installPath resolves against process cwd and would let a
      // poisoned registry load project trees as origin:"user" (no project trust).
      if (!isAbsolute(installPath)) continue;
      const abs = resolve(installPath);
      // Contain under ~/.claude/plugins only (registry is home-scoped).
      // Same realpath both-sides check as expand so a symlink under the root
      // that points outside is refused (not lexical-only).
      if (!(await pathContainedUnder(abs, pluginsRoot))) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      installPaths.push({ abs, registryKey });
    }
  }

  const results: PluginModule[] = [];
  for (const { abs: installPath, registryKey } of installPaths) {
    if (!(await pathExists(installPath))) continue;
    // Expand marketplace roots under ~/.claude/plugins (not install root alone)
    // so sibling sources like ../agents/<name> load; absolute/escape still out.
    const dirs = await expandPluginPath(installPath, {
      containRoot: pluginsRoot,
      onSkip: onExpandSkip,
    });
    for (const d of dirs) {
      // Data-only only: never import() JS at discovery. Enable-gate does not
      // re-run loaders; importing here would execute untrusted JS before enable.
      // Claude marketplace layouts are markdown agents/commands; JS plugins
      // stay on explicit pluginPaths (user-opted load path).
      const dataOnly = await loadDataOnlyPlugin(d, { cwd });
      if (dataOnly === null) continue;
      const plugin: PluginModule = {
        dir: d,
        manifest: dataOnly.manifest,
        origin: "user",
        pluginPath: resolve(d),
        source: "claude",
      };
      if (dataOnly.agentPlugin !== undefined) plugin.agentPlugin = dataOnly.agentPlugin;
      if (dataOnly.commandPlugin !== undefined) plugin.commandPlugin = dataOnly.commandPlugin;
      // Version-dir basenames (e.g. .../cmo/1.0.0 → "1.0.0") collide across
      // installs and break settings.plugins enable keys. Prefer a stable id
      // from the registry key (name before @) when the resolved id looks like
      // a version and the registry key is usable.
      const idFromKey = registryKey.includes("@")
        ? registryKey.slice(0, registryKey.indexOf("@"))
        : registryKey;
      if (
        plugin.manifest !== undefined &&
        idFromKey.length > 0 &&
        looksLikeVersionDirId(plugin.manifest.id)
      ) {
        plugin.manifest = {
          ...plugin.manifest,
          id: idFromKey,
          name:
            plugin.manifest.name === plugin.manifest.id
              ? idFromKey
              : plugin.manifest.name,
        };
      }
      results.push(plugin);
    }
  }
  return results;
}

/** True when `abs` is the root or a path strictly under it (prefix + separator). */
function pathIsInsideOrEqual(abs: string, root: string): boolean {
  const a = resolve(abs);
  const r = resolve(root);
  if (a === r) return true;
  // Use platform separator so Windows drive paths do not match on `/` alone.
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`;
  return a.startsWith(prefix);
}

/** True when a plugin id is probably a cache version dirname, not a product name. */
function looksLikeVersionDirId(id: string): boolean {
  // Semver-ish: 1.0.0, 1.8.0-beta, v1.2.3
  return /^(?:v)?\d+\.\d+(\.\d+)?(?:[-+].*)?$/i.test(id);
}

/** Re-export for callers that need the type without importing trust directly. */
export type { PluginOrigin, ProjectTrustStore };

