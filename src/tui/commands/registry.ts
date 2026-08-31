import type { CostSummary } from "../../cost/cost-summary.js";

export interface CommandContext {
  signalClear: () => void;
  getCostSummary?: () => CostSummary;
  /**
   * One-row answer to "where are we" on the dispatched fleet. Read live and
   * answered locally, so asking never costs the operator an interrupt (and
   * with it whatever they had queued).
   */
  getFleetStatus?: () => string;
  // Start a workflow by name; returns a status message to surface to the user.
  startWorkflow?: (name: string) => string;
  /** Rename the active session (persisted as run.json task). */
  renameSession?: (name: string) => string | undefined;
  /**
   * Submit intentional operator feedback (PostHog survey). Returns the
   * operator-facing status line. Wired by the TUI runner.
   */
  submitFeedback?: (text: string) => string;
  /**
   * Arm multi-turn feedback capture: the next non-command submit is treated as
   * the feedback body instead of a model prompt.
   */
  beginFeedbackCapture?: () => void;
  /** Whether skip-permissions (yolo) is active for this session. */
  getSkipPermissions?: () => boolean;
  /** Live-flip skip-permissions and persist `/yolo` as the user-global default. */
  setSkipPermissions?: (value: boolean) => void;
}

export type CommandResult =
  | { type: "message"; text: string }
  | { type: "send"; text: string }
  | { type: "view"; view: "tasks" }
  | { type: "overlay"; overlay: "help" | "permissions" | "plugins" | "settings" | "hooks" | "mcp" }
  | { type: "modal"; modal: "agent" | "codex-login" | "xai-login" }
  | { type: "workflow"; name: string; args?: string }
  | { type: "paste-image" }
  | { type: "noop" };

export interface SubcommandDefinition {
  name: string;
  description: string;
}

export interface CommandDefinition {
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
  // getCommand.
  available?: () => boolean;
}

export interface CommandPlugin {
  commands: CommandDefinition[];
}

interface PluginCommandCandidate {
  command: CommandDefinition;
  isActive: () => boolean;
}

const registry = new Map<string, CommandDefinition>();
const pluginCandidates = new Map<string, PluginCommandCandidate[]>();
const hidden = new Set<string>();

export function registerCommand(def: CommandDefinition): void {
  // First-wins: built-ins register first, then repo plugins, then marketplace.
  // A later plugin must not overwrite /implement (or any other claimed name).
  if (registry.has(def.name)) return;
  registry.set(def.name, def);
}

export function registerCommandPlugin(
  plugin: CommandPlugin,
  isActive: () => boolean = () => true,
): void {
  for (const cmd of plugin.commands) {
    const candidates = pluginCandidates.get(cmd.name) ?? [];
    candidates.push({ command: cmd, isActive });
    pluginCandidates.set(cmd.name, candidates);
  }
}

export function setHiddenCommands(names: string[]): void {
  hidden.clear();
  for (const n of names) hidden.add(n);
}

export function getCommand(name: string): CommandDefinition | undefined {
  const registered = registry.get(name);
  if (registered !== undefined) return registered;
  return pluginCandidates.get(name)?.find((candidate) => candidate.isActive())?.command;
}

export function listCommands(): CommandDefinition[] {
  const commands = [...registry.values()];
  for (const name of pluginCandidates.keys()) {
    if (registry.has(name)) continue;
    const command = getCommand(name);
    if (command !== undefined) commands.push(command);
  }
  return commands
    .filter((c) => !hidden.has(c.name) && (c.available === undefined || c.available()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read Claude-style `argument-hint` from parsed frontmatter. */
export function argumentHintFromFrontmatter(
  frontmatter: Record<string, unknown>,
): string | undefined {
  const raw = frontmatter["argument-hint"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
