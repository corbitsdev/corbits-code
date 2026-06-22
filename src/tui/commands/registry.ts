export type CommandContext = {
  signalClear: () => void;
  getMCPServers?: () => Array<{ name: string; tools: string[] }>;
  // Start a workflow by name; returns a status message to surface to the user.
  startWorkflow?: (name: string) => string;
  /** Rename the active session (persisted as run.json task). */
  renameSession?: (name: string) => string | undefined;
};

export type CommandResult =
  | { type: "message"; text: string }
  | { type: "send"; text: string }
  | { type: "skill"; skill: string; text?: string }
  | { type: "view"; view: "tasks" }
  | { type: "overlay"; overlay: "help" | "permissions" | "plugins" | "settings" }
  | { type: "modal"; modal: "agent" | "codex-login" | "xai-login" | "login" }
  | { type: "workflow"; name: string; args?: string }
  | { type: "noop" };

export type SubcommandDefinition = {
  name: string;
  description: string;
};

export type CommandDefinition = {
  name: string;
  description: string;
  subcommands?: readonly SubcommandDefinition[];
  handler: (args: string, ctx: CommandContext) => CommandResult;
};

export type CommandPlugin = {
  commands: CommandDefinition[];
};

const registry = new Map<string, CommandDefinition>();
const hidden = new Set<string>();

export function registerCommand(def: CommandDefinition): void {
  registry.set(def.name, def);
}

export function registerCommandPlugin(plugin: CommandPlugin): void {
  for (const cmd of plugin.commands) {
    registerCommand(cmd);
  }
}

export function setHiddenCommands(names: string[]): void {
  hidden.clear();
  for (const n of names) hidden.add(n);
}

export function getCommand(name: string): CommandDefinition | undefined {
  return registry.get(name);
}

export function listCommands(): CommandDefinition[] {
  return [...registry.values()]
    .filter((c) => !hidden.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
