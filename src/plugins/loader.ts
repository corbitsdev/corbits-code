import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkflowPlugin } from "../workflows/types.js";
import type { CommandPlugin } from "../tui/commands/registry.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";
import { loadDataOnlyAgentPlugin } from "./data-only-agent.js";

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

// Attempt to load a single plugin directory entry (a file or a directory with
// an index file). Returns null if the entry cannot be resolved to a module.
// Exported so the /plugins UI can register a plugin from an arbitrary path.
//
// `cwd` is the project root used for skill resolution inside data-only plugins
// (corbitsdev-format agents declare skills by name; the resolver searches
// <cwd>/.intercode/skills and bundled skills relative to cwd). Defaults to
// process.cwd() for direct callers; internal discovery functions thread the
// session cwd through so a non-default working directory (test harness,
// future server-mode) resolves skills correctly.
export async function loadPluginEntry(
  entryPath: string,
  opts: { cwd?: string; onWarning?: (msg: string) => void } = {},
): Promise<PluginModule | null> {
  const cwd = opts.cwd ?? process.cwd();
  const onWarning = opts.onWarning ?? ((msg: string) => process.stderr.write(`plugins: ${msg}\n`));
  let target = entryPath;
  try {
    const info = await stat(entryPath);
    if (info.isDirectory()) {
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
      // No JS entry — fall back to a data-only agent plugin if it contains
      // agents/*.md (or *.md directly). Lets a plugin be just agents/ + skills/.
      if (target === entryPath) {
        // pluginId defaults to basename(pluginDir) inside the loader; don't
        // pass it here so there's a single source of truth for the default.
        const dataOnly = await loadDataOnlyAgentPlugin(entryPath, {
          cwd,
          onWarning,
        });
        if (dataOnly !== null) {
          return {
            dir: entryPath,
            manifest: dataOnly.manifest,
            agentPlugin: dataOnly.agentPlugin,
          };
        }
        return null;
      }
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
    return result;
  } catch (err) {
    process.stderr.write(`plugins: failed to load "${target}": ${String(err)}\n`);
    return null;
  }
}

// Scan a plugins root directory and return all loaded plugin modules.
// `cwd` is forwarded to loadPluginEntry for skill resolution in data-only plugins.
async function scanPluginsDir(dir: string, cwd: string): Promise<PluginModule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: PluginModule[] = [];
  for (const entry of entries) {
    const plugin = await loadPluginEntry(join(dir, entry), { cwd });
    if (plugin !== null) results.push(plugin);
  }
  return results;
}

// Discover user-installed plugins from:
//   <cwd>/.intercode/plugins/   (project-local)
//   ~/.intercode/plugins/       (user-global)
export async function discoverUserPlugins(cwd: string): Promise<PluginModule[]> {
  const dirs = [
    join(cwd, ".intercode", "plugins"),
    join(homedir(), ".intercode", "plugins"),
  ];
  const batches = await Promise.all(dirs.map((d) => scanPluginsDir(d, cwd)));
  return batches.flat();
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
// Relative paths resolve against cwd. Unresolvable entries are skipped.
export async function loadPluginsFromPaths(paths: string[], cwd: string): Promise<PluginModule[]> {
  const loaded = await Promise.all(
    paths.map((p) => loadPluginEntry(isAbsolute(p) ? p : join(cwd, p), { cwd })),
  );
  return loaded.filter((m): m is PluginModule => m !== null);
}

// Discover built-in repo plugins from the plugins/ directory that lives
// alongside this source file (two levels up: src/plugins/ -> plugins/).
// Repo plugins resolve skills against the session cwd, not the repo root,
// so a project's bundled skills still win when Intercode is invoked from a
// different working directory.
export async function discoverRepoPlugins(cwd: string): Promise<PluginModule[]> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const pluginsDir = join(repoRoot, "plugins");
  return scanPluginsDir(pluginsDir, cwd);
}
