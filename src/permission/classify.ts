import type { ToolCall } from "@intx/types/runtime";
import type { ApprovalScope, PermissionRequest } from "./types.js";
import {
  splitChainedCommand,
  deriveCommandScopes,
  tokenize,
  isShellCommentOnly,
  isShellNoOp,
} from "./command.js";
import {
  isMcpToolName,
  humanizeMcpTool,
  isReadOnlyMcpTool,
} from "../mcp/tool-name.js";
import type { McpToolPermissionRegistry } from "../mcp/tool-permissions.js";
import {
  inspectShellSecretReference,
  isSensitiveShellToken,
  shellSecretInspectionRequiresApproval,
  PURE_DIRECTORY_LISTING_PROGRAMS,
} from "../plugins/secret-guard-plugin.js";
import {
  runShellAuthzBlockReason,
  runShellAuthzSegmentBlockReason,
} from "../shell/run-shell-authz.js";
import { resolveWorkspacePath } from "./path-restriction.js";
import { normalizeGrantPath } from "./matcher.js";
import type { RootsProvider } from "./worktree-roots.js";
import {
  isProductMutationTool,
  productMutationPaths,
} from "../agent/product-mutation-tools.js";
import { AUTO_ALLOW_READ_TOOLS as READ_ONLY_TOOLS } from "../agent/tool-classification.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";

// Read-only tools never need approval while they stay off restricted paths —
// they cannot change the workspace. `lsp` is included despite activating
// mid-session: hover/definition lookups are as inert as a grep. `manage_tasks`
// has no side effect (the director's decide() loop already applied the task
// list), so an approval denial would prevent nothing. Every other posix tool
// defaults to "ask"; catastrophic commands are denied earlier by the
// authorization plugin.
//
// Membership lives in tool-classification.ts (AUTO_ALLOW_READ_TOOLS).

// Tools with a single path-like argument the gate checks against restriction
// (outside the workspace, or writes under the session state root): read-only
// tools drop from allow to ask, mutating file tools from auto-allow to ask.
// apply_patch is omitted — its subjects come from productMutationPaths.
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

// Product mutation tools write the target; other path-arg tools only read it.
// Restriction policy treats reads and writes of a session-state path
// differently, so callers tell the gate which mode the call is in.
function isWriteTool(toolName: string): boolean {
  return isProductMutationTool(toolName);
}

export type Tier = "allow" | "ask";

// Tier is a pre-filter above the authz grant path, not authz policy itself: it
// encodes tool-level defaults upstream authz cannot express. `allow`
// short-circuits; `ask` flows through grants, where deny and the reactor's
// suspend effect live.
export function classifyTool(
  toolName: string,
  mcpTiers?: McpToolPermissionRegistry,
): Tier {
  const name = canonicalToolName(toolName);
  if (READ_ONLY_TOOLS.has(name)) return "allow";
  if (isMcpToolName(name)) {
    const registered = mcpTiers?.tierFor(name);
    if (registered !== undefined) return registered;
    if (isReadOnlyMcpTool(name)) return "allow";
    return "ask";
  }
  return "ask";
}

// The restricted path argument of a path-arg tool call, or undefined when the
// path is absent or not restricted. grep/search_files without a path scan the
// whole workspace (ripgrep already skips gitignored files), so a workspace-wide
// search stays allow-tier.
export function restrictedPathArg(
  call: ToolCall,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): string | undefined {
  if (!PATH_ARG_TOOLS.has(canonicalToolName(call.name))) return undefined;
  const path = stringArg(call, pathArgKey(canonicalToolName(call.name)));
  if (path.length === 0) return undefined;
  return isRestricted(path, isWriteTool(canonicalToolName(call.name)))
    ? path
    : undefined;
}

// Pure-listing programs may target outside-workspace paths — listing is not a
// content read. Content readers (cat, head, xxd, …) still fail the check
// below. Program set lives in secret-guard-plugin.ts (shared with the
// resolve-leg skip).

// Cap accepted tree depth so `tree -L 999999 /` cannot auto-allow an OOM walk.
const MAX_PURE_TREE_DEPTH = 10;

// Unbounded or over-deep ls/tree can OOM the host; pure-listing auto-allow is
// only for shallow name dumps.
function parseTreeDepth(
  arg: string,
  next: string | undefined,
): number | undefined {
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

// GNU ls accepts unambiguous long-option abbreviations (`--recu` ≈
// `--recursive`); treat every prefix as recursive.
const LS_RECURSIVE_LONG_FLAG = /^--r(e(c(u(r(s(i(v(e)?)?)?)?)?)?)?)?(=|$)/;

// tree flags that write a listing to disk (or read one from a file) are not
// pure listings — they go through the normal write review.
const TREE_FILE_IO_FLAG = /^(-o|--output|-H|--html|--fromfile)(=|$)/;

function isBoundedDirectoryListing(
  program: string,
  args: readonly string[],
): boolean {
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
      const arg = args[i];
      if (arg === undefined) continue;
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
  // Redirects / composition make the segment impure — `ls > /dev/pts/0` must
  // still hit path restriction + authz hard-deny; pipes are evaluated per stage.
  if (trimmed.includes("|") || DANGEROUS_METACHARACTERS.test(trimmed))
    return false;
  const tokens = tokenize(trimmed);
  const program = tokens[0] ?? "";
  if (!PURE_DIRECTORY_LISTING_PROGRAMS.has(program)) return false;
  return isBoundedDirectoryListing(program, tokens.slice(1));
}

// True when any stage is an unbounded directory listing (`ls -R`, bare
// `tree`). Same OOM class as open-ended find/rg — auto mode must not
// rubber-stamp these even inside the workspace.
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

// Whether a shell command reads through a restricted path. Tokenized so a bare
// `cat .agent-state/run.json` is caught; flags are skipped (not path args).
// The auto-shell allowlist (SAFE_SHELL_PROGRAMS) admits only read-only
// commands, so shell targets always read. Surfaces flag-glued paths
// (`--file=PATH`, `-fPATH`) and treats `~…` as outside-workspace. Pure
// directory listings (`ls`, bounded `tree`) are exempt — names/metadata only,
// even outside the workspace. Chains and pipes are judged per segment, so
// `ls /tmp && cat …` still flags the content-reading half.
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
        pathLikeTokens(pipeSeg).some(
          (token) => token.startsWith("~") || isRestricted(token, false),
        )
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

// Fleet verbs addressed by opaque agent id, not path (see
// callTargetsRestricted below).
const AGENT_ID_TARGETED_FLEET_TOOLS = new Set([
  "close_agent",
  "interrupt_agent",
  "send_input",
  "resume_agent",
  "read_agent_trace",
]);

export function callTargetsRestricted(
  call: ToolCall,
  isRestricted: (path: string, isWrite: boolean) => boolean,
): boolean {
  const name = canonicalToolName(call.name);
  // Agent-id-addressed verbs have no path for isRestricted to judge; the
  // target worker's own gate binds restriction to its process cwd
  // (bindRestrictedToProcessCwd in gate.ts), so these always report "not
  // restricted". The remaining fleet verbs take no single-agent `target` and
  // fall through to false below. Full verb list: subagent/authority.ts
  // (FLEET_VERBS).
  if (AGENT_ID_TARGETED_FLEET_TOOLS.has(name)) return false;
  if (name === "run_shell")
    return commandTargetsRestricted(stringArg(call, "command"), isRestricted);
  if (name === "apply_patch") {
    return productMutationPaths(name, call.arguments).some((path) =>
      isRestricted(path, true),
    );
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

// `find` stays read-only unless a flag runs a command (-exec/-ok and *dir
// variants), deletes matches (-delete), or writes results (-fprint*/-fls).
// Its `-o` is logical OR, not output, so `find` needs its own rule instead of
// the generic WRITE_FLAG/EXEC_FLAG checks.
const FIND_DANGEROUS_FLAG =
  /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fprint0|fls)$/;

// Non-pipe metacharacters disqualify a command outright; pipes are evaluated
// segment-by-segment (see below).
const DANGEROUS_METACHARACTERS = /[&;<>`$(){}]|\\\n|\n/;
const WRITE_FLAG = /^(-o|--output)(=|$)/;

// grep/rg flags that run an arbitrary binary per matched file — arbitrary
// code execution from a "safe" search.
const EXEC_FLAG = /^(--pre|--pre-glob|--hostname-bin|--search-zip|-z)(=|$)/;

// A safe read command auto-runs only when every path-like argument stays in
// the workspace. Containment — not a secret-name denylist — is the invariant:
// it stops `cat /etc/passwd`, `xxd ~/.aws/config`, `strings /proc/self/environ`
// from auto-reading the host. Pure listings (`ls`, `tree`) are the exception
// (names/metadata only). Sensitive names (`.env`, keys) never auto-allow; the
// gate asks so legitimate uses (`--env-file`) work, and path-keyed secret
// reads stay a hard deny in secret-guard. Uses resolveWorkspacePath from
// path-restriction.ts — the same authority gate.ts's restriction check uses —
// with `rootsProvider` defaulting to no extra roots.
function escapesWorkspace(
  token: string,
  cwd: string,
  rootsProvider: RootsProvider,
): boolean {
  if (token.startsWith("~")) return true;
  return resolveWorkspacePath(cwd, token, rootsProvider) === undefined;
}

// grep/rg take a file through a flag value (`--file=PATH`, `-fPATH`); surface
// the glued value so it gets the same containment check as a bare argument.
function flagPathValue(token: string): string | null {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    return eq === -1 ? null : token.slice(eq + 1);
  }
  const glued = /^-f(.+)$/.exec(token);
  return glued !== null ? (glued[1] ?? null) : null;
}

function argEscapesWorkspace(
  token: string,
  cwd: string,
  rootsProvider: RootsProvider,
): boolean {
  if (!token.startsWith("-"))
    return escapesWorkspace(token, cwd, rootsProvider);
  const value = flagPathValue(token);
  return (
    value !== null &&
    value.length > 0 &&
    escapesWorkspace(value, cwd, rootsProvider)
  );
}

// Default rootsProvider: callers without a worktree registry keep cwd-only
// containment.
const NO_ROOTS: RootsProvider = () => [];

// Allowlist check for one pipeline segment — authz applies to the full
// command string, not each stage.
export function isAutoAllowedShellSegment(
  segment: string,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
  isExtraDenied: (value: string) => boolean = () => false,
): boolean {
  const trimmed = segment.trim();
  // Empty is not a "command"; full-line comments and shell no-ops (true/false/:
  // and bare control-flow keywords) never need approval.
  if (trimmed.length === 0) return false;
  if (isShellCommentOnly(trimmed) || isShellNoOp(trimmed)) return true;
  if (runShellAuthzSegmentBlockReason(trimmed) !== undefined) return false;
  return isAutoAllowedSegment(segment, cwd, rootsProvider, isExtraDenied);
}

function isAutoAllowedSegment(
  segment: string,
  cwd: string,
  rootsProvider: RootsProvider,
  isExtraDenied: (value: string) => boolean = () => false,
): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return false;
  if (isShellCommentOnly(trimmed) || isShellNoOp(trimmed)) return true;
  if (
    shellSecretInspectionRequiresApproval(
      inspectShellSecretReference(trimmed, cwd, isExtraDenied),
    )
  )
    return false;
  // Same metacharacter gate as the full-command check: a segment with its own
  // command substitution or redirect must not slip through just because it
  // never passed the full-command path.
  if (DANGEROUS_METACHARACTERS.test(trimmed)) return false;
  // Quote-aware so a flag cannot hide behind quotes the shell strips (e.g.
  // find . '-delete'); a naive whitespace split keeps the quotes on the token.
  const tokens = tokenize(trimmed);
  const program = tokens[0] ?? "";
  if (!SAFE_SHELL_PROGRAMS.has(program)) return false;
  // Listings that fail pure (recursive ls, over-deep tree) never auto-allow —
  // same OOM class as open-ended find/rg.
  const pureListing = isPureDirectoryListingSegment(trimmed);
  if (PURE_DIRECTORY_LISTING_PROGRAMS.has(program) && !pureListing)
    return false;
  const args = tokens.slice(1);
  if (program === "find") {
    if (args.some((token) => FIND_DANGEROUS_FLAG.test(token))) return false;
  } else {
    if (args.some((token) => WRITE_FLAG.test(token))) return false;
    if (args.some((token) => EXEC_FLAG.test(token))) return false;
  }
  // Resolve symlinks before the secret denylist — notes.txt → .env asks like
  // .env itself. Pure name-listings skip the resolve leg; an impure listing
  // fails above.
  if (
    args.some((token) =>
      isSensitiveShellToken(token, cwd, !pureListing, isExtraDenied),
    )
  )
    return false;
  // Pure listings may target outside-workspace paths; content readers must
  // stay inside the workspace.
  if (
    !pureListing &&
    args.some((token) => argEscapesWorkspace(token, cwd, rootsProvider))
  ) {
    return false;
  }
  return true;
}

export function isAutoAllowedShellCommand(
  command: string,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
  isExtraDenied: (value: string) => boolean = () => false,
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // Only single-line full comments and shell no-ops are inert. Multi-line
  // strings that merely start with `#` can hold real commands on later lines,
  // so they go through the normal segment path (buildRequests filters
  // comment-only segments).
  if (
    !trimmed.includes("\n") &&
    (isShellCommentOnly(trimmed) || isShellNoOp(trimmed))
  )
    return true;
  if (
    shellSecretInspectionRequiresApproval(
      inspectShellSecretReference(trimmed, cwd, isExtraDenied),
    )
  )
    return false;
  // Never auto-allow a command the authz layer would hard-deny at execution.
  if (runShellAuthzBlockReason(trimmed) !== undefined) return false;
  // Reject metacharacters that compose or redirect (& ; < > ` $ etc); pipes
  // between safe segments are evaluated below.
  if (DANGEROUS_METACHARACTERS.test(trimmed)) return false;

  // Split on pipe and require every segment to be a safe read-only program.
  const segments = trimmed.split("|");
  return segments.every((seg) =>
    isAutoAllowedSegment(seg, cwd, rootsProvider, isExtraDenied),
  );
}

export function isAutoAllowedShellCall(
  call: ToolCall,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = NO_ROOTS,
  isExtraDenied: (value: string) => boolean = () => false,
): boolean {
  if (canonicalToolName(call.name) !== "run_shell") return false;
  return isAutoAllowedShellCommand(
    stringArg(call, "command"),
    cwd,
    rootsProvider,
    isExtraDenied,
  );
}

// File scopes stop at the directory level — no "every file" rung: a persisted
// "*" would silently authorize all future writes in the directory.
function fileScopes(path: string): ApprovalScope[] {
  const scopes: ApprovalScope[] = [
    { id: "exact", label: `Allow Always (this file)`, pattern: path },
  ];
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const dir = normalizeGrantPath(path.slice(0, slash));
    scopes.push({
      id: "dir",
      label: `Allow Always (this directory)`,
      pattern: `${dir}/*`,
    });
  }
  return scopes;
}

function stringArg(call: ToolCall, key: string): string {
  const value = call.arguments[key];
  return typeof value === "string" ? value : "";
}

// Non-comment-only chain segments — the basis for "one command or a chain".
function realShellSegments(command: string): string[] {
  return splitChainedCommand(command).filter(
    (segment) => !isShellCommentOnly(segment),
  );
}

// Persistable scopes for a shell command. Multi-segment chains offer only the
// full chain string — a prefix like `npm *` would also match `npm i && rm -rf /`
// later (fail-closed). Minting splits that payload into one grant per real
// segment (mintGrant in gate.ts), so each step becomes its own approval.
function shellApprovalScopes(command: string): ApprovalScope[] {
  const segments = realShellSegments(command);
  if (segments.length === 0) return [];
  if (segments.length === 1) {
    const only = segments[0];
    if (only === undefined) return [];
    return deriveCommandScopes(only);
  }
  return [
    {
      id: "exact",
      label: "Always allow each command in this chain",
      pattern: command.trim(),
    },
  ];
}

// Split an ask-tier tool call into the approval request(s) the operator sees.
// Shell is one request for the full command (security still splits under the
// gate); file tools key on the target path.
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
  // web_fetch/web_search key their own permission classes (webfetch/websearch)
  // on the URL/query, so an "always allow" grant is scoped to what was
  // requested. Additive only — does not touch shell classification.
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
        scopes: [
          { id: "tool", label: "Always allow web_search", pattern: call.name },
        ],
      },
    ];
  }
  // A read-only tool reaches here only when its target is restricted. Key the
  // request on the path so approval grants that path or directory, not every
  // future read.
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
  // MCP tools show the human label; the raw mcp__ identifier stays the hidden
  // subject and persisted pattern so matching is unaffected.
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
