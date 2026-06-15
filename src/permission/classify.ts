import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { ToolCall } from "@intx/types/runtime";
import type { ApprovalScope, PermissionRequest } from "./types.js";
import { splitChainedCommand, deriveCommandScopes, tokenize } from "./command.js";
import { isMcpToolName, humanizeMcpTool } from "../mcp/tool-name.js";
import { isSensitivePath } from "../plugins/secret-guard-plugin.js";

// Read-only tools never need approval; they cannot change the workspace. Every
// other posix tool is consequential and defaults to the "ask" tier. Catastrophic
// commands are denied earlier by the authorization plugin, so they never reach
// here.
const ALLOW_TOOLS = new Set(["read_file", "search_files", "grep", "list_dir"]);

// Allow-tier tools that take a `path` argument. When that path is restricted
// (gitignored or under .agent-state) the gate drops them from allow to ask.
const READ_PATH_TOOLS = new Set(["read_file", "search_files", "grep", "list_dir"]);

export type Tier = "allow" | "ask";

export function classifyTool(toolName: string): Tier {
  return ALLOW_TOOLS.has(toolName) ? "allow" : "ask";
}

// The restricted `path` argument of a read-path tool call, or undefined when the
// call has no path or the path is not restricted. grep/search_files without a
// path scan the whole workspace and are not treated as restricted — ripgrep
// already skips gitignored files, so a workspace-wide search stays allow-tier.
export function restrictedReadPath(
  call: ToolCall,
  isRestricted: (path: string) => boolean,
): string | undefined {
  if (!READ_PATH_TOOLS.has(call.name)) return undefined;
  const path = stringArg(call, "path");
  if (path.length === 0) return undefined;
  return isRestricted(path) ? path : undefined;
}

// Whether a shell command reads through a restricted path. Tokenised so a bare
// `cat .agent-state/run.json` is caught; flags are ignored since they are not
// path arguments.
export function commandTargetsRestricted(
  command: string,
  isRestricted: (path: string) => boolean,
): boolean {
  return tokenize(command)
    .filter((token) => !token.startsWith("-"))
    .some((token) => isRestricted(token));
}

export function callTargetsRestricted(
  call: ToolCall,
  isRestricted: (path: string) => boolean,
): boolean {
  if (call.name === "run_shell") return commandTargetsRestricted(stringArg(call, "command"), isRestricted);
  return restrictedReadPath(call, isRestricted) !== undefined;
}

const SAFE_SHELL_PROGRAMS = new Set([
  "cat", "head", "tail", "wc", "cut", "tr", "nl", "rev", "column", "uniq", "sort", "comm", "look",
  "ls", "tree", "stat", "file", "du", "df", "basename", "dirname", "realpath", "readlink",
  "echo", "printf", "date", "whoami", "hostname", "uname", "pwd", "which", "type", "id",
  "grep", "rg", "fgrep", "egrep", "od", "xxd", "strings", "find",
]);

// `find` traverses read-only unless an action flag runs a command (-exec/-ok and
// their *dir variants), deletes matches (-delete), or writes results to a file
// (-fprint*/-fls). Its own `-o` is logical OR, not an output flag, so `find`
// gets this rule instead of the generic WRITE_FLAG/EXEC_FLAG checks below.
const FIND_DANGEROUS_FLAG = /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/;

// Non-pipe metacharacters that cannot appear anywhere in an auto-allowed command.
// Pipes between safe programs are evaluated segment-by-segment (see below).
const DANGEROUS_METACHARACTERS = /[&;<>`$(){}]|\\\n|\n/;
const WRITE_FLAG = /^(-o|--output)(=|$)/;

// Flags on grep/rg that run an arbitrary binary on each matched file or before
// the search, turning a "safe" search into arbitrary code execution.
const EXEC_FLAG = /^(--pre|--pre-glob|--hostname-bin|--search-zip|-z)(=|$)/;

// A safe read command auto-runs only when every path-like argument stays inside
// the workspace. Containment — not a secret-name denylist — is the real
// invariant: it stops `cat /etc/passwd`, `xxd ~/.aws/config`, and
// `strings /proc/self/environ` from auto-reading any file on the host. The
// secret guard remains a hard-deny backstop for secrets that live inside cwd.
function escapesWorkspace(token: string, cwd: string): boolean {
  if (token.startsWith("~")) return true;
  const target = resolve(cwd, token);
  let realTarget = target;
  try {
    realTarget = realpathSync(target);
  } catch {
    realTarget = target;
  }
  let realCwd = cwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  return realTarget !== realCwd && !realTarget.startsWith(realCwd + sep);
}

// grep/rg read a file through a flag value (`--file=PATH`, `-fPATH`), so a path
// glued to a flag escapes the positional containment check. Surface that glued
// value so it gets the same workspace-containment treatment as a bare argument.
function flagPathValue(token: string): string | null {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    return eq === -1 ? null : token.slice(eq + 1);
  }
  const glued = /^-f(.+)$/.exec(token);
  return glued !== null ? (glued[1] ?? null) : null;
}

function argEscapesWorkspace(token: string, cwd: string): boolean {
  if (!token.startsWith("-")) return escapesWorkspace(token, cwd);
  const value = flagPathValue(token);
  return value !== null && value.length > 0 && escapesWorkspace(value, cwd);
}

function isAutoAllowedSegment(segment: string, cwd: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  // Quote-aware so a dangerous flag cannot hide behind quotes the shell strips
  // (e.g. find . '-delete'). A naive whitespace split leaves the quotes on the
  // token, defeating the anchored flag checks below.
  const tokens = tokenize(trimmed);
  const program = tokens[0] ?? "";
  if (!SAFE_SHELL_PROGRAMS.has(program)) return false;
  const args = tokens.slice(1);
  if (program === "find") {
    if (args.some((token) => FIND_DANGEROUS_FLAG.test(token))) return false;
  } else {
    if (args.some((token) => WRITE_FLAG.test(token))) return false;
    if (args.some((token) => EXEC_FLAG.test(token))) return false;
  }
  if (args.some((token) => isSensitivePath(token))) return false;
  if (args.some((token) => argEscapesWorkspace(token, cwd))) return false;
  return true;
}

export function isAutoAllowedShellCommand(command: string, cwd: string = process.cwd()): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // Reject anything with metacharacters that compose or redirect (& ; < > ` $ etc).
  // Pipes are allowed between safe segments — evaluated below.
  if (DANGEROUS_METACHARACTERS.test(trimmed)) return false;

  // Split on pipe and require every segment to be a safe read-only program.
  const segments = trimmed.split("|");
  return segments.every((seg) => isAutoAllowedSegment(seg, cwd));
}

export function isAutoAllowedShellCall(call: ToolCall, cwd: string = process.cwd()): boolean {
  if (call.name !== "run_shell") return false;
  return isAutoAllowedShellCommand(stringArg(call, "command"), cwd);
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
  // A read-path tool only reaches here when its target is restricted (gitignored
  // or under .agent-state). Key the request on the path so approving it grants
  // that path or directory, not every future read.
  if (READ_PATH_TOOLS.has(call.name)) {
    const path = stringArg(call, "path");
    return [{ tool: call.name, action: "Read restricted path", subject: path, arguments: call.arguments, scopes: fileScopes(path) }];
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
