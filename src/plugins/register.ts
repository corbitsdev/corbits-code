import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import { registerCommandPlugin } from "../tui/commands/registry.js";

// A discovered plugin is only wired in when explicitly enabled in settings.
export function isPluginEnabled(config: Record<string, PluginConfig>, id: string): boolean {
  return config[id]?.enabled === true;
}

// Whether a module is an enabled command plugin (manifest kind "command" with a
// commandPlugin export and an enabled config entry).
export function isEnabledCommandPlugin(mod: PluginModule, config: Record<string, PluginConfig>): boolean {
  return (
    mod.manifest?.kind === "command" &&
    mod.commandPlugin !== undefined &&
    isPluginEnabled(config, mod.manifest.id)
  );
}

// Register every enabled command plugin's slash commands. Routing by kind keeps
// web (and, later, tool) wiring in their own resolvers. Returns the registered
// plugin ids for logging / live UI feedback.
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
