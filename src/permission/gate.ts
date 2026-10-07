import type { ToolCall } from "@intx/types/runtime";
import { isAbsolute, resolve } from "node:path";
import type {
  Approval,
  ApprovalOutcome,
  GrantScope,
  PermissionRequest,
  RequestApproval,
} from "./types.js";
import {
  classifyTool,
  buildRequests,
  isAutoAllowedShellCall,
  isAutoAllowedShellSegment,
  callTargetsRestricted,
  commandTargetsRestricted,
} from "./classify.js";
import {
  autoShellRuleForCall,
  safeWorktreeCommand,
  isWorktreeForceFlag,
} from "./auto-shell-policy.js";
import {
  inspectShellSecretReference,
  shellSecretInspectionRequiresApproval,
  createExtraDeniedPathMatcher,
} from "../plugins/secret-guard-plugin.js";
import {
  normalizePathArguments,
  pathEscapeBlockReason,
} from "../plugins/path-escape-plugin.js";
import {
  runShellAuthzBlock,
  runShellAuthzBlockReason,
} from "../shell/run-shell-authz.js";
import { matchesPattern, escapeGlobLiteral } from "./matcher.js";
import {
  approvalCoversSubject,
  grantScopeMatches,
  normalizeSeededApprovals,
  type GrantWorkspace,
} from "./authz-grants.js";
import {
  splitChainedCommand,
  isShellCommentOnly,
  tokenize,
  stripCommentLines,
} from "./command.js";
import { createPathRestriction } from "./path-restriction.js";
import {
  createWorktreeRootsProvider,
  type RootsProvider,
} from "./worktree-roots.js";
import { OPERATOR_DECLINED_PREFIX } from "./decline-markers.js";
import { DenialMemory, stableRequestId } from "./denial-memory.js";
import { getSubAgentIdentity } from "../subagent/identity-context.js";
import { PRODUCT_MUTATION_TOOLS } from "../agent/product-mutation-tools.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { prepareDispatchedToolCall } from "../agent/tool-aliases.js";

import {
  createMcpToolPermissionRegistry,
  registerMcpClientTools,
  type McpToolPermissionRegistry,
} from "../mcp/tool-permissions.js";
import type { MCPClient } from "../mcp/client.js";
import { end, start } from "../perf/index.js";
import { currentTurnId } from "../perf/reactor-spans.js";
import { classifyPermissionKind } from "../telemetry/classify.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import {
  NOOP_APPROVAL_LOG,
  type ApprovalLog,
  type ApprovalOutcomeKind,
} from "./approval-log.js";

// Closes out an operator prompt: ends the wait span and records the outcome.
// The two prompt sites below are mutually exclusive, so this runs once.
function finishApprovalWait(
  telemetry: Telemetry,
  waitSpanId: string,
  tool: string,
  outcome: ApprovalOutcome | undefined,
): void {
  const decision = outcome !== undefined && outcome.allow ? "allow" : "deny";
  end(waitSpanId, outcome !== undefined ? { decision } : undefined);
  telemetry.capture("permission_prompt", {
    decision,
    permission_kind: classifyPermissionKind(tool),
  });
}

// Classifies a settled ApprovalOutcome into the approval-log taxonomy.
// gate-wire's timeout/abort auto-denies carry fixed message text; anything
// else that denies is a plain operator/unavailable decision.
function classifyOutcome(
  outcome: ApprovalOutcome | undefined,
): ApprovalOutcomeKind {
  if (outcome === undefined) return "deny";
  if (!outcome.allow) {
    const message = outcome.message ?? "";
    if (message.includes("timed out")) return "timeout";
    if (
      message.includes("no longer running") ||
      message.includes("identity changed")
    ) {
      return "abort";
    }
    return "deny";
  }
  return outcome.persist !== undefined ? "allow-with-scope" : "allow-once";
}

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

// One shell segment's forced-ask guard: a secret-path reference or a
// restricted target forces an operator decision no matter what a grant
// would cover. Shared by evaluate() and preGrantGuardReason.
interface SegmentGuard {
  kind: "secret" | "opaque" | "restricted";
}

// When both `cwd` and `rootsProvider` are supplied, a contained or
// permitted-sibling `git worktree add/remove` destination (safeWorktreeCommand)
// skips the restricted-path scan so a standing `git worktree *` grant can
// match instead of forcing an ask. Omitting them skips the exemption.
function segmentGuard(
  segment: string,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  cwd?: string,
  rootsProvider?: RootsProvider,
  isExtraDenied: (value: string) => boolean = () => false,
): SegmentGuard | undefined {
  const secret = inspectShellSecretReference(segment, cwd, isExtraDenied);
  if (shellSecretInspectionRequiresApproval(secret)) {
    return { kind: secret.reference !== undefined ? "secret" : "opaque" };
  }
  if (
    cwd !== undefined &&
    rootsProvider !== undefined &&
    safeWorktreeCommand(segment, isRestricted, cwd, rootsProvider) === true
  ) {
    return undefined;
  }
  if (commandTargetsRestricted(segment, isRestricted))
    return { kind: "restricted" };
  return undefined;
}

// Classifies a guarded `git worktree add/remove` segment so a grant-mismatch
// notice can name the operative reason. Display-only — the guard decision is
// unchanged.
type WorktreeMismatch =
  | { kind: "force"; flag: string }
  | { kind: "destination" }
  | { kind: "worktree" };

function worktreeMismatchKind(segment: string): WorktreeMismatch | undefined {
  const tokens = tokenize(segment);
  if (tokens[0] !== "git" || tokens[1] !== "worktree") return undefined;
  if (tokens[2] !== "add" && tokens[2] !== "remove") return undefined;
  const flag = tokens.slice(3).find(isWorktreeForceFlag);
  if (flag !== undefined) return { kind: "force", flag };
  // `add` takes a destination for the new worktree; `remove` names an
  // existing worktree, so only `add` gets the destination noun.
  return tokens[2] === "remove"
    ? { kind: "worktree" }
    : { kind: "destination" };
}

// Explains a grant mismatch: a standing grant covers the segment, but the
// pre-grant guard still forced an ask. Matching semantics are untouched.
function grantMismatchNotice(
  segment: string,
  kind: SegmentGuard["kind"],
): string {
  if (kind === "secret") {
    return "A standing grant matches this command, but it references a sensitive path, so it still needs approval.";
  }
  if (kind === "opaque") {
    return "A standing grant matches this command, but its wrapped payload cannot be inspected, so it still needs approval.";
  }
  const worktreeKind = worktreeMismatchKind(segment);
  if (worktreeKind?.kind === "force") {
    return `A standing grant matches this command, but it uses ${worktreeKind.flag}, so it still needs approval.`;
  }
  if (worktreeKind?.kind === "destination") {
    return "A standing grant matches this command, but the worktree destination is outside the approved locations, so it still needs approval.";
  }
  if (worktreeKind?.kind === "worktree") {
    return "A standing grant matches this command, but the worktree is outside the approved locations, so it still needs approval.";
  }
  return "A standing grant matches this command, but it targets a path outside the workspace, so it still needs approval.";
}

// Relative path tokens resolve against the issuing agent's process cwd, not the
// session cwd that built the gate. Without this rebinding, a sub-agent in an
// isolated worktree would have `cat secrets.txt` checked as if it opened
// `$SESSION/secrets.txt` while the shell opens `$WORKTREE/…`.
function bindRestrictedToProcessCwd(
  isRestricted: (path: string, isWrite: boolean) => boolean,
  processCwd: string,
): (path: string, isWrite: boolean) => boolean {
  return (path, isWrite) => {
    const anchored = isAbsolute(path) ? path : resolve(processCwd, path);
    return isRestricted(anchored, isWrite);
  };
}

// Every guard a run_shell request must clear before grant matching: hard-deny
// and forced-ask checks no grant, however broad, can bypass. The single owner
// of that sequence — evaluate() and isRequestCoveredByGrant both call it (via
// segmentGuard) — so a guard added here applies to fresh requests and
// reconciliation alike. Returns the deny/ask reason, or undefined to proceed.
// Non-shell tools have no pre-grant guards, so this always returns undefined.
export function preGrantGuardReason(
  request: PermissionRequest,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  rootsProvider?: RootsProvider,
  isExtraDenied: (value: string) => boolean = () => false,
): string | undefined {
  if (request.tool !== "run_shell") return undefined;
  const fullCommand = request.subject;
  const segments = splitChainedCommand(fullCommand).filter(
    (s) => !isShellCommentOnly(s),
  );
  if (segments.length === 0) return "empty command";
  const blockReason = runShellAuthzBlockReason(fullCommand);
  if (blockReason !== undefined) return blockReason;
  // Prefer the request's process cwd when present so reconciliation uses the
  // same relative-path anchor evaluate() used when the prompt was raised.
  const restricted =
    request.cwd !== undefined
      ? bindRestrictedToProcessCwd(isRestricted, request.cwd)
      : isRestricted;
  for (const segment of segments) {
    const guard = segmentGuard(
      segment,
      restricted,
      request.cwd,
      rootsProvider,
      isExtraDenied,
    );
    if (guard !== undefined) {
      if (guard.kind === "secret")
        return `${segment} references a sensitive path`;
      if (guard.kind === "opaque")
        return `${segment} contains an opaque wrapped payload`;
      return `${segment} targets a restricted path`;
    }
  }
  return undefined;
}

// Reconciliation check for the TUI's pending approval queue (see
// PermissionGateOptions.onGrant): a queued request is covered only when the
// supplied approval(s) would let evaluate() skip the prompt — same per-segment
// matching and the same preGrantGuardReason sequence — so reconciliation never
// auto-approves something evaluate() would still ask for or hard-deny.
// For run_shell, coverage is per-segment; legacy whole-string chain patterns
// never cover.
export function isRequestCoveredByGrant(
  request: PermissionRequest,
  approval: Approval,
  activeProviderModel: string | undefined,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  workspace: GrantWorkspace,
  rootsProvider?: RootsProvider,
  isExtraDenied: (value: string) => boolean = () => false,
): boolean {
  return isRequestCoveredByApprovals(
    request,
    [approval],
    activeProviderModel,
    isRestricted,
    workspace,
    rootsProvider,
    isExtraDenied,
  );
}

// Same coverage predicate as isRequestCoveredByGrant, against a live approvals
// list. mintGrant hands this to onGrant so a queued identical chain drains
// once every per-segment grant is in the list.
function isRequestCoveredByApprovals(
  request: PermissionRequest,
  approvals: readonly Approval[],
  activeProviderModel: string | undefined,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  workspace: GrantWorkspace,
  rootsProvider?: RootsProvider,
  isExtraDenied: (value: string) => boolean = () => false,
): boolean {
  const scoped = approvals.filter((a) =>
    grantScopeMatches(
      a,
      request.tool,
      activeProviderModel,
      request.cwd,
      workspace,
    ),
  );
  if (scoped.length === 0) return false;
  if (request.tool !== "run_shell") {
    return scoped.some((a) =>
      matchesPattern(
        request.subject,
        a.pattern,
        request.cwd ?? workspace.resolvedCwd,
      ),
    );
  }
  if (
    preGrantGuardReason(request, isRestricted, rootsProvider, isExtraDenied) !==
    undefined
  )
    return false;
  const segments = splitChainedCommand(request.subject).filter(
    (s) => !isShellCommentOnly(s),
  );
  if (segments.length === 0) return false;
  const cwd = request.cwd ?? workspace.resolvedCwd;
  return segments.every((segment) => {
    if (scoped.some((a) => matchesPattern(segment, a.pattern, cwd)))
      return true;
    return isAutoAllowedShellSegment(
      segment,
      cwd,
      rootsProvider,
      isExtraDenied,
    );
  });
}

// Auto-mode auto-allow for non-shell tools: file mutations plus benign
// built-ins a hands-off run should not stop for. Reads, run_shell, and
// read-only MCP auto-allow via their own paths; everything else prompts.
const AUTO_ALLOWED_TOOLS = new Set([
  ...PRODUCT_MUTATION_TOOLS,
  "manage_tasks",
  "present",
  "tool_search",
  "use_skill",
  "skill_search",
  "search_agents",
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "send_input",
  "interrupt_agent",
  "close_agent",
  "resume_agent",
  "read_agent_trace",
]);

export interface PermissionGateOptions {
  // Approvals to seed the gate with. The gate copies them; the caller's array
  // is never mutated.
  approvals: Approval[];
  // Surface a request to the operator. Required when interactive.
  requestApproval?: RequestApproval;
  // Persist a newly granted approval to the store selected by `scope`.
  // `session` grants stay in the gate's in-memory list only.
  persist?: (approval: Approval, scope: GrantScope) => void;
  // No operator is attached (headless). An unresolved "ask" becomes a denial
  // unless skipPermissions is set.
  interactive: boolean;
  // Fired with the deny reason when decide() denies with no operator attached
  // (headless). Exec wires it to stderr; callers emit the reason verbatim.
  onHeadlessDeny?: ((reason: string) => void) | undefined;
  // The --dangerously-skip-permissions escape hatch: auto-allow anything the
  // authorization layer did not already deny.
  skipPermissions: boolean;
  // Auto-approve non-destructive permissions (repeat writes, safe shell commands).
  auto?: boolean | undefined;
  // Active provider name and model. A `provider-model` grant only auto-allows
  // when these still match the grant's providerModel.
  providerName?: string | undefined;
  model?: string | undefined;
  // Workspace root: confines auto-allowed shell reads to the project.
  // Defaults to the process cwd.
  cwd?: string;
  // Additional directories inside the workspace boundary — e.g. the session's
  // registered git worktrees. Defaults to a provider that lazily discovers
  // `cwd`'s worktrees, re-listing (debounced) when a checked path is outside
  // the roots it already knows about.
  rootsProvider?: RootsProvider;
  // Directories of trusted (fully loaded) plugins. Reads under them stay
  // restricted and grantable, not path-escape hard-denies; writes remain
  // hard-denies — plugin trust is not write consent.
  trustedPluginRoots?: RootsProvider;
  // Extras-denied config paths the shell legs treat as sensitive (the active
  // settings source, including a --config override). Mirrors the secret-guard
  // plugin's extraDeniedPaths so a custom config path asks like the default
  // settings file. May be set later via setSensitiveExtraDeniedPaths.
  sensitiveExtraDeniedPaths?: readonly string[];
  // Tiers learned from connected MCP servers (tools/list annotations).
  mcpTiers?: McpToolPermissionRegistry;
  // Fires synchronously after a grant is minted so callers can drain requests
  // already queued behind the one just answered (see isRequestCoveredByGrant).
  // `covers` answers whether an already-queued request is drained; the gate
  // supplies it because only the gate holds the session-cwd path restriction.
  onGrant?:
    | ((
        approval: Approval,
        covers: (request: PermissionRequest) => boolean,
      ) => void)
    | undefined;
  // Records that a prompt was shown and how it was answered. A gate built
  // without one stays silent.
  telemetry?: Telemetry | undefined;
  // This gate's decisions go through the reactor's before-tool authz seam
  // (env.authorize) instead of evaluate() in the tool-runner middleware.
  // Required so a caller cannot silently fall back to middleware gating.
  reactorGated: boolean;
  // Ask/settle event log (approval-log.ts). Defaults to a no-op.
  approvalLog?: ApprovalLog;
}

export type AuthorizeVerdict =
  | { effect: "allow" }
  | { effect: "deny"; reason: string }
  | { effect: "ask"; request: PermissionRequest };

export interface PermissionGate {
  evaluate: (call: ToolCall) => Promise<GateVerdict>;
  // Reactor-path policy: the same decision evaluate() makes, as the effect the
  // vendored before-tool authz hook consumes.
  authorizeCall: (call: ToolCall) => Promise<AuthorizeVerdict>;
  // Execution-time backstop for reactor-gated posix/MCP middleware: consumes
  // the cached authorizeCall verdict for the same call identity; decides only
  // on a miss.
  executionVerdict: (call: ToolCall) => Promise<AuthorizeVerdict>;
  // Resolve a suspended reactor approval against the operator; mints the
  // outcome's grant when the session identity is still current. Returns
  // undefined when no outcome arrived.
  resolveSuspended: (
    request: PermissionRequest,
    stillCurrent?: () => boolean,
  ) => Promise<ApprovalOutcome | undefined>;
  // True when decisions go through env.authorize rather than evaluate().
  // Under reactor gating, gateToolCall consumes the cached verdict and
  // decides on a miss, so an approved re-dispatch never re-asks.
  isReactorGated: () => boolean;
  // The gate's current in-memory approvals, including any granted this session.
  getApprovals: () => readonly Approval[];
  // Forget every remembered approval so a fresh session re-prompts from scratch.
  reset: () => void;
  // Drop cached operator/headless denies so the next user turn re-asks.
  clearDenials: () => void;
  // The approvals granted only for this session (not persisted to any store).
  getSessionApprovals: () => readonly Approval[];
  // Drop one approval from the live list and the session set so /permissions
  // can revoke a session grant without a restart.
  removeSessionApproval: (target: Approval) => void;
  // Replace the persisted portion of the live list (session grants are kept)
  // so a /permissions store edit takes effect immediately.
  setSeededApprovals: (seeded: readonly Approval[]) => void;
  // Whether auto mode is on. Auto mode auto-approves non-destructive
  // consequential actions without prompting.
  getAuto: () => boolean;
  // Turn auto mode on or off for the rest of the session. Live callers wire
  // the toggle here so it takes effect on the next tool call. `/yolo` toggles
  // skip-permissions, not auto mode.
  setAuto: (value: boolean) => void;
  // Whether --dangerously-skip-permissions / yolo mode is active. Pre-gate
  // sandboxes consult this so outside-workspace access is not hard-denied.
  getSkipPermissions: () => boolean;
  // Turn skip-permissions on or off for the rest of the session. `/yolo` in
  // the TUI wires the toggle here so it takes effect on the next tool call.
  setSkipPermissions: (value: boolean) => void;
  // Repoint matching and newly minted provider-model grants at a different
  // providerName:model. A live `/model` switch calls this.
  setProviderIdentity: (providerName: string, model: string) => void;
  registerMcpClient: (client: MCPClient) => void;
  unregisterMcpServer: (serverName: string) => void;
  // Live trusted plugin directories for path-escape's read exception, shared
  // by authorize-time and execution-time containment.
  getTrustedPluginRoots: () => readonly string[];
  // Replace the extras-denied config paths the shell legs treat as sensitive.
  // The toolset builder calls this to forward the active settings source after
  // gate construction. Optional so test doubles keep compiling.
  setSensitiveExtraDeniedPaths?: (paths: readonly string[]) => void;
}

// True when splitChainedCommand can be trusted to yield only real segments for
// grant minting. False for patterns that confuse the no-backslash-escape
// splitter into phantom segments — those mint as one exact whole-pattern grant.
function canSafelyMintPerSegment(pattern: string): boolean {
  if (/\\["`]/.test(pattern)) return false;
  if (pattern.includes("#")) return false;
  return true;
}

// Cache identity must use the same path resolution pathEscapePlugin applies
// before gateToolCall, so an authorizeCall allow is not re-decided at
// execution.
function identityArguments(
  args: ToolCall["arguments"],
  cwd: string,
  rootsProvider: RootsProvider,
  trustedPluginRoots?: RootsProvider,
): string {
  return JSON.stringify(
    normalizePathArguments(args, cwd, rootsProvider, trustedPluginRoots),
  );
}

function withCanonicalToolName(call: ToolCall): ToolCall {
  const name = canonicalToolName(call.name);
  return name === call.name ? call : { ...call, name };
}

/** Coerce hidden Codex argv/workdir onto run_shell before policy, not after. */
function coercePolicyCall(rawCall: ToolCall): ToolCall {
  const named = withCanonicalToolName(rawCall);
  return prepareDispatchedToolCall(named, named.name);
}

function callForIdentity(rawCall: ToolCall): ToolCall {
  try {
    return coercePolicyCall(rawCall);
  } catch {
    return withCanonicalToolName(rawCall);
  }
}

export function createPermissionGate(
  options: PermissionGateOptions,
): PermissionGate {
  const { requestApproval, persist, interactive, providerName, model, cwd } =
    options;
  const reactorGated = options.reactorGated;
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;
  const approvalLog = options.approvalLog ?? NOOP_APPROVAL_LOG;
  const mcpTiers = options.mcpTiers ?? createMcpToolPermissionRegistry();
  const resolvedCwd = cwd ?? process.cwd();
  const rootsProvider =
    options.rootsProvider ?? createWorktreeRootsProvider(resolvedCwd);
  const trustedPluginRoots = options.trustedPluginRoots ?? (() => []);
  const pathRestriction = createPathRestriction(resolvedCwd, rootsProvider);
  const isRestricted = pathRestriction.isRestricted;
  // This gate's project boundary for grant matching (cwdMatchesGrant): the
  // session root plus currently-known registered worktrees, from the same
  // rootsProvider path containment uses.
  const grantWorkspace = (): GrantWorkspace => ({
    resolvedCwd,
    roots: rootsProvider(),
  });
  let auto = options.auto;
  let skipPermissions = options.skipPermissions;
  // Private copy so evaluating never mutates the caller's array. Seeded grants
  // enter in native key space (normalizeSeededApprovals).
  const approvals: Approval[] = normalizeSeededApprovals(options.approvals);
  let activeProviderModel =
    providerName !== undefined && model !== undefined
      ? `${providerName}:${model}`
      : undefined;
  // Session grants live only in this array; persisted grants route to a store
  // via the persist callback.
  const sessionGrants: Approval[] = [];
  // Extras-denied config paths the shell legs consult, mirrored from the
  // secret-guard plugin's matcher. Mutable via setSensitiveExtraDeniedPaths
  // because the toolset builder learns them after gate construction.
  let isExtraDenied = createExtraDeniedPathMatcher(
    options.sensitiveExtraDeniedPaths ?? [],
  );

  // Records an operator-granted approval and routes it to its scope home. The
  // single place a grant comes into existence.
  const mintGrant = (requestedTool: string, outcome: ApprovalOutcome): void => {
    // Mint in native key space; live requests are already post-coercion.
    const tool = canonicalToolName(requestedTool);
    if (!outcome.persist || outcome.persist.pattern === null) return;
    const grant: GrantScope = outcome.persist.grant ?? "session";
    // Strip any model-authored comment line first so every stored run_shell
    // pattern is in the space grant matching works against. Decompose chains
    // into one Approval per real segment (same quote-aware splitter evaluate
    // uses), so approving `a && b` grants `a` and `b` individually. When the
    // pattern contains backslash escapes or inline `#` comments, the naive
    // splitter can invent phantom segments — fall back to one exact grant for
    // the whole pattern instead of minting those phantoms.
    const normalizedPattern =
      tool === "run_shell"
        ? stripCommentLines(outcome.persist.pattern).trim()
        : outcome.persist.pattern;
    const shellSegments =
      tool === "run_shell"
        ? splitChainedCommand(normalizedPattern).filter(
            (segment) => !isShellCommentOnly(segment),
          )
        : [];
    const mintPerSegment =
      tool === "run_shell" &&
      shellSegments.length > 1 &&
      canSafelyMintPerSegment(normalizedPattern);
    const patterns = mintPerSegment
      ? shellSegments.map((segment) => escapeGlobLiteral(segment.trim()))
      : [normalizedPattern];
    for (const pattern of patterns) {
      const approval: Approval =
        grant === "provider-model" && activeProviderModel !== undefined
          ? { tool, pattern, providerModel: activeProviderModel }
          : grant === "project"
            ? { tool, pattern, cwd: resolvedCwd }
            : { tool, pattern };
      approvals.push(approval);
      if (grant === "session") {
        sessionGrants.push(approval);
      } else {
        persist?.(approval, grant);
      }
      options.onGrant?.(approval, (request) =>
        isRequestCoveredByApprovals(
          request,
          approvals,
          activeProviderModel,
          isRestricted,
          grantWorkspace(),
          rootsProvider,
          isExtraDenied,
        ),
      );
    }
    // A new grant can cover a previously-denied request — drop cached denies
    // so the retry re-evaluates against the live approvals.
    denialMemory.clear();
  };

  // An auto-mode (or headless) decision settles the instant it is made — no
  // operator to wait on. Interactive prompts log via approvalLog.ask directly
  // so their real timestamps are captured.
  const recordAutoDecision = (
    tool: string,
    rule: string | undefined,
    outcome: ApprovalOutcomeKind,
  ): void => {
    approvalLog
      .ask({
        tool,
        mode: "auto",
        ...(rule !== undefined ? { rule } : {}),
      })
      .settle(outcome);
  };

  // Consume-once handoff from env.authorize to execution-time middleware.
  // call.id is reused for every Codex proxy inner posix op, so a lasting set
  // would mute later JSONL records; a hit still requires matching name and
  // arguments. Path-like arguments compare after the workspace resolve
  // pathEscapePlugin applies. reset() clears leftovers.
  const authorizedByCallId = new Map<
    string,
    { name: string; arguments: string; verdict: AuthorizeVerdict }
  >();

  // Same-turn denial memory: stable fingerprints of headless and
  // operator-declined denies so a retry with a fresh tool_call.id returns the
  // identical cached reason. Cleared on user turns, reset(), and every state
  // change that can flip a deny to an allow. Timeouts and aborts are never
  // recorded.
  const denialMemory = new DenialMemory();

  // Single canonical denial key: the raw call coerced onto its engine id
  // before the stable request id, so a same-turn retry in any shape — raw,
  // coerced, or fresh tool_call.id — fingerprints identically. Coercion is
  // idempotent, so all decline paths share one derivation.
  const denialFingerprint = (rawCall: ToolCall, cwd: string): string =>
    stableRequestId(
      callForIdentity(rawCall),
      cwd,
      rootsProvider,
      trustedPluginRoots,
    );

  // Non-blocking policy decision for one tool call — every gate rule resolved
  // without waiting on an operator. `ask` carries the fully-built request so
  // evaluate() (middleware) and authorizeCall() (reactor seam) need no
  // re-derivation.
  type GateDecision =
    | { kind: "allow" }
    | { kind: "deny"; reason: string }
    | {
        kind: "ask";
        request: PermissionRequest;
        anySecret: boolean;
        segmentCount: number;
      };

  const decide = async (rawCall: ToolCall): Promise<GateDecision> => {
    let call: ToolCall;
    try {
      call = coercePolicyCall(rawCall);
    } catch (err) {
      return {
        kind: "deny",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // Catastrophic shell commands are hard-denied here, at the top of the
    // single verdict path every entry flows through. The verdict is invariant
    // across modes (auto, headless, skipPermissions). Judged against the full
    // command string, not per split segment, so a stage that only reads
    // bounded, already-piped data (e.g. `git show sha:path | rg -n foo`) is
    // not denied in isolation. Runs before every grant shortcut — a stored
    // grant must never admit a hard-denied command (preGrantGuardReason).
    if (call.name === "run_shell") {
      const command = String(call.arguments.command ?? "");
      const block = runShellAuthzBlock(command);
      const inspection = inspectShellSecretReference(
        command,
        resolvedCwd,
        isExtraDenied,
      );
      const opaqueAsks =
        block?.kind === "stdin" &&
        inspection.reference === undefined &&
        shellSecretInspectionRequiresApproval(inspection);
      if (block !== undefined && !opaqueAsks) {
        return { kind: "deny", reason: block.reason };
      }
    }
    if (skipPermissions) return { kind: "allow" };
    // Sub-agent calls run under ALS identity (identity-context.ts); the process
    // cwd is the worktree. Every relative-path judgment below must use it so
    // auto-allow and restriction match what the shell will open.
    const subAgentIdentity = getSubAgentIdentity();
    const effectiveCwd = subAgentIdentity?.cwd ?? resolvedCwd;

    // A same-turn retry of an already-denied request returns the identical
    // cached reason instead of re-evaluating and re-logging. Runs before the
    // path-escape deny so the reason text is the originally recorded one.
    // Fingerprint the raw call, not the coerced `call` above — coercion is
    // idempotent, so all three decline paths share one key.
    const stableId = denialFingerprint(rawCall, effectiveCwd);
    const cachedDenial = denialMemory.isDenied(stableId);
    if (cachedDenial !== undefined)
      return { kind: "deny", reason: cachedDenial };

    // Path-escape will hard-reject these at execution; deny here rather than
    // showing Accept for a call that cannot succeed. Workers sandbox against
    // their own cwd's roots, not the session listing.
    const escapeRoots =
      effectiveCwd === resolvedCwd
        ? rootsProvider
        : createWorktreeRootsProvider(effectiveCwd);
    const escapeReason = pathEscapeBlockReason(
      call.arguments,
      effectiveCwd,
      escapeRoots,
      call.name,
      trustedPluginRoots,
    );
    if (escapeReason !== undefined) {
      return { kind: "deny", reason: escapeReason };
    }

    const isRestrictedHere = bindRestrictedToProcessCwd(
      isRestricted,
      effectiveCwd,
    );
    // A restricted in-bounds path (a write under the session state root)
    // drops from allow to ask, so it never auto-allows on tier or
    // shell-safety below.
    const restricted = callTargetsRestricted(call, isRestrictedHere);
    const shellCmd =
      call.name === "run_shell" && typeof call.arguments.command === "string"
        ? call.arguments.command
        : undefined;
    // Full-command secret check: whole-call auto-allow and headless messaging.
    // Per-segment checks below govern grants and auto-skip so a safe pipeline
    // tail (`| sort`) is not re-prompted when only an earlier segment mentions
    // a secret path.
    const shellRequiresSecretApproval =
      shellCmd !== undefined &&
      shellSecretInspectionRequiresApproval(
        inspectShellSecretReference(shellCmd, effectiveCwd, isExtraDenied),
      );
    if (!restricted && classifyTool(call.name, mcpTiers) === "allow") {
      return { kind: "allow" };
    }
    if (
      !restricted &&
      !shellRequiresSecretApproval &&
      isAutoAllowedShellCall(call, effectiveCwd, rootsProvider, isExtraDenied)
    ) {
      return { kind: "allow" };
    }
    if (auto) {
      if (call.name === "run_shell") {
        // Auto-shell policy: `deny` blocks outright, `ask` falls through to the
        // operator prompt, everything else auto-allows. Path-keyed secret
        // reads stay hard-denied by secret-guard; shell that only mentions a
        // secret path is ask.
        const shellRule = autoShellRuleForCall(
          call,
          isRestrictedHere,
          effectiveCwd,
          rootsProvider,
          isExtraDenied,
        );
        if (shellRule?.effect === "deny") {
          recordAutoDecision(call.name, shellRule.name, "auto-deny");
          return { kind: "deny", reason: shellRule.reason };
        }
        if (shellRule === undefined) {
          recordAutoDecision(call.name, undefined, "auto-allow");
          return { kind: "allow" };
        }
      } else if (!restricted && AUTO_ALLOWED_TOOLS.has(call.name)) {
        recordAutoDecision(call.name, "auto-allowed-tool", "auto-allow");
        return { kind: "allow" };
      }
      // Any other tool in auto mode (MCP or unknown built-in) is not
      // blanket-allowed; fall through to the operator prompt below.
    }

    // When present, the prompt is attributed to that sub-agent instead of the
    // top-level session.
    for (const rawRequest of buildRequests(call)) {
      const request: typeof rawRequest = {
        ...rawRequest,
        cwd: effectiveCwd,
        ...(subAgentIdentity !== undefined
          ? { agentLabel: subAgentIdentity.description }
          : {}),
      };
      // Shell: security splits the chain, but the operator sees the full
      // command once. Any unapproved segment fails the whole block, and
      // execution always runs the full string the model asked for.
      if (request.tool === "run_shell") {
        const fullCommand = request.subject;
        const segments = splitChainedCommand(fullCommand).filter(
          (segment) => !isShellCommentOnly(segment),
        );
        if (segments.length === 0) continue;

        // Catastrophic commands were already hard-denied at the top of the
        // verdict path before any grant shortcut could admit them.

        let needsOperator = false;
        let anySecret = false;
        let mismatchNotice: string | undefined;
        for (const segment of segments) {
          // A secret-path reference or restricted target always requires the
          // operator — a grant approved for a safe command must never replay
          // for a guarded one just because the pattern matches. Same guard
          // preGrantGuardReason applies before queue reconciliation.
          const guard = segmentGuard(
            segment,
            isRestrictedHere,
            effectiveCwd,
            rootsProvider,
            isExtraDenied,
          );
          if (guard !== undefined) {
            if (guard.kind !== "restricted") anySecret = true;
            needsOperator = true;
            // A standing grant may still cover this segment while the pre-grant
            // guard forces an ask — record why so the prompt can say so.
            if (
              mismatchNotice === undefined &&
              (await approvalCoversSubject({
                tool: request.tool,
                subject: segment,
                approvals,
                activeProviderModel,
                requestCwd: effectiveCwd,
                workspace: grantWorkspace(),
              }))
            ) {
              mismatchNotice = grantMismatchNotice(segment, guard.kind);
            }
            continue;
          }
          if (
            await approvalCoversSubject({
              tool: request.tool,
              subject: segment,
              approvals,
              activeProviderModel,
              requestCwd: effectiveCwd,
              workspace: grantWorkspace(),
            })
          ) {
            continue;
          }
          // Safe pipeline tails (`| sort`) and pure no-ops (`|| true`) skip.
          if (
            isAutoAllowedShellSegment(
              segment,
              effectiveCwd,
              rootsProvider,
              isExtraDenied,
            )
          ) {
            continue;
          }
          needsOperator = true;
        }
        if (!needsOperator) continue;

        const askRule = anySecret ? "sensitive-path" : undefined;

        if (!interactive || requestApproval === undefined) {
          recordAutoDecision(
            request.tool,
            askRule ?? "non-interactive",
            "deny",
          );
          const reason = anySecret
            ? `${request.action} references a sensitive path and requires operator approval, which is unavailable in a non-interactive run.`
            : `${request.action} requires operator approval, which is unavailable in a non-interactive run. Re-run with --dangerously-skip-permissions to bypass, or narrow the action.`;
          denialMemory.record(stableId, reason);
          options.onHeadlessDeny?.(reason);
          return { kind: "deny", reason };
        }

        // Secret-path shell must never mint a stored grant — future secret-path
        // shell always re-asks. A grant mismatch carries the guard's reason on
        // the prompt so the operator sees why the standing grant did not apply.
        const requestForOperator = anySecret
          ? {
              ...request,
              scopes: [],
              ...(mismatchNotice !== undefined
                ? { notice: mismatchNotice }
                : null),
            }
          : mismatchNotice !== undefined
            ? { ...request, notice: mismatchNotice }
            : request;
        return {
          kind: "ask",
          request: requestForOperator,
          anySecret,
          segmentCount: segments.length,
        };
      }

      // Path-arg tools already drop to ask via callTargetsRestricted; grants
      // match on the path subject the same as before.
      const alreadyApproved = await approvalCoversSubject({
        tool: request.tool,
        subject: request.subject,
        approvals,
        activeProviderModel,
        requestCwd: effectiveCwd,
        workspace: grantWorkspace(),
      });
      if (alreadyApproved) {
        continue;
      }

      if (!interactive || requestApproval === undefined) {
        recordAutoDecision(request.tool, "non-interactive", "deny");
        const reason = `${request.action} requires operator approval, which is unavailable in a non-interactive run. Re-run with --dangerously-skip-permissions to bypass, or narrow the action.`;
        denialMemory.record(stableId, reason);
        options.onHeadlessDeny?.(reason);
        return { kind: "deny", reason };
      }

      return { kind: "ask", request, anySecret: false, segmentCount: 0 };
    }
    return { kind: "allow" };
  };

  // Resolve an `ask` decision against the operator: log it, open the wait
  // span, await the seam, settle, and mint any grant the outcome carries
  // (never for secret-path shell). Returns undefined when no outcome arrived.
  const resolveInteractiveAsk = async (
    decision: Extract<GateDecision, { kind: "ask" }>,
    stillCurrent?: () => boolean,
  ) => {
    const { request, anySecret, segmentCount } = decision;
    const askRule = anySecret ? "sensitive-path" : undefined;
    const ask = approvalLog.ask({
      tool: request.tool,
      mode: "interactive",
      ...(askRule !== undefined ? { rule: askRule } : {}),
      ...(request.tool === "run_shell" ? { segments: segmentCount } : {}),
    });
    request.markDisplayed = ask.markDisplayed;
    const turnId = currentTurnId();
    const waitSpanId = start("permission.wait", {
      ...(turnId !== null && turnId.length > 0 ? { parentId: turnId } : {}),
      tags: { tool_id: request.tool },
    });
    let outcome: ApprovalOutcome | undefined;
    const prompt = requestApproval;
    if (prompt === undefined) {
      // Unreachable: an ask decision is only produced when a prompt seam is
      // wired (decide returns deny in headless mode before reaching here).
      throw new Error("ask decision resolved without requestApproval wiring");
    }
    try {
      outcome = await prompt(request);
    } finally {
      finishApprovalWait(telemetry, waitSpanId, request.tool, outcome);
      ask.settle(classifyOutcome(outcome));
    }
    if (
      outcome !== undefined &&
      outcome.allow &&
      !anySecret &&
      (stillCurrent?.() ?? true)
    ) {
      mintGrant(request.tool, outcome);
    }
    return outcome;
  };

  // Operator-decline reason for a decided-ask request and its outcome, shared
  // by the middleware and reactor paths so a cached decline reads identically.
  const declineReason = (
    request: PermissionRequest,
    outcome: ApprovalOutcome | undefined,
  ): string => {
    const suffix =
      outcome?.message !== undefined && outcome.message.length > 0
        ? ` — ${outcome.message}`
        : "";
    return `${OPERATOR_DECLINED_PREFIX}${request.action} (${request.subject})${suffix}`;
  };

  // Middleware path: blocking evaluation for tool-runner consumers whose calls
  // never pass through the reactor. Reactor-gated gates use executionVerdict
  // instead, so ask never re-prompts.
  const evaluate = async (rawCall: ToolCall): Promise<GateVerdict> => {
    const decision = await decide(rawCall);
    if (decision.kind === "allow") return { allowed: true };
    if (decision.kind === "deny")
      return { allowed: false, reason: decision.reason };
    const outcome = await resolveInteractiveAsk(decision);
    if (outcome === undefined || !outcome.allow) {
      const reason = declineReason(decision.request, outcome);
      // Cache operator declines so a same-turn retry denies with the identical
      // reason. Timeouts, aborts, and missing outcomes are never cached — the
      // retry must ask again. The key derives from the raw call through the
      // one canonical coercion, so a coerced-shape retry hits the same entry.
      if (
        outcome !== undefined &&
        !outcome.allow &&
        classifyOutcome(outcome) === "deny"
      ) {
        denialMemory.record(
          denialFingerprint(rawCall, getSubAgentIdentity()?.cwd ?? resolvedCwd),
          reason,
        );
      }
      return { allowed: false, reason };
    }
    return { allowed: true };
  };

  // Reactor path: evaluate()'s decision as the effect the vendored before-tool
  // authz hook consumes — `ask` suspends the call keyed by the hook-minted
  // correlationId. authorizeCall stashes the verdict for gateToolCall.
  const mapAuthorizeVerdict = (decision: GateDecision): AuthorizeVerdict => {
    switch (decision.kind) {
      case "allow":
        return { effect: "allow" };
      case "deny":
        return { effect: "deny", reason: decision.reason };
      case "ask":
        return { effect: "ask", request: decision.request };
    }
  };

  const authorizeCall = async (call: ToolCall): Promise<AuthorizeVerdict> => {
    const verdict = mapAuthorizeVerdict(await decide(call));
    const identityCwd = getSubAgentIdentity()?.cwd ?? resolvedCwd;
    const identityCall = callForIdentity(call);
    authorizedByCallId.set(call.id, {
      name: canonicalToolName(identityCall.name),
      arguments: identityArguments(
        identityCall.arguments,
        identityCwd,
        rootsProvider,
        trustedPluginRoots,
      ),
      verdict,
    });
    return verdict;
  };

  const executionVerdict = async (
    call: ToolCall,
  ): Promise<AuthorizeVerdict> => {
    const cached = authorizedByCallId.get(call.id);
    const identityCwd = getSubAgentIdentity()?.cwd ?? resolvedCwd;
    const identityCall = callForIdentity(call);
    if (
      cached !== undefined &&
      cached.name === canonicalToolName(identityCall.name) &&
      cached.arguments ===
        identityArguments(
          identityCall.arguments,
          identityCwd,
          rootsProvider,
          trustedPluginRoots,
        )
    ) {
      authorizedByCallId.delete(call.id);
      return cached.verdict;
    }
    return mapAuthorizeVerdict(await decide(call));
  };

  // Resolve a suspended reactor approval once the operator answers. The
  // request is the one authorizeCall built, so ask log, wait span, and grant
  // minting match the middleware path.
  const resolveSuspended = (
    request: PermissionRequest,
    stillCurrent?: () => boolean,
  ) => {
    const secret =
      request.tool === "run_shell"
        ? inspectShellSecretReference(
            request.subject,
            request.cwd,
            isExtraDenied,
          )
        : undefined;
    const anySecret =
      secret !== undefined && shellSecretInspectionRequiresApproval(secret);
    const decision = {
      kind: "ask" as const,
      request,
      anySecret,
      segmentCount:
        request.tool === "run_shell"
          ? splitChainedCommand(request.subject).filter(
              (s) => !isShellCommentOnly(s),
            ).length
          : 0,
    };
    return (async () => {
      const outcome = await resolveInteractiveAsk(decision, stillCurrent);
      // Cache operator declines so a same-turn reactor retry denies with the
      // identical reason; timeouts/aborts/missing outcomes never cache.
      // Rebuild the denied ToolCall from the suspended request through the one
      // canonical helper decide()/evaluate() use. The suspended request
      // carries {command} only (buildRequests drops the workdir cwd), so the
      // recorded key is {command}-keyed while a same-workdir retry's key is
      // {command, cwd}-keyed: the retry misses and re-asks (fail-safe), and a
      // cwd-less retry hits the workdir record and denies (fail-closed). The
      // synthesized id never participates (stableRequestId ignores id).
      if (
        outcome !== undefined &&
        !outcome.allow &&
        classifyOutcome(outcome) === "deny"
      ) {
        const suspendedCall = callForIdentity({
          id: "",
          name: request.tool,
          arguments: request.arguments ?? {},
        });
        denialMemory.record(
          denialFingerprint(
            suspendedCall,
            request.cwd ?? getSubAgentIdentity()?.cwd ?? resolvedCwd,
          ),
          declineReason(request, outcome),
        );
      }
      return outcome;
    })();
  };

  const reset = (): void => {
    for (const grant of sessionGrants) {
      const index = approvals.indexOf(grant);
      if (index !== -1) approvals.splice(index, 1);
    }
    sessionGrants.length = 0;
    authorizedByCallId.clear();
    denialMemory.clear();
  };

  const sameApproval = (a: Approval, b: Approval): boolean =>
    a.tool === b.tool &&
    a.pattern === b.pattern &&
    a.providerModel === b.providerModel;

  const getSessionApprovals = (): readonly Approval[] => [...sessionGrants];

  const removeSessionApproval = (target: Approval): void => {
    for (let i = approvals.length - 1; i >= 0; i--) {
      const approval = approvals[i];
      if (approval !== undefined && sameApproval(approval, target))
        approvals.splice(i, 1);
    }
    for (let i = sessionGrants.length - 1; i >= 0; i--) {
      const grant = sessionGrants[i];
      if (grant !== undefined && sameApproval(grant, target))
        sessionGrants.splice(i, 1);
    }
  };

  const setSeededApprovals = (seeded: readonly Approval[]): void => {
    approvals.length = 0;
    approvals.push(...normalizeSeededApprovals(seeded), ...sessionGrants);
    // Re-seeded approvals can flip a deny to an allow — cached denies re-evaluate.
    denialMemory.clear();
  };

  const registerMcpClient = (client: MCPClient): void => {
    registerMcpClientTools(mcpTiers, client.serverName, client.tools);
  };

  const unregisterMcpServer = (serverName: string): void => {
    mcpTiers.removeToolsForServer(serverName);
  };

  return {
    evaluate,
    authorizeCall,
    executionVerdict,
    resolveSuspended,
    isReactorGated: () => reactorGated,
    getApprovals: () => approvals,
    reset,
    clearDenials: () => denialMemory.clear(),
    getSessionApprovals,
    removeSessionApproval,
    setSeededApprovals,
    getAuto: () => auto === true,
    setAuto: (value: boolean) => {
      auto = value;
      // Mode changes can flip denies to allows — cached denies re-evaluate.
      denialMemory.clear();
    },
    getSkipPermissions: () => skipPermissions,
    setSkipPermissions: (value: boolean) => {
      skipPermissions = value;
      // Mode changes can flip denies to allows — cached denies re-evaluate.
      denialMemory.clear();
    },
    setProviderIdentity: (nextProviderName: string, nextModel: string) => {
      activeProviderModel = `${nextProviderName}:${nextModel}`;
      // Provider-model grants key off this identity — cached denies re-evaluate.
      denialMemory.clear();
    },
    registerMcpClient,
    unregisterMcpServer,
    getTrustedPluginRoots: () => trustedPluginRoots(),
    setSensitiveExtraDeniedPaths: (paths: readonly string[]) => {
      isExtraDenied = createExtraDeniedPathMatcher(paths);
      // The denied set changed — cached denies re-evaluate.
      denialMemory.clear();
    },
  };
}
