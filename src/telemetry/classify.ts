// Every identifier a product event would like to carry originates where a
// user, project, MCP server, or plugin author can name it — and on a private
// repo those names are an employer, an internal service, or a path fragment.
// So none are transmitted: each is matched against a fixed list of names this
// repo ships and reported as that name, or as "custom". What leaves the
// process is a first-party enum: that something unrecognised was used, never
// what it was called.

import { DIRECTOR_IDS } from "../agent/directors/types.js";
import { isHttpServer } from "../mcp/is-http-server.js";
import { isMcpToolName } from "../mcp/tool-name.js";

const CUSTOM = "custom";

// Built-in tool ids the gate can raise an approval prompt for. Spelled out
// here rather than derived from the advertised-tools list, which exists to
// keep the provider cache prefix stable and would silently widen this
// allowlist if it ever included registered MCP or plugin tools.
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
  "skill_search",
  "web_fetch",
  "web_search",
  "write_file",
]);

// Slash commands registered by src/tui/commands/built-in.ts. Plugins
// register into the same registry, so an unlisted name is plugin-authored.
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
const BUILT_IN_AGENT_NAMES: ReadonlySet<string> = new Set([
  ...DIRECTOR_IDS,
  "worker",
]);

// First-party skills reportable by name: bundled `corbits-skills` names we
// ship ourselves, so reporting one cannot identify the operator. The manifest
// carries only the plugin id and kind — no skill list — so the closed set is
// spelled out here and pinned by src/telemetry/product-events.test.ts.
// `user-invocable: false` is a slash-surface flag, not a telemetry flag:
// background skills stay loadable by name, and a bundled skill outside the
// set reports `custom` (conservative under-reporting, never a leak). Project-
// or plugin-authored skills are never reported by name.
const FIRST_PARTY_SKILL_NAMES: ReadonlySet<string> = new Set([
  "corbits",
  "corbits-hub-libs",
  "corbits-inference",
  "corbits-system-one",
  "corbits-tools",
  "corbits-ui-apps",
  "docs",
  "git-worktrees",
  "implement",
  "interchange",
  "interchange-agents",
  "interchange-client-apps",
  "interchange-embed-hub",
  "interchange-hub-api",
  "interchange-hub-setup",
  "interchange-chat",
  "interchange-run-modes",
  "interchange-workflows",
  "interview",
  "issue",
  "plan",
  "pull-request",
  "refactor",
  "review",
  "typescript",
]);

// Language-defined error constructors. A subclass name is application or
// plugin code and as identifying as any author-chosen string.
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

// MCP tools collapse to one bucket rather than "custom" so the MCP-driven
// share of prompts stays legible without the server key.
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

export function classifySkillName(skillName: string): string {
  return FIRST_PARTY_SKILL_NAMES.has(skillName) ? skillName : CUSTOM;
}

export function classifyErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "non_error";
  return STANDARD_ERROR_NAMES.has(error.constructor.name)
    ? error.constructor.name
    : CUSTOM;
}

// First-party provider enum shared by auth_failure and auth_success. The
// success path classifies structured setup data (OAuth kind, or the picked
// preset's protocol flag) — never the settings catalog name (operator-
// authored free text), which always buckets to "other".
export type AuthProvider = "codex" | "xai" | "anthropic" | "other";

export function classifyAuthProvider(value: string): AuthProvider {
  switch (value) {
    case "codex":
      return "codex";
    case "xai":
      return "xai";
    case "anthropic":
      return "anthropic";
    default:
      return "other";
  }
}

// MCP connect-path transport. Delegates to the same predicate the trust
// prompt and connectMCPServer use, so the reported transport is the one
// actually opened — never the server name, URL, or command. Callers pass the
// full server config; only the routing fields are read.
export type McpTransport = "http" | "stdio";

export function classifyMcpTransport(config: {
  type?: "stdio" | "http";
  url?: string;
  command?: string;
}): McpTransport {
  return isHttpServer(config) ? "http" : "stdio";
}

// Settled outcome of one MCP server connection attempt. The error text is
// provider- or OS-authored (paths, URLs, profiles), so only its shape is
// reported: offered-but-unfinished browser auth, an aborted/timed-out dial,
// or a plain failure.
export type McpConnectResult = "ok" | "auth" | "timeout" | "fail";

const CONNECT_TIMEOUT_MESSAGE = /\btimeout\b|\btimed out\b|\babort/i;

export function classifyMcpConnectResult(outcome: {
  ok: boolean;
  authPending?: boolean;
  error?: string;
}): McpConnectResult {
  if (outcome.ok) return "ok";
  if (outcome.authPending === true) return "auth";
  if (
    outcome.error !== undefined &&
    CONNECT_TIMEOUT_MESSAGE.test(outcome.error)
  )
    return "timeout";
  return "fail";
}

// Outcome of one MCP browser-OAuth callback wait when no code arrived. An
// expired wait is a timeout; an abandoned wait or provider denial
// (access_denied and friends) is the operator not completing the flow.
export type McpOAuthResult = "completed" | "cancelled" | "timeout";

const OAUTH_TIMEOUT_MESSAGE = /\btimed out\b/i;

export function classifyMcpOAuthResult(err: unknown): "cancelled" | "timeout" {
  if (err instanceof Error && OAUTH_TIMEOUT_MESSAGE.test(err.message))
    return "timeout";
  return "cancelled";
}
