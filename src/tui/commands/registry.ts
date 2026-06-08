export type CommandContext = {
  getVerbose: () => boolean;
  toggleVerbose: () => boolean;
  signalClear: () => void;
  getMCPServers?: () => Array<{ name: string; tools: string[] }>;
};

export type CommandResult =
  | { type: "message"; text: string }
  | { type: "send"; text: string }
  | { type: "view"; view: "plan" | "diff" }
  | { type: "overlay"; overlay: "help" }
  | { type: "modal"; modal: "agent" }
  | { type: "noop" };

export type CommandDefinition = {
  name: string;
  description: string;
  handler: (args: string, ctx: CommandContext) => CommandResult;
};

const registry = new Map<string, CommandDefinition>();

export function registerCommand(def: CommandDefinition): void {
  registry.set(def.name, def);
}

export function getCommand(name: string): CommandDefinition | undefined {
  return registry.get(name);
}

export function listCommands(): CommandDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}
