import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkflowPlugin } from "../workflows/types.js";
import type { CommandPlugin } from "../tui/commands/registry.js";
import { parsePluginManifest, type PluginManifest } from "./manifest.js";

export type PluginModule = {
  // Self-description (id, name, kind, credential fields), when the module
  // exports a valid `manifest`. Drives the /plugins UI and web-provider wiring.
  manifest?: PluginManifest;
  workflowPlugin?: WorkflowPlugin;
  commandPlugin?: CommandPlugin;
  // A web provider factory: (options: unknown) => WebProvider | Promise<WebProvider>.
  // Typed as unknown here so this module doesn't pull in the full web type graph.
  createWebProvider?: unknown;
  // A tool plugin factory: (options: unknown) => ToolPlugin | Promise<ToolPlugin>.
  // Typed as unknown so this module doesn't pull in the tools-posix type graph.
  createToolPlugin?: unknown;
};

// Attempt to load a single plugin directory entry (a file or a directory with
// an index file). Returns null if the entry cannot be resolved to a module.
// Exported so the /plugins UI can register a plugin from an arbitrary path.
export async function loadPluginEntry(entryPath: string): Promise<PluginModule | null> {
  let target = entryPath;
  try {
    const info = await stat(entryPath);
    if (info.isDirectory()) {
      // Prefer src/index.ts, then index.ts, then index.js.
      for (const candidate of ["src/index.ts", "index.ts", "index.js"]) {
        const candidate_path = join(entryPath, candidate);
        try {
          await stat(candidate_path);
          target = candidate_path;
          break;
        } catch {
          // not found, try next
        }
      }
      if (target === entryPath) return null;
    }
  } catch {
    return null;
  }

  try {
    // Dynamic import resolves relative specifiers against this module, not cwd,
    // so resolve to an absolute path first (callers may pass a relative path).
    const importTarget = isAbsolute(target) ? target : resolve(target);
    const mod = await import(importTarget) as Record<string, unknown>;
    const result: PluginModule = {};
    const manifest = parsePluginManifest(mod.manifest);
    if (manifest !== null) result.manifest = manifest;
    if (mod.workflowPlugin != null && typeof mod.workflowPlugin === "object" && "workflows" in mod.workflowPlugin) {
      result.workflowPlugin = mod.workflowPlugin as WorkflowPlugin;
    }
    if (mod.commandPlugin != null && typeof mod.commandPlugin === "object" && "commands" in mod.commandPlugin) {
      result.commandPlugin = mod.commandPlugin as CommandPlugin;
    }
    if (typeof mod.createWebProvider === "function") result.createWebProvider = mod.createWebProvider;
    if (typeof mod.createToolPlugin === "function") result.createToolPlugin = mod.createToolPlugin;
    // A default-exported factory maps to the factory for the manifest's kind, so
    // web and tool plugins can both just `export default`.
    if (typeof mod.default === "function") {
      if (manifest?.kind === "tool" && result.createToolPlugin === undefined) result.createToolPlugin = mod.default;
      else if (result.createWebProvider === undefined) result.createWebProvider = mod.default;
    }
    return result;
  } catch (err) {
    process.stderr.write(`plugins: failed to load "${target}": ${String(err)}\n`);
    return null;
  }
}

// Scan a plugins root directory and return all loaded plugin modules.
async function scanPluginsDir(dir: string): Promise<PluginModule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: PluginModule[] = [];
  for (const entry of entries) {
    const plugin = await loadPluginEntry(join(dir, entry));
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
  const batches = await Promise.all(dirs.map(scanPluginsDir));
  return batches.flat();
}

// Load plugins from explicit file/directory paths (from settings.pluginPaths).
// Relative paths resolve against cwd. Unresolvable entries are skipped.
export async function loadPluginsFromPaths(paths: string[], cwd: string): Promise<PluginModule[]> {
  const loaded = await Promise.all(
    paths.map((p) => loadPluginEntry(isAbsolute(p) ? p : join(cwd, p))),
  );
  return loaded.filter((m): m is PluginModule => m !== null);
}

// Discover built-in repo plugins from the plugins/ directory that lives
// alongside this source file (two levels up: src/plugins/ -> plugins/).
export async function discoverRepoPlugins(): Promise<PluginModule[]> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const pluginsDir = join(repoRoot, "plugins");
  return scanPluginsDir(pluginsDir);
}
