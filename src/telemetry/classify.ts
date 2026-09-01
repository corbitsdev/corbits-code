// Every identifier a product event would like to carry originates somewhere a
// user, a project, an MCP server, or a plugin author can name: an MCP server
// key is a settings key, a skill is a directory under the repo, a plugin id is
// author-chosen, an agent profile is project-local, a slash command can be
// registered by a plugin. On a private repo those names are the employer, an
// internal service, or a path fragment.
//
// So none of them are transmitted. Each is matched against a fixed list of
// names this repo itself ships and reported as that name, or as "custom" when
// it matches nothing. What leaves the process is a first-party enum: the fact
// that something unrecognised was used, never what it was called.

import { DIRECTOR_IDS } from "../agent/directors/types.js";
import { isMcpToolName } from "../mcp/tool-name.js";

const CUSTOM = "custom";

// Built-in tool ids the gate can raise an approval prompt for. Deliberately
// spelled out here rather than derived from the advertised-tools list, which
// exists to keep the provider cache prefix stable and would silently widen
// this allowlist the day it starts including registered MCP or plugin tools.
const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ask_operator",
  "delete_file",
  "edit_file",
  "grep",
  "list_dir",
  "lsp",
  "manage_tasks",
  "present",
  "read_file",
  "run_shell",
  "search_agents",
  "search_files",
  "spawn_agent",
  "wait_agents",
  "tool_search",
  "use_skill",
  "web_fetch",
  "web_search",
  "write_file",
]);

// Slash commands registered by src/tui/commands/built-in.ts. Plugins register
// into the same registry, so an unlisted name is plugin-authored.
const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "changelog",
  "clear",
  "cost",
  "feedback",
  "goal",
  "help",
  "hooks",
  "mcp",
  "model",
  "new",
  "paste-image",
  "permissions",
  "plugins",
  "rename",
  "settings",
  "status",
]);

// First-party director ids from the closed fleet package, plus the legacy
// "worker" label the runtime still supplies as a fallback. Project/plugin
// profile ids are never reported by name.
const BUILT_IN_AGENT_NAMES: ReadonlySet<string> = new Set([...DIRECTOR_IDS, "worker"]);

// Error constructors defined by the language. A subclass name is application
// or plugin code and can be as identifying as any other author-chosen string.
const STANDARD_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

// MCP tools collapse to a single bucket rather than "custom" so the share of
// prompts driven by MCP stays legible without the server key coming with it.
export function classifyPermissionKind(toolName: string): string {
  if (BUILT_IN_TOOL_NAMES.has(toolName)) return toolName;
  if (isMcpToolName(toolName)) return "mcp";
  return CUSTOM;
}

export function classifyCommandName(commandName: string): string {
  return BUILT_IN_COMMAND_NAMES.has(commandName) ? commandName : CUSTOM;
}

export function classifyAgentName(agentName: string): string {
  return BUILT_IN_AGENT_NAMES.has(agentName) ? agentName : CUSTOM;
}

export function classifyErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "non_error";
  return STANDARD_ERROR_NAMES.has(error.constructor.name) ? error.constructor.name : CUSTOM;
}
