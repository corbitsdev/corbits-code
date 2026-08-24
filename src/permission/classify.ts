import type { ToolCall } from "@intx/types/runtime";
import type { ApprovalScope, PermissionRequest } from "./types.js";
import {
  splitChainedCommand,
  deriveCommandScopes,
  tokenize,
  isShellCommentOnly,
  isShellNoOp,
} from "./command.js";
import { isMcpToolName, humanizeMcpTool, isReadOnlyMcpTool } from "../mcp/tool-name.js";
import type { McpToolPermissionRegistry } from "../mcp/tool-permissions.js";
import { commandReferencesSensitivePath, isSensitivePath } from "../plugins/secret-guard-plugin.js";
import {
  runShellAuthzBlockReason,
  runShellAuthzSegmentBlockReason,
} from "../shell/run-shell-authz.js";
import { resolveWorkspacePath } from "./path-restriction.js";
import type { RootsProvider } from "./worktree-roots.js";
import { isProductMutationTool, productMutationPaths } from "../agent/product-mutation-tools.js";
import { AUTO_ALLOW_READ_TOOLS as READ_ONLY_TOOLS } from "../agent/tool-classification.js";

// Read-only tools never need approval as long as they don't touch a restricted
// path; they cannot change the workspace. `lsp` is included here even though
// it is activated dynamically mid-session (see director.ts onActivateTools) —
// hover/definition/reference lookups are as inert as a grep. `manage_tasks` is
// included for a related but distinct reason: its handler (src/agent/tools.ts)
// has no side effect of its own — the task list is mutated earlier, by the
// director's decide() loop at the tool_call event, before this tool ever
// executes (see applyManageTasksToolCall in src/agent/director.ts). By the
// time an operator would see an approval prompt for it, there is nothing left
// for a denial to prevent. Every other posix tool is consequential and
// defaults to the "ask" tier. Catastrophic commands are denied earlier by the
// authorization plugin, so they never reach here.
//
// Membership lives in tool-classification.ts (AUTO_ALLOW_READ_TOOLS, imported
// here as READ_ONLY_TOOLS) — see CL-6809.

// Tools that take a single path-like argument the gate should check against
// restriction (outside the workspace boundary, or writes under the session state root).

// Covers both read-only tools (dropped from allow to ask) and the mutating
// file tools (dropped from auto-allow to ask in auto mode). apply_patch is
// omitted here — its subjects come from the envelope (see productMutationPaths).
const PATH_ARG_TOOLS = new Set([
  "read_file",
  "search_files",
  "grep",
  "list_dir",
  "lsp",
  "write_file",
  "edit_file",
  "delete_file",
]);

// `lsp` names its target `filePath`; every other path-arg tool uses `path`.
function pathArgKey(toolName: string): string {
  return toolName === "lsp" ? "filePath" : "path";
}

// Product mutation tools mutate the target; every other path-arg tool only
// reads it. Restriction policy (see path-restriction.ts) treats reads and
// writes of a session-state path differently, so callers need to tell the

// gate which mode a given tool call is in.
function isWriteTool(toolName: string): boolean {
  return isProductMutationTool(toolName);
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

// Programs that only print directory names / metadata. Outside-workspace path
// arguments are fine for these — listing is not a content read. Content readers
// (cat, head, xxd, …) still fail the restricted-path check below.
const PURE_DIRECTORY_LISTING_PROGRAMS = new Set(["ls", "tree"]);

// Cap accepted tree depth so `tree -L 999999 /` cannot auto-allow an OOM walk.
const MAX_PURE_TREE_DEPTH = 10;

// Recursive ls / unbounded or over-deep tree can OOM the host — pure-listing
// auto-allow is only for shallow name dumps.
function parseTreeDepth(arg: string, next: string | undefined): number | undefined {
  if (arg === "-L" || arg === "--max-depth") {
    if (next !== undefined && /^\d+$/.test(next)) return Number(next);
    return undefined;
  }
  const short = /^-L(\d+)$/.exec(arg);
  if (short !== null) return Number(short[1]);
  const long = /^--max-depth=(\d+)$/.exec(arg);
  if (long !== null) return Number(long[1]);
  return undefined;
}

// GNU ls accepts any unambiguous abbreviation of a long option, so `--recu`
// recurses just like `--recursive`; treat every prefix as recursive.
const LS_RECURSIVE_LONG_FLAG = /^--r(e(c(u(r(s(i(v(e)?)?)?)?)?)?)?)?(=|$)/;

// A listing command that writes a file is not a listing command: these tree
// flags emit output to disk (or read a listing from one) and must go through
// the normal write review instead of the pure-listing exemption.
const TREE_FILE_IO_FLAG = /^(-o|--output|-H|--html|--fromfile)(=|$)/;

function isBoundedDirectoryListing(program: string, args: readonly string[]): boolean {
  if (program === "ls") {
    for (const arg of args) {
      if (LS_RECURSIVE_LONG_FLAG.test(arg)) return false;
      if (arg.startsWith("--")) continue;
      if (arg.startsWith("-") && arg.includes("R")) return false;
    }
    return true;
  }
  if (program === "tree") {
    if (args.some((arg) => TREE_FILE_IO_FLAG.test(arg))) return false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const depth = parseTreeDepth(arg, args[i + 1]);
      if (depth === undefined) continue;
      // `-L` / `--max-depth` consume the next token when separate.
      if (arg === "-L" || arg === "--max-depth") i++;
      return depth >= 0 && depth <= MAX_PURE_TREE_DEPTH;
    }
    return false;
  }
  return false;
}

function isPureDirectoryListingSegment(segment: string): boolean {
  const trimmed = segment.trim();
  // Redirects / composition mean the segment is not "names only" — e.g.
  // `ls > /dev/pts/0` must still hit path restriction + authz hard-deny.
  // Pipes are evaluated per stage by callers; a multi-stage string is never pure.
  if (trimmed.includes("|") || DANGEROUS_METACHARACTERS.test(trimmed)) return false;
  const tokens = tokenize(trimmed);
  const program = tokens[0] ?? "";
  if (!PURE_DIRECTORY_LISTING_PROGRAMS.has(program)) return false;
  return isBoundedDirectoryListing(program, tokens.slice(1));
}

// True when some stage is a directory listing program without a recursion bound
// (`ls -R`, bare `tree`, …). Same OOM class as open-ended find/rg — auto mode
// must not rubber-stamp these even inside the workspace.
export function commandHasUnboundedDirectoryListing(command: string): boolean {
  const segments = splitChainedCommand(command);
  const parts = segments.length > 0 ? segments : [command];
  for (const segment of parts) {
    for (const pipeSeg of segment.split("|")) {
      const trimmed = pipeSeg.trim();
      if (trimmed.length === 0) continue;
      const tokens = tokenize(trimmed);
      const program = tokens[0] ?? "";
      if (!PURE_DIRECTORY_LISTING_PROGRAMS.has(program)) continue;
      if (!isBoundedDirectoryListing(program, tokens.slice(1))) return true;
    }
  }
  return false;
}

// Whether a shell command reads through a restricted path. Tokenised so a bare
// `cat .agent-state/run.json` is caught; flags are ignored since they are not
// path arguments. The auto-shell allowlist (SAFE_SHELL_PROGRAMS) only ever
// admits read-only commands, so shell targets are always judged as reads.
// Surfaces flag-glued path values (`--file=PATH`, `-fPATH`) and treats `~…`
// as outside-workspace the same way the safe-shell path does.
// Pure directory listing (`ls`, bounded `tree`) is exempt: names/metadata only,
// even outside the workspace. Chains and pipelines are judged per segment so
// `ls /tmp && cat …` / `ls /tmp | cat …` still flags the content-reading half.
export function commandTargetsRestricted(
  command: string,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): boolean {
  const segments = splitChainedCommand(command);
  const parts = segments.length > 0 ? segments : [command];
  for (const segment of parts) {
    for (const pipeSeg of segment.split("|")) {
      if (isPureDirectoryListingSegment(pipeSeg)) continue;
      if (
        pathLikeTokens(pipeSeg).some((token) => token.startsWith("~") || isRestricted(token, false))
      ) {
        return true;
      }
    }
  }
  return false;
}

function pathLikeTokens(command: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(command)) {
    if (!token.startsWith("-")) {
      out.push(token);
      continue;
    }
    const value = flagPathValue(token);
    if (value !== null && value.length > 0) out.push(value);
  }
  return out;
}

export function callTargetsRestricted(
  call: ToolCall,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): boolean {
  if (call.name === "run_shell")
    return commandTargetsRestricted(stringArg(call, "command"), isRestricted);
  if (call.name === "apply_patch") {
    return productMutationPaths(call.name, call.arguments).some((path) => isRestricted(path, true));
  }

  return restrictedPathArg(call, isRestricted) !== undefined;
}

const SAFE_SHELL_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "cut",
  "tr",
  "nl",
  "rev",
  "column",
  "uniq",
  "sort",
  "comm",
  "look",
  "ls",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "echo",
  "printf",
  "date",
  "whoami",
  "hostname",
  "uname",
  "pwd",
  "which",
  "type",
  "id",
  "grep",
  "rg",
  "fgrep",
  "egrep",
  "od",
  "xxd",
  "strings",
  "find",
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
// `strings /proc/self/environ` from auto-reading any file on the host. Pure
// directory listing (`ls`, `tree`) is the exception: names/metadata only, so
// outside-workspace targets still auto-allow. Sensitive path names (`.env`,
// keys) additionally never auto-allow; the permission gate asks so the operator
// can approve legitimate shell uses (e.g. `--env-file`). Path-keyed secret
// reads remain a hard deny in secret-guard.
// Containment is delegated to path-restriction.ts's resolveWorkspacePath —
// the same authority gate.ts's restriction check uses — so a path inside a
// registered worktree root is never auto-allow-eligible under a stricter (or
// looser) rule than the one that judges it restricted. `rootsProvider`
// defaults to no extra roots, so callers that don't pass one keep exactly
// today's cwd-only behavior.
function escapesWorkspace(token: string, cwd: string, rootsProvider: RootsProvider): boolean {
  if (token.startsWith("~")) return true;
  return resolveWorkspacePath(cwd, token, rootsProvider) === undefined;
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

function argEscapesWorkspace(token: string, cwd: string, rootsProvider: RootsProvider): boolean {
  if (!token.startsWith("-")) return escapesWorkspace(token, cwd, rootsProvider);
  const value = flagPathValue(token);
  return value !== null && value.length > 0 && escapesWorkspace(value, cwd, rootsProvider);
}

// No-extra-roots default: callers that don't pass a rootsProvider (existing
// tests, callers with no worktree registry) keep exactly today's cwd-only
// containment behavior.
const NO_ROOTS: RootsProvider = () => [];

// Segment-only allowlist check (no authz policy). Used when a pipeline segment is
// judged in isolation — authz applies to the full command string, not each stage.
export function isAutoAllowedShellSegment(
  segment: string,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
): boolean {
  const trimmed = segment.trim();
  // Empty is not auto-allowed as a "command"; full-line comments and pure shell
  // no-ops (true/false/: and bare control-flow keywords) never need approval.
  if (trimmed.length === 0) return false;
  if (isShellCommentOnly(trimmed) || isShellNoOp(trimmed)) return true;
  if (runShellAuthzSegmentBlockReason(trimmed) !== undefined) return false;
  return isAutoAllowedSegment(segment, cwd, rootsProvider);
}

function isAutoAllowedSegment(segment: string, cwd: string, rootsProvider: RootsProvider): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  if (isShellCommentOnly(trimmed) || isShellNoOp(trimmed)) return true;
  if (commandReferencesSensitivePath(trimmed)) return false;
  // Same metacharacter gate as isAutoAllowedShellCommand: this classifier also
  // runs standalone per pipeline/chain segment (see isAutoAllowedShellSegment),
  // so a segment carrying its own command substitution or redirect must not
  // slip through just because it never passed through the full-command check.
  if (DANGEROUS_METACHARACTERS.test(trimmed)) return false;
  // Quote-aware so a dangerous flag cannot hide behind quotes the shell strips
  // (e.g. find . '-delete'). A naive whitespace split leaves the quotes on the
  // token, defeating the anchored flag checks below.
  const tokens = tokenize(trimmed);
  const program = tokens[0] ?? "";
  if (!SAFE_SHELL_PROGRAMS.has(program)) return false;
  // Listing programs that fail pure (recursive ls, over-deep tree, …) never
  // auto-allow — they can OOM the host the same way open-ended find/rg can.
  const pureListing = isPureDirectoryListingSegment(trimmed);
  if (PURE_DIRECTORY_LISTING_PROGRAMS.has(program) && !pureListing) return false;
  const args = tokens.slice(1);
  if (program === "find") {
    if (args.some((token) => FIND_DANGEROUS_FLAG.test(token))) return false;
  } else {
    if (args.some((token) => WRITE_FLAG.test(token))) return false;
    if (args.some((token) => EXEC_FLAG.test(token))) return false;
  }
  if (args.some((token) => isSensitivePath(token))) return false;
  // Pure directory listing may target outside-workspace paths (names only).
  // Content readers must stay inside the workspace.
  if (!pureListing && args.some((token) => argEscapesWorkspace(token, cwd, rootsProvider))) {
    return false;
  }
  return true;
}

export function isAutoAllowedShellCommand(
  command: string,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // Single-line full comments and pure shell no-ops are inert.
  // Multi-line strings that merely *start* with `#` can still contain real
  // commands on later lines, so those go through the normal segment path
  // (buildRequests filters comment-only segments).
  if (!trimmed.includes("\n") && (isShellCommentOnly(trimmed) || isShellNoOp(trimmed))) return true;
  if (commandReferencesSensitivePath(trimmed)) return false;
  // Never auto-allow a command the authz layer would hard-deny at execution.
  if (runShellAuthzBlockReason(trimmed) !== undefined) return false;
  // Reject anything with metacharacters that compose or redirect (& ; < > ` $ etc).
  // Pipes are allowed between safe segments — evaluated below.
  if (DANGEROUS_METACHARACTERS.test(trimmed)) return false;

  // Split on pipe and require every segment to be a safe read-only program.
  const segments = trimmed.split("|");
  return segments.every((seg) => isAutoAllowedSegment(seg, cwd, rootsProvider));
}

export function isAutoAllowedShellCall(
  call: ToolCall,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
): boolean {
  if (call.name !== "run_shell") return false;
  return isAutoAllowedShellCommand(stringArg(call, "command"), cwd, rootsProvider);
}

// File scopes intentionally stop at the directory level. There is no "every
// file" rung: a persisted "*" would silently authorize all future writes/edits
// in the directory, which is too blunt to offer as a one-keystroke choice.
function fileScopes(path: string): ApprovalScope[] {
  const scopes: ApprovalScope[] = [
    { id: "exact", label: `Allow Always (this file)`, pattern: path },
  ];
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

// The real (non-comment-only) chain segments of a shell command — the basis
// both shellApprovalScopes and isSingleShellCommand use to answer "is this
// one command or a chain."
function realShellSegments(command: string): string[] {
  return splitChainedCommand(command).filter((segment) => !isShellCommentOnly(segment));
}

// Whether `command` is exactly one real command — not a chain (`a && b`), not
// a pipeline (`a | b`), not empty/comment-only. Shared by preApprove's gate
// (src/permission/gate.ts) and the interactive scope ladder below, so a
// segmenting-rule change here reaches both.
export function isSingleShellCommand(command: string): boolean {
  const segments = realShellSegments(command);
  if (segments.length !== 1) return false;
  return tokenize(segments[0]!).length > 0;
}

// Approval scopes for a shell command the operator may persist. Multi-segment
// chains only offer the exact full string — a prefix like `npm *` would also
// match `npm i && rm -rf /` on a later call (fail-closed). Minting decomposes
// that exact-chain scope into one grant per real segment (see mintGrant in
// gate.ts), so persisting it still yields reusable, segment-level approvals.
function shellApprovalScopes(command: string): ApprovalScope[] {
  const segments = realShellSegments(command);
  if (segments.length === 0) return [];
  if (segments.length === 1) {
    const only = segments[0];
    if (only === undefined) return [];
    return deriveCommandScopes(only);
  }
  return [{ id: "exact", label: "Always allow this exact command", pattern: command.trim() }];
}

// Decompose an "ask"-tier tool call into the approval request(s) the operator
// should see. Shell is one request for the full command the model asked to run
// (security still splits under the gate); file tools are keyed on the target path.
export function buildRequests(call: ToolCall): PermissionRequest[] {
  if (call.name === "run_shell") {
    const command = stringArg(call, "command");
    // Pure comments / empty: nothing to approve.
    const realSegments = splitChainedCommand(command).filter(
      (segment) => !isShellCommentOnly(segment),
    );
    if (realSegments.length === 0) return [];
    return [
      {
        tool: "run_shell",
        action: "Run shell command",
        subject: command,
        arguments: { command },
        scopes: shellApprovalScopes(command),
      },
    ];
  }
  if (isProductMutationTool(call.name)) {
    if (call.name === "apply_patch") {
      const paths = productMutationPaths(call.name, call.arguments);
      if (paths.length === 0) {
        return [
          {
            tool: "apply_patch",
            action: "Apply patch",
            subject: "",
            arguments: call.arguments,
            scopes: [],
          },
        ];
      }
      return paths.map((path) => ({
        tool: "apply_patch",
        action: "Apply patch",
        subject: path,
        arguments: call.arguments,
        scopes: fileScopes(path),
      }));
    }
    const path = stringArg(call, "path");
    const action =
      call.name === "write_file"
        ? "Write file"
        : call.name === "edit_file"
          ? "Edit file"
          : "Delete file";
    return [
      {
        tool: call.name,
        action,
        subject: path,
        arguments: call.arguments,
        scopes: fileScopes(path),
      },
    ];
  }
  // web_fetch/web_search get their own permission classes (webfetch/websearch)
  // keyed on the URL/query rather than the generic tool-name scope below, so an
  // "always allow" grant is scoped to what was actually requested. Additive
  // mapping only — does not touch shell classification.
  if (call.name === "web_fetch") {
    const url = stringArg(call, "url");
    return [
      {
        tool: "web_fetch",
        action: "Fetch URL",
        subject: url,
        arguments: call.arguments,
        scopes: [{ id: "exact", label: "Always allow this URL", pattern: url }],
      },
    ];
  }
  if (call.name === "web_search") {
    const query = stringArg(call, "query");
    return [
      {
        tool: "web_search",
        action: "Search the web",
        subject: query,
        arguments: call.arguments,
        scopes: [{ id: "tool", label: "Always allow web_search", pattern: call.name }],
      },
    ];
  }
  // A read-only tool only reaches here when its target is restricted (outside
  // the workspace boundary). Key the request on the path so approving it
  // grants that path or directory, not every future read.
  if (READ_ONLY_TOOLS.has(call.name)) {
    const path = stringArg(call, pathArgKey(call.name));
    return [
      {
        tool: call.name,
        action: "Read restricted path",
        subject: path,
        arguments: call.arguments,
        scopes: fileScopes(path),
      },
    ];
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
        {
          id: "tool",
          label: `Always allow ${label}`,
          pattern: call.name,
          ...(mcp ? { hint: label } : {}),
        },
      ],
    },
  ];
}
