import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import { registerCommandPlugin } from "../tui/commands/registry.js";
import { registerWorkflowPlugin } from "../workflows/index.js";

export function isPluginEnabled(config: Record<string, PluginConfig>, id: string): boolean {
  return config[id]?.enabled === true;
}

export function isEnabledCommandPlugin(mod: PluginModule, config: Record<string, PluginConfig>): boolean {
  if (mod.commandPlugin === undefined) return false;
  const kind = mod.manifest?.kind;
  return (
    (kind === "command" || kind === "workflow") &&
    isPluginEnabled(config, mod.manifest!.id)
  );
}

export function isEnabledWorkflowPlugin(mod: PluginModule, config: Record<string, PluginConfig>): boolean {
  return (
    mod.manifest?.kind === "workflow" &&
    mod.workflowPlugin !== undefined &&
    isPluginEnabled(config, mod.manifest.id)
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