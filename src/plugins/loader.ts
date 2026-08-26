import { existsSync, statSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkflowPlugin } from "../workflows/types.js";
import { SETTINGS_DIR_NAME } from "../branding.js";
import type { CommandPlugin } from "../tui/commands/registry.js";
import { pathIsInsideOrEqual } from "../util/path-contain.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { capturePluginLoaded } from "../telemetry/product-events.js";
import { loadDataOnlyPlugin } from "./data-only.js";

import {
  resolvePluginWarningHandler,
  stderrPluginWarning,
  type PluginLoadDiagnostics,
} from "./diagnostics.js";
import {
  originRequiresTrust,
  type PluginOrigin,
  type ProjectTrustStore,
} from "../trust/project-trust.js";

export type { PluginLoadDiagnostics } from "./diagnostics.js";

export interface PluginModule {
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
  /**
   * Set by dedupePluginModules when this module's id shadowed an earlier
   * repo module that had manifest.defaultEnabled === true. Lets
   * isPluginModuleEnabled keep the id default-on after a same-id later
   * install replaces the bundled module, without requiring an explicit
   * settings flag (CL-6716).
   */
  shadowedRepoDefaultEnabled?: boolean;
}

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
    (await readManifestJson(abs)) ?? (await readManifestJson(join(abs, ".claude-plugin")));
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
    diagnostics?: PluginLoadDiagnostics;
    origin?: PluginOrigin;
    telemetry?: Telemetry;
  } = {},
): Promise<PluginModule | null> {
  const cwd = opts.cwd ?? process.cwd();
  // Prefer diagnostics collector so batch discovery can summarize; explicit
  // onWarning for tests; else stderrPluginWarning.
  const onWarning = resolvePluginWarningHandler(
    opts.diagnostics !== undefined
      ? { diagnostics: opts.diagnostics }
      : opts.onWarning !== undefined
        ? { onWarning: opts.onWarning }
        : { onWarning: stderrPluginWarning },
  );
  const origin = opts.origin;
  const telemetry = opts.telemetry ?? NOOP_TELEMETRY;
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
        // Pass diagnostics when present so loadDataOnlyPlugin prefers the
        // collector over a pre-bound onWarning sink.
        const dataOnly = await loadDataOnlyPlugin(entryPath, {
          cwd,
          ...(opts.diagnostics !== undefined ? { diagnostics: opts.diagnostics } : { onWarning }),
        });
        if (dataOnly !== null) {
          const mod: PluginModule = { dir: entryPath, manifest: dataOnly.manifest };
          if (dataOnly.agentPlugin !== undefined) mod.agentPlugin = dataOnly.agentPlugin;
          if (dataOnly.commandPlugin !== undefined) mod.commandPlugin = dataOnly.commandPlugin;
          if (origin !== undefined) {
            mod.origin = origin;
            mod.pluginPath = resolve(entryPath);
          }
          if (origin !== undefined) {
            capturePluginLoaded(telemetry, origin, resolve(entryPath));
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
    const mod = (await import(importTarget)) as Record<string, unknown>;
    const result: PluginModule = { dir: dirname(importTarget) };
    const manifest =
      parsePluginManifest(mod.manifest) ??
      (await readManifestJson(dirname(importTarget))) ??
      (await readManifestJson(dirname(dirname(importTarget))));
    if (manifest !== null) result.manifest = manifest;
    if (
      mod.workflowPlugin != null &&
      typeof mod.workflowPlugin === "object" &&
      "workflows" in mod.workflowPlugin
    ) {
      result.workflowPlugin = mod.workflowPlugin as WorkflowPlugin;
    }
    if (
      mod.commandPlugin != null &&
      typeof mod.commandPlugin === "object" &&
      "commands" in mod.commandPlugin
    ) {
      result.commandPlugin = mod.commandPlugin as CommandPlugin;
    }
    if (
      mod.agentPlugin != null &&
      typeof mod.agentPlugin === "object" &&
      "agents" in mod.agentPlugin
    ) {
      result.agentPlugin = mod.agentPlugin as { agents: unknown[] };
    }
    if (typeof mod.createWebProvider === "function")
      result.createWebProvider = mod.createWebProvider;
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
    if (origin !== undefined) {
      capturePluginLoaded(telemetry, origin, resolve(pluginDir));
    }
    return result;
  } catch (err) {
    // Route through the same sink as skill/load warnings so a diagnostics
    // collector can summarize instead of writing mid-frame stderr.
    onWarning(`failed to load "${target}": ${String(err)}`);
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
  "absolute" | "outside-contain-root" | "missing" | "invalid-entry";

export interface ExpandPluginPathSkip {
  source: string;
  reason: ExpandPluginPathSkipReason;
  /** Absolute path after resolve, when known. */
  resolved?: string;
}

export interface ExpandPluginPathOptions {
  /**
   * Resolved member directories must stay under this root (or equal it).
   * Claude installs: `~/.claude/plugins`. Path/pluginPaths marketplaces omit
   * this and get the parent of the marketplace root (any path under that parent
   * tree is allowed — multi-level relatives ok).
   */
  containRoot?: string;
  /**
   * Called for each skipped marketplace source (never silent). Required —
   * not optional with a stderr default — because an optional sink with a
   * silent fallback is exactly the shape that let three review rounds each
   * turn up one more call site writing raw stderr mid-frame in the
   * interactive TUI (CL-5411). Making it required turns every call site
   * into a compile error until it picks a handler on purpose:
   * `expandSkipDiagnosticsHandler(diagnostics)` for a batching caller,
   * an explicit stderr writer for a headless caller where that is correct
   * and visible (see `src/exec/runner.ts`), or `() => {}` to state on the
   * record that a caller is deliberately ignoring skips.
   */
  onSkip: (skip: ExpandPluginPathSkip) => void;
}

/** One-line description of a skip, shared by every `onSkip` sink (diagnostics or stderr). */
export function formatExpandSkip(skip: ExpandPluginPathSkip): string {
  const where = skip.resolved !== undefined ? ` → ${skip.resolved}` : "";
  return `marketplace source ${JSON.stringify(skip.source)} skipped (${skip.reason})${where}`;
}

/**
 * The ordinary `onSkip` handler: collect into `diagnostics` instead of
 * writing raw stderr, so a skipped marketplace member lands in the same
 * end-of-batch summary as every other plugin-load warning.
 */
export function expandSkipDiagnosticsHandler(
  diagnostics: PluginLoadDiagnostics,
): (skip: ExpandPluginPathSkip) => void {
  return (skip) => diagnostics.warnings.push(formatExpandSkip(skip));
}

/**
 * `onSkip` when no diagnostics collector is in play: one explicit stderr
 * line, module-private and only reached by an internal caller's own
 * deliberate choice (see `resolveExpandSkip` below) — never `expandPluginPath`
 * falling back to it on its own.
 */
function stderrExpandSkip(skip: ExpandPluginPathSkip): void {
  process.stderr.write(`plugins: ${formatExpandSkip(skip)}\n`);
}

/** Diagnostics when given, else the explicit stderr line — no silent option. */
function resolveExpandSkip(
  diagnostics?: PluginLoadDiagnostics,
): (skip: ExpandPluginPathSkip) => void {
  return diagnostics !== undefined ? expandSkipDiagnosticsHandler(diagnostics) : stderrExpandSkip;
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
  opts: ExpandPluginPathOptions,
): Promise<string[]> {
  const marketplaceRoot = resolve(path);
  const report = (skip: ExpandPluginPathSkip): void => {
    opts.onSkip(skip);
  };

  // 1. Declared marketplace: relative `source` list, contained under containRoot
  // (or parent of marketplace root for path plugins — any depth under that parent).
  try {
    const raw = await readFile(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { plugins?: unknown }).plugins)
    ) {
      const containRoot = resolve(opts.containRoot ?? defaultContainRoot(marketplaceRoot));
      const candidates: { source: string; resolved: string }[] = [];
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
      const existing = await Promise.all(candidates.map((c) => pathExists(c.resolved)));
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
    const containRoot = resolve(opts.containRoot ?? defaultContainRoot(marketplaceRoot));
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
// list never pre-grant a directory that could appear later with other content
// — that drop is deliberate, but a *skipped* member (bad source, escape) still
// has a reason worth reaching the caller's diagnostics, so `onSkip` is
// required rather than silently defaulted (see `ExpandPluginPathOptions`).
export async function expandExistingPluginMembers(
  registeredPath: string,
  cwd: string,
  onSkip: (skip: ExpandPluginPathSkip) => void,
): Promise<string[]> {
  const abs = isAbsolute(registeredPath) ? registeredPath : resolve(cwd, registeredPath);
  const members = await expandPluginPath(abs, { onSkip });
  const existing = await Promise.all(members.map((m) => pathExists(m)));
  return members.filter((_, i) => existing[i]);
}

// Scan a plugins root directory and return all loaded plugin modules.
// `cwd` is forwarded to loadPluginEntry for skill resolution in data-only plugins.
// When `isTrusted` is set and origin requires trust, untrusted paths load
// metadata-only (no import). Pass `diagnostics` to collect skill/load warnings
// for a single end-of-batch summary instead of per-line stderr.
async function scanPluginsDir(
  dir: string,
  cwd: string,
  origin: PluginOrigin,
  isTrusted?: (pluginPath: string) => boolean,
  diagnostics?: PluginLoadDiagnostics,
  telemetry?: Telemetry,
): Promise<PluginModule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: PluginModule[] = [];
  for (const entry of entries) {
    // Each entry may itself be a marketplace, so expand before loading. A
    // skipped member routes into `diagnostics` when the caller has one, same
    // as loadPluginEntry below — otherwise it would bypass the collector.
    const dirs = await expandPluginPath(join(dir, entry), {
      onSkip: resolveExpandSkip(diagnostics),
    });
    for (const d of dirs) {
      const abs = resolve(d);
      if (originRequiresTrust(origin) && isTrusted !== undefined && !isTrusted(abs)) {
        const meta = await readPluginMetadataOnly(abs, origin);
        if (meta !== null) results.push(meta);
        continue;
      }
      const plugin = await loadPluginEntry(d, {
        cwd,
        origin,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
        ...(telemetry !== undefined ? { telemetry } : {}),
      });
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
  opts: {
    isPluginTrusted?: (pluginPath: string) => boolean;
    diagnostics?: PluginLoadDiagnostics;
    telemetry?: Telemetry;
  } = {},
): Promise<PluginModule[]> {
  const projectDir = join(cwd, SETTINGS_DIR_NAME, "plugins");
  const userDir = join(homedir(), SETTINGS_DIR_NAME, "plugins");
  const [project, user] = await Promise.all([
    scanPluginsDir(
      projectDir,
      cwd,
      "project",
      opts.isPluginTrusted,
      opts.diagnostics,
      opts.telemetry,
    ),
    scanPluginsDir(userDir, cwd, "user", undefined, opts.diagnostics, opts.telemetry),
  ]);
  return [...project, ...user];
}

// Collapse modules sharing a manifest id, keeping the last occurrence. Callers
// concatenate sources in precedence order (repo, then user, then explicit
// paths), so "last wins" means an explicit path overrides a user plugin, which
// overrides a bundled one. Modules without a manifest carry no id and are kept
// as-is.
//
// A later non-repo module with the same id as a repo defaultEnabled plugin
// would otherwise silently turn the bundled default off — the survivor is
// non-repo, so isPluginModuleEnabled's origin==="repo" check fails and
// enablement then requires an explicit settings flag (CL-6716). Carry the
// repo default-on forward via shadowedRepoDefaultEnabled so the id stays
// enabled by default unless the user explicitly disables it in settings.
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
      const prev = result[existing]!;
      const wasRepoDefaultEnabled =
        prev.shadowedRepoDefaultEnabled === true ||
        (prev.origin === "repo" && prev.manifest?.defaultEnabled === true);
      result[existing] = wasRepoDefaultEnabled ? { ...mod, shadowedRepoDefaultEnabled: true } : mod;
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
  opts: {
    isPluginTrusted?: (pluginPath: string) => boolean;
    diagnostics?: PluginLoadDiagnostics;
    telemetry?: Telemetry;
  } = {},
): Promise<PluginModule[]> {
  // A skipped member routes into `diagnostics` when the caller has one, same
  // reasoning as scanPluginsDir — otherwise it bypasses the collector.
  const onSkip = resolveExpandSkip(opts.diagnostics);
  const resolved = await Promise.all(
    paths.map(async (p) => {
      const abs = isAbsolute(p) ? p : join(cwd, p);
      return expandPluginPath(abs, { onSkip });
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
        return loadPluginEntry(p, {
          cwd,
          origin: "path",
          ...(opts.diagnostics !== undefined ? { diagnostics: opts.diagnostics } : {}),
          ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
        });
      }),
  );
  return loaded.filter((m): m is PluginModule => m !== null);
}

// Discover built-in repo plugins shipped next to the product, never session
// cwd/plugins (that would stamp a foreign tree origin:repo). Locator matches
// resolveChangelogPath: first existing directory wins. Missing dir is a
// silent empty list.
function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveRepoPluginsDir(opts?: {
  moduleUrl?: string;
  execPath?: string;
}): string | undefined {
  const candidates: string[] = [];
  const moduleUrl = opts?.moduleUrl ?? import.meta.url;
  try {
    const here = dirname(fileURLToPath(moduleUrl));
    // Source tree only: src/plugins/loader.ts → ../../plugins. From dist/index.js
    // that walk is parent-of-repo, a foreign tree we must never stamp origin:repo.
    if (basename(here) === "plugins" && basename(dirname(here)) === "src") {
      candidates.push(join(here, "..", "..", "plugins"));
    }
    // Bundled: dist/index.js → dist/plugins (copied at build).
    candidates.push(join(here, "plugins"));
  } catch {
    // Invalid moduleUrl (tests may pass a non-file URL).
  }
  const execPath = opts?.execPath ?? process.execPath;
  if (execPath.length > 0) {
    // Compiled binary: plugins/ sits next to the executable.
    candidates.push(join(dirname(execPath), "plugins"));
  }
  for (const dir of candidates) {
    if (isExistingDirectory(dir)) return dir;
  }
  return undefined;
}

export async function discoverRepoPlugins(
  cwd: string,
  opts: {
    diagnostics?: PluginLoadDiagnostics;
    telemetry?: Telemetry;
    moduleUrl?: string;
    execPath?: string;
  } = {},
): Promise<PluginModule[]> {
  const pluginsDir = resolveRepoPluginsDir({
    moduleUrl: opts.moduleUrl ?? import.meta.url,
    execPath: opts.execPath ?? process.execPath,
  });
  if (pluginsDir === undefined) return [];
  return scanPluginsDir(pluginsDir, cwd, "repo", undefined, opts.diagnostics, opts.telemetry);
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
    diagnostics?: PluginLoadDiagnostics;
    telemetry?: Telemetry;
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
    // Prefer collector when present; else stderrPluginWarning.
    resolvePluginWarningHandler(
      opts.diagnostics !== undefined
        ? { diagnostics: opts.diagnostics }
        : { onWarning: stderrPluginWarning },
    )(`failed to parse ${registryPath}`);
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
  // Default expand-skip sink: diagnostics when provided, else
  // stderrPluginWarning; explicit onExpandSkip (tests) still wins.
  const warnExpand = resolvePluginWarningHandler(
    opts.diagnostics !== undefined
      ? { diagnostics: opts.diagnostics }
      : { onWarning: stderrPluginWarning },
  );
  const onExpandSkip =
    opts.onExpandSkip ??
    ((skip: ExpandPluginPathSkip) => {
      const where = skip.resolved !== undefined ? ` → ${skip.resolved}` : "";
      warnExpand(
        `skipped marketplace source ${JSON.stringify(skip.source)} (${skip.reason})${where}`,
      );
    });
  const installPaths: { abs: string; registryKey: string }[] = [];
  const seen = new Set<string>();
  for (const [registryKey, entries] of Object.entries(pluginsField as Record<string, unknown>)) {
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
      const dataOnly = await loadDataOnlyPlugin(d, {
        cwd,
        ...(opts.diagnostics !== undefined ? { diagnostics: opts.diagnostics } : {}),
      });
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
          name: plugin.manifest.name === plugin.manifest.id ? idFromKey : plugin.manifest.name,
        };
      }
      if (opts.telemetry !== undefined) {
        capturePluginLoaded(opts.telemetry, "user", resolve(d));
      }
      results.push(plugin);
    }
  }
  return results;
}

/** True when a plugin id is probably a cache version dirname, not a product name. */
function looksLikeVersionDirId(id: string): boolean {
  // Semver-ish: 1.0.0, 1.8.0-beta, v1.2.3
  return /^(?:v)?\d+\.\d+(\.\d+)?(?:[-+].*)?$/i.test(id);
}

/** Re-export for callers that need the type without importing trust directly. */
export type { PluginOrigin, ProjectTrustStore };
