import type { ToolCall } from "@intx/types/runtime";
import type { ApprovalScope, PermissionRequest } from "./types.js";
import { splitChainedCommand, deriveCommandScopes } from "./command.js";

// Read-only tools never need approval; they cannot change the workspace. Every
// other posix tool is consequential and defaults to the "ask" tier. Catastrophic
// commands are denied earlier by the authorization plugin, so they never reach
// here.
const ALLOW_TOOLS = new Set(["read_file", "search_files", "grep", "list_dir"]);

export type Tier = "allow" | "ask";

export function classifyTool(toolName: string): Tier {
  return ALLOW_TOOLS.has(toolName) ? "allow" : "ask";
}

function fileScopes(path: string): ApprovalScope[] {
  const scopes: ApprovalScope[] = [{ id: "exact", label: `Always allow this file`, pattern: path }];
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const dir = path.slice(0, slash);
    scopes.push({ id: "dir", label: `Always allow files in ${dir}/`, pattern: `${dir}/*` });
  }
  scopes.push({ id: "all", label: `Always allow every file`, pattern: "*" });
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
      scopes: deriveCommandScopes(segment),
    }));
  }
  if (call.name === "write_file" || call.name === "edit_file") {
    const path = stringArg(call, "path");
    const action = call.name === "write_file" ? "Write file" : "Edit file";
    return [{ tool: call.name, action, subject: path, scopes: fileScopes(path) }];
  }
  // Any other consequential tool: approve as a whole, remember by tool name.
  return [
    {
      tool: call.name,
      action: `Run ${call.name}`,
      subject: call.name,
      scopes: [{ id: "tool", label: `Always allow ${call.name}`, pattern: call.name }],
    },
  ];
}
