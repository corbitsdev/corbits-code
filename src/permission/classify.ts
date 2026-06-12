import type { ToolCall } from "@intx/types/runtime";
import type { ApprovalScope, PermissionRequest } from "./types.js";
import { splitChainedCommand, deriveCommandScopes } from "./command.js";
import { isMcpToolName, humanizeMcpTool } from "../mcp/tool-name.js";

// Read-only tools never need approval; they cannot change the workspace. Every
// other posix tool is consequential and defaults to the "ask" tier. Catastrophic
// commands are denied earlier by the authorization plugin, so they never reach
// here.
const ALLOW_TOOLS = new Set(["read_file", "search_files", "grep", "list_dir"]);

export type Tier = "allow" | "ask";

export function classifyTool(toolName: string): Tier {
  return ALLOW_TOOLS.has(toolName) ? "allow" : "ask";
}

const SAFE_SHELL_PROGRAMS = new Set([
  "cat", "head", "tail", "wc", "cut", "tr", "nl", "rev", "column", "uniq", "sort", "comm", "look",
  "ls", "tree", "stat", "file", "du", "df", "basename", "dirname", "realpath", "readlink",
  "echo", "printf", "date", "whoami", "hostname", "uname", "pwd", "which", "type", "printenv", "id",
  "grep", "rg", "fgrep", "egrep", "od", "xxd", "strings",
]);

const SHELL_METACHARACTERS = /[|&;<>`$(){}]|\\\n|\n/;
const WRITE_FLAG = /^(-o|--output)(=|$)/;

export function isAutoAllowedShellCall(call: ToolCall): boolean {
  if (call.name !== "run_shell") return false;
  const command = stringArg(call, "command").trim();
  if (command.length === 0) return false;
  if (SHELL_METACHARACTERS.test(command)) return false;

  const tokens = command.split(/\s+/);
  const program = tokens[0] ?? "";
  if (!SAFE_SHELL_PROGRAMS.has(program)) return false;
  if (tokens.some((token) => WRITE_FLAG.test(token))) return false;

  return true;
}

// File scopes intentionally stop at the directory level. There is no "every
// file" rung: a persisted "*" would silently authorize all future writes/edits
// in the directory, which is too blunt to offer as a one-keystroke choice.
function fileScopes(path: string): ApprovalScope[] {
  const scopes: ApprovalScope[] = [{ id: "exact", label: `Allow Always (this file)`, pattern: path }];
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const dir = path.slice(0, slash);
    scopes.push({ id: "dir", label: `Allow Always (this directory)`, pattern: `${dir}/*` });
  }
  return scopes;
}

function stringArg(call: ToolCall, key: string): string {
  const value = call.arguments[key];
  return typeof value === "string" ? value : "";
}

// Decompose an "ask"-tier tool call into the discrete approval requests it needs.
// A chained shell command yields one request per segment so each is judged on
// its own; file tools yield a single request keyed on the target path.
export function buildRequests(call: ToolCall): PermissionRequest[] {
  if (call.name === "run_shell") {
    const command = stringArg(call, "command");
    return splitChainedCommand(command).map((segment) => ({
      tool: "run_shell",
      action: "Run shell command",
      subject: segment,
      arguments: { command: segment },
      scopes: deriveCommandScopes(segment),
    }));
  }
  if (call.name === "write_file" || call.name === "edit_file") {
    const path = stringArg(call, "path");
    const action = call.name === "write_file" ? "Write file" : "Edit file";
    return [{ tool: call.name, action, subject: path, arguments: call.arguments, scopes: fileScopes(path) }];
  }
  // Any other consequential tool: approve as a whole, remember by tool name.
  // MCP tools are presented by their human label; the raw mcp__ identifier stays
  // as the (hidden) subject and persisted pattern so matching is unaffected.
  const mcp = isMcpToolName(call.name);
  const label = mcp ? humanizeMcpTool(call.name) : call.name;
  return [
    {
      tool: call.name,
      action: mcp ? "Run MCP tool" : `Run ${call.name}`,
      subject: call.name,
      arguments: call.arguments,
      scopes: [
        { id: "tool", label: `Always allow ${label}`, pattern: call.name, ...(mcp ? { hint: label } : {}) },
      ],
    },
  ];
}
