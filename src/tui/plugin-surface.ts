import type { PluginConfig } from "../config/settings.js";
import type { PluginModule } from "../plugins/loader.js";
import { isPluginModuleEnabled } from "../plugins/register.js";

export function isPluginEnabledForSurface(
  plugin: PluginModule | undefined,
  config: Record<string, PluginConfig | undefined>,
): boolean {
  return plugin !== undefined && isPluginModuleEnabled(plugin, config);
}
