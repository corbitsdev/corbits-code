import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { ToolCall } from "@intx/types/runtime";
import type { ApprovalScope, PermissionRequest } from "./types.js";
import { splitChainedCommand, deriveCommandScopes, tokenize, isShellCommentOnly } from "./command.js";
import { isMcpToolName, humanizeMcpTool, isReadOnlyMcpTool } from "../mcp/tool-name.js";
import type { McpToolPermissionRegistry } from "../mcp/tool-permissions.js";
import {
  commandReferencesSensitivePath,
  isSensitivePath,
} from "../plugins/secret-guard-plugin.js";
import { runShellAuthzBlockReason, runShellAuthzSegmentBlockReason } from "../shell/run-shell-authz.js";

// Read-only tools never need approval as long as they don't touch a restricted
// path; they cannot change the workspace. `lsp` is included here even though
// it is activated dynamically mid-session (see director.ts onActivateTools) —
// hover/definition/reference lookups are as inert as a grep. Every other posix
// tool is consequential and defaults to the "ask" tier. Catastrophic commands
// are denied earlier by the authorization plugin, so they never reach here.
const READ_ONLY_TOOLS = new Set(["read_file", "search_files", "grep", "list_dir", "lsp"]);

// Tools that take a single path-like argument the gate should check against
// restriction (outside the workspace boundary, or writes under .agent-state).
// Covers both read-only tools (dropped from allow to ask) and the mutating
// file tools (dropped from auto-allow to ask in auto mode).
const PATH_ARG_TOOLS = new Set(["read_file", "search_files", "grep", "list_dir", "lsp", "write_file", "edit_file", "delete_file"]);

// `lsp` names its target `filePath`; every other path-arg tool uses `path`.
function pathArgKey(toolName: string): string {
  return toolName === "lsp" ? "filePath" : "path";
}

// write_file/edit_file/delete_file mutate the target; every other path-arg tool only
// reads it. Restriction policy (see path-restriction.ts) treats reads and
// writes of an .agent-state path differently, so callers need to tell the
// gate which mode a given tool call is in.
function isWriteTool(toolName: string): boolean {
  return toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file";
}

export type Tier = "allow" | "ask";

export function classifyTool(toolName: string, mcpTiers?: McpToolPermissionRegistry): Tier {
  if (READ_ONLY_TOOLS.has(toolName)) return "allow";
  if (isMcpToolName(toolName)) {
    const registered = mcpTiers?.tierFor(toolName);
    if (registered !== undefined) return registered;
    if (isReadOnlyMcpTool(toolName)) return "allow";
    return "ask";
  }
  return "ask";
}

// The restricted path argument of a path-arg tool call, or undefined when the
// call has no path or the path is not restricted. grep/search_files without a
// path scan the whole workspace and are not treated as restricted — ripgrep
// already skips gitignored files, so a workspace-wide search stays allow-tier.
export function restrictedPathArg(
  call: ToolCall,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): string | undefined {
  if (!PATH_ARG_TOOLS.has(call.name)) return undefined;
  const path = stringArg(call, pathArgKey(call.name));
  if (path.length === 0) return undefined;
  return isRestricted(path, isWriteTool(call.name)) ? path : undefined;
}

// Whether a shell command reads through a restricted path. Tokenised so a bare
// `cat .agent-state/run.json` is caught; flags are ignored since they are not
// path arguments. The auto-shell allowlist (SAFE_SHELL_PROGRAMS) only ever
// admits read-only commands, so shell targets are always judged as reads.
export function commandTargetsRestricted(
  command: string,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): boolean {
  return tokenize(command)
    .filter((token) => !token.startsWith("-"))
    .some((token) => isRestricted(token, false));
}

export function callTargetsRestricted(
  call: ToolCall,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): boolean {
  if (call.name === "run_shell") return commandTargetsRestricted(stringArg(call, "command"), isRestricted);
  return restrictedPathArg(call, isRestricted) !== undefined;
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
// `strings /proc/self/environ` from auto-reading any file on the host. Sensitive
// path names (`.env`, keys) additionally never auto-allow; the permission gate
// asks so the operator can approve legitimate shell uses (e.g. `--env-file`).
// Path-keyed secret reads remain a hard deny in secret-guard.
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function escapesWorkspace(token: string, realCwd: string): boolean {
  if (token.startsWith("~")) return true;
  const realTarget = realpathOr(resolve(realCwd, token));
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

function argEscapesWorkspace(token: string, realCwd: string): boolean {
  if (!token.startsWith("-")) return escapesWorkspace(token, realCwd);
  const value = flagPathValue(token);
  return value !== null && value.length > 0 && escapesWorkspace(value, realCwd);
}

// Segment-only allowlist check (no authz policy). Used when a pipeline segment is
// judged in isolation — authz applies to the full command string, not each stage.
export function isAutoAllowedShellSegment(segment: string, cwd: string = process.cwd()): boolean {
  const trimmed = segment.trim();
  // Empty is not auto-allowed as a "command"; full-line comments are no-ops
  // (markdown headings pasted into multi-line agent shells) and never need approval.
  if (trimmed.length === 0) return false;
  if (isShellCommentOnly(trimmed)) return true;
  if (runShellAuthzSegmentBlockReason(trimmed) !== undefined) return false;
  const realCwd = realpathOr(cwd);
  return isAutoAllowedSegment(segment, realCwd);
}

function isAutoAllowedSegment(segment: string, realCwd: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  if (isShellCommentOnly(trimmed)) return true;
  if (commandReferencesSensitivePath(trimmed)) return false;
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
  if (args.some((token) => argEscapesWorkspace(token, realCwd))) return false;
  return true;
}

export function isAutoAllowedShellCommand(command: string, cwd: string = process.cwd()): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // Single-line full comments are no-ops. Multi-line strings that merely *start*
  // with `#` can still contain real commands on later lines, so those go through
  // the normal segment path (buildRequests filters comment-only segments).
  if (!trimmed.includes("\n") && isShellCommentOnly(trimmed)) return true;
  if (commandReferencesSensitivePath(trimmed)) return false;
  // Never auto-allow a command the authz layer would hard-deny at execution.
  if (runShellAuthzBlockReason(trimmed) !== undefined) return false;
  // Reject anything with metacharacters that compose or redirect (& ; < > ` $ etc).
  // Pipes are allowed between safe segments — evaluated below.
  if (DANGEROUS_METACHARACTERS.test(trimmed)) return false;

  // Split on pipe and require every segment to be a safe read-only program.
  // The workspace realpath is constant across every path token in the command,
  // so resolve it once here rather than per token inside escapesWorkspace.
  const realCwd = realpathOr(cwd);
  const segments = trimmed.split("|");
  return segments.every((seg) => isAutoAllowedSegment(seg, realCwd));
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
    // Full-line comments (markdown headings, shell comments) are no-ops — never
    // surface them as approval subjects or derive allow patterns from them.
    return splitChainedCommand(command)
      .filter((segment) => !isShellCommentOnly(segment))
      .map((segment) => ({
        tool: "run_shell",
        action: "Run shell command",
        subject: segment,
        arguments: { command: segment },
        scopes: deriveCommandScopes(segment),
      }));
  }
  if (call.name === "write_file" || call.name === "edit_file" || call.name === "delete_file") {
    const path = stringArg(call, "path");
    const action = call.name === "write_file" ? "Write file" : call.name === "edit_file" ? "Edit file" : "Delete file";
    return [{ tool: call.name, action, subject: path, arguments: call.arguments, scopes: fileScopes(path) }];
  }
  // A read-only tool only reaches here when its target is restricted (outside
  // the workspace boundary). Key the request on the path so approving it
  // grants that path or directory, not every future read.
  if (READ_ONLY_TOOLS.has(call.name)) {
    const path = stringArg(call, pathArgKey(call.name));
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
