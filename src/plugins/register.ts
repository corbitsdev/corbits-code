import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import { registerCommandPlugin } from "../tui/commands/registry.js";
import { registerWorkflowPlugin } from "../workflows/index.js";

export function isPluginEnabled(config: Record<string, PluginConfig>, id: string): boolean {
  return config[id]?.enabled === true;
}

// Enablement for a loaded module: explicit settings win; otherwise only a
// first-party repo plugin with manifest.defaultEnabled turns on. Marketplace
// (user), path, and project plugins cannot self-enable via the flag.
export function isPluginModuleEnabled(
  mod: PluginModule,
  config: Record<string, PluginConfig | undefined>,
): boolean {
  const id = mod.manifest?.id;
  if (id === undefined) return false;
  const enabled = config[id]?.enabled;
  if (enabled === true) return true;
  if (enabled === false) return false;
  return mod.origin === "repo" && mod.manifest?.defaultEnabled === true;
}

// Mark a plugin enabled while preserving credentials/consented and other fields.
// Path-add and similar consent actions must call this so restart re-wires slash
// commands (isPluginEnabled is strict: missing entry === disabled).
export function enablePluginConfig(
  config: Record<string, PluginConfig>,
  id: string,
): Record<string, PluginConfig> {
  const prev = config[id] ?? {};
  return { ...config, [id]: { ...prev, enabled: true } };
}

export function isEnabledCommandPlugin(mod: PluginModule, config: Record<string, PluginConfig>): boolean {
  if (mod.commandPlugin === undefined) return false;
  const kind = mod.manifest?.kind;
  // command/workflow plugins own their slash commands; agent plugins may also
  // contribute commands (e.g. a Claude marketplace plugin's tagged skills), so
  // commands wire as an added surface without changing the plugin's primary kind.
  return (
    (kind === "command" || kind === "workflow" || kind === "agent") &&
    isPluginModuleEnabled(mod, config)
  );
}

export function isEnabledWorkflowPlugin(mod: PluginModule, config: Record<string, PluginConfig>): boolean {
  return (
    mod.manifest?.kind === "workflow" &&
    mod.workflowPlugin !== undefined &&
    isPluginModuleEnabled(mod, config)
  );
}

export function registerCommandPlugins(
  modules: PluginModule[],
  config: Record<string, PluginConfig>,
): string[] {
  const registered: string[] = [];
  for (const mod of modules) {
    if (!isEnabledCommandPlugin(mod, config)) continue;
    registerCommandPlugin(mod.commandPlugin!);
    registered.push(mod.manifest!.id);
  }
  return registered;
}

export function registerWorkflowPlugins(
  modules: PluginModule[],
  config: Record<string, PluginConfig>,
): string[] {
  const registered: string[] = [];
  for (const mod of modules) {
    if (!isEnabledWorkflowPlugin(mod, config)) continue;
    registerWorkflowPlugin(mod.workflowPlugin!);
    registered.push(mod.manifest!.id);
  }
  return registered;
}