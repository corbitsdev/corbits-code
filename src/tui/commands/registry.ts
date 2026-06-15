export type CommandContext = {
  getVerbose: () => boolean;
  toggleVerbose: () => boolean;
  getAuto: () => boolean;
  toggleAuto: () => boolean;
  signalClear: () => void;
  getMCPServers?: () => Array<{ name: string; tools: string[] }>;
  // Start a workflow by name; returns a status message to surface to the user.
  startWorkflow?: (name: string) => string;
  // List available workflows for /workflows.
  listWorkflows?: () => Array<{ name: string; description: string }>;
  // Open the workflow panel (Ctrl+W surface).
  openWorkflowPanel?: () => void;
  // Open the workflow picker modal (/workflows command).
  openWorkflowPicker?: () => void;
  // Enter plan mode: strips write/edit tools until submit_plan is approved.
  enterPlanMode?: () => void;
  // Show live Codex usage/quota for the active Codex profile (async; the app
  // fetches and surfaces the result). No-op / message when not on Codex.
  showCodexUsage?: () => void;
};

export type CommandResult =
  | { type: "message"; text: string }
  | { type: "send"; text: string }
  | { type: "view"; view: "plan" | "diff" }
  | { type: "overlay"; overlay: "help" | "permissions" }
  | { type: "modal"; modal: "agent" | "codex-login" }
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
