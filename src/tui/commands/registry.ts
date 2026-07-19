import type { ProviderTier } from "../../config/settings.js";
import type { GoalSnapshot, GoalSetOpts, GoalResumeOpts } from "../../agent/goal.js";

export type CommandContext = {
  signalClear: () => void;
  getMCPServers?: () => Array<{ name: string; tools: string[] }>;
  // Start a workflow by name; returns a status message to surface to the user.
  startWorkflow?: (name: string) => string;
  /** Rename the active session (persisted as run.json task). */
  renameSession?: (name: string) => string | undefined;
  /** Goal mode operator surface (CL-3936/CL-3937). */
  goal?: {
    get: () => GoalSnapshot | null;
    set: (condition: string, opts?: GoalSetOpts) => GoalSnapshot;
    pause: () => GoalSnapshot | null;
    resume: (opts?: GoalResumeOpts) => GoalSnapshot | null;
    clear: () => void;
    /** Kick off a turn after set/resume so the agent starts working immediately. */
    kickoff?: (condition: string) => void;
  };
};

export type CommandResult =
  | { type: "message"; text: string }
  | { type: "send"; text: string }
  | { type: "view"; view: "tasks" }
  | { type: "overlay"; overlay: "help" | "permissions" | "plugins" | "settings" }
  | { type: "modal"; modal: "agent" | "codex-login" | "xai-login" | "login" }
  | { type: "workflow"; name: string; args?: string }
  | { type: "paste-image" }
  | { type: "tier"; tier: ProviderTier }
  | { type: "noop" };

export type SubcommandDefinition = {
  name: string;
  description: string;
};

export type CommandDefinition = {
  name: string;
  description: string;
  /**
   * Claude Code–compatible free-form arg guidance (frontmatter `argument-hint`).
   * Shown greyed next to the command and after `/cmd ` until the operator types.
   * Never inserted into the prompt on Tab.
   */
  argumentHint?: string;
  subcommands?: readonly SubcommandDefinition[];
  handler: (args: string, ctx: CommandContext) => CommandResult;
  // Optional visibility gate. When present and returns false the command is
  // omitted from listCommands (the slash menu) but still callable via
  // getCommand — so a tier command stays resolvable even mid-reconfigure.
  available?: () => boolean;
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
    .filter((c) => !hidden.has(c.name) && (c.available === undefined || c.available()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read Claude-style `argument-hint` from parsed frontmatter. */
export function argumentHintFromFrontmatter(frontmatter: Record<string, unknown>): string | undefined {
  const raw = frontmatter["argument-hint"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
