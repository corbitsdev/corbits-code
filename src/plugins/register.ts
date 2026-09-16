import type { PluginModule } from "./loader.js";
import type { PluginConfig } from "../config/settings.js";
import { registerCommandPlugin } from "../tui/commands/registry.js";
import { registerWorkflowPlugin } from "../workflows/index.js";

export function isPluginEnabled(
  config: Record<string, PluginConfig>,
  id: string,
): boolean {
  return config[id]?.enabled === true;
}

// Enablement for a loaded module: explicit settings win; otherwise only a
// first-party repo plugin with manifest.defaultEnabled turns on. Marketplace
// (user), path, and project plugins cannot self-enable via the flag — except
// when dedupePluginModules stamped shadowedRepoDefaultEnabled, meaning this
// module's id shadowed a repo defaultEnabled plugin during discovery dedupe;
// the bundled default-on survives the shadowing (CL-6716).
export function isPluginModuleEnabled(
  mod: PluginModule,
  config: Record<string, PluginConfig | undefined>,
): boolean {
  const id = mod.manifest?.id;
  if (id === undefined) return false;
  const enabled = config[id]?.enabled;
  if (enabled === true) return true;
  if (enabled === false) return false;
  return (
    (mod.origin === "repo" && mod.manifest?.defaultEnabled === true) ||
    mod.shadowedRepoDefaultEnabled === true
  );
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

function isCommandPluginModule(mod: PluginModule): boolean {
  if (mod.commandPlugin === undefined) return false;
  const kind = mod.manifest?.kind;
  // command/workflow plugins own their slash commands; agent plugins may also
  // contribute commands (e.g. a Claude marketplace plugin's tagged skills), so
  // commands wire as an added surface without changing the plugin's primary kind.
  return kind === "command" || kind === "workflow" || kind === "agent";
}

export function isEnabledCommandPlugin(
  mod: PluginModule,
  config: Record<string, PluginConfig>,
): boolean {
  return isCommandPluginModule(mod) && isPluginModuleEnabled(mod, config);
}

export function isEnabledWorkflowPlugin(
  mod: PluginModule,
  config: Record<string, PluginConfig>,
): boolean {
  return (
    mod.manifest?.kind === "workflow" &&
    mod.workflowPlugin !== undefined &&
    isPluginModuleEnabled(mod, config)
  );
}

export function registerCommandPluginModule(
  mod: PluginModule,
  getConfig: () => Record<string, PluginConfig>,
): boolean {
  if (!isCommandPluginModule(mod)) return false;
  const commandPlugin = mod.commandPlugin;
  if (commandPlugin === undefined) return false;
  registerCommandPlugin(
    commandPlugin,
    () => isPluginModuleEnabled(mod, getConfig()),
    mod.origin,
  );
  return true;
}

export function registerCommandPlugins(
  modules: PluginModule[],
  config: Record<string, PluginConfig> | (() => Record<string, PluginConfig>),
): string[] {
  const getConfig = typeof config === "function" ? config : () => config;
  return collectEnabledModules(modules, (mod) => {
    const id = mod.manifest?.id;
    if (id === undefined || !registerCommandPluginModule(mod, getConfig))
      return undefined;
    return isPluginModuleEnabled(mod, getConfig()) ? id : undefined;
  });
}

export function registerWorkflowPlugins(
  modules: PluginModule[],
  config: Record<string, PluginConfig>,
): string[] {
  return collectEnabledModules(modules, (mod) => {
    if (!isEnabledWorkflowPlugin(mod, config)) return undefined;
    const workflowPlugin = mod.workflowPlugin;
    const id = mod.manifest?.id;
    if (workflowPlugin === undefined || id === undefined) return undefined;
    registerWorkflowPlugin(workflowPlugin);
    return id;
  });
}

// Shared register loop: each module is offered to `collect`, which performs
// that kind's registration side effects and returns the manifest id exactly
// when the module counts as registered, or undefined to skip it. One pass in
// module order; per-kind predicates stay at the call sites above.
function collectEnabledModules(
  modules: PluginModule[],
  collect: (mod: PluginModule) => string | undefined,
): string[] {
  const registered: string[] = [];
  for (const mod of modules) {
    const id = collect(mod);
    if (id !== undefined) registered.push(id);
  }
  return registered;
}
