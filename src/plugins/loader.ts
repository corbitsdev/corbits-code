import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkflowPlugin } from "../workflows/types.js";
import type { CommandPlugin } from "../tui/commands/registry.js";

export type PluginModule = {
  workflowPlugin?: WorkflowPlugin;
  commandPlugin?: CommandPlugin;
  // A web provider factory: (options: unknown) => WebProvider | Promise<WebProvider>.
  // Typed as unknown here so this module doesn't pull in the full web type graph.
  createWebProvider?: unknown;
};

// Attempt to load a single plugin directory entry (a file or a directory with
// an index file). Returns null if the entry cannot be resolved to a module.
async function loadPluginEntry(entryPath: string): Promise<PluginModule | null> {
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
    const mod = await import(target) as Record<string, unknown>;
    const result: PluginModule = {};
    if (mod.workflowPlugin != null && typeof mod.workflowPlugin === "object" && "workflows" in mod.workflowPlugin) {
      result.workflowPlugin = mod.workflowPlugin as WorkflowPlugin;
    }
    if (mod.commandPlugin != null && typeof mod.commandPlugin === "object" && "commands" in mod.commandPlugin) {
      result.commandPlugin = mod.commandPlugin as CommandPlugin;
    }
    if (typeof mod.createWebProvider === "function") {
      result.createWebProvider = mod.createWebProvider;
    } else if (mod.default != null && typeof mod.default === "function") {
      result.createWebProvider = mod.default;
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

// Discover built-in repo plugins from the plugins/ directory that lives
// alongside this source file (two levels up: src/plugins/ -> plugins/).
export async function discoverRepoPlugins(): Promise<PluginModule[]> {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const pluginsDir = join(repoRoot, "plugins");
  return scanPluginsDir(pluginsDir);
}
