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
import { autoShellRuleForCall, safeWorktreeCommand } from "./auto-shell-policy.js";
import { commandReferencesSensitivePath } from "../plugins/secret-guard-plugin.js";
import { runShellAuthzBlockReason } from "../shell/run-shell-authz.js";
import { matchesPattern, escapeGlobLiteral } from "./matcher.js";
import { evaluateApprovals, grantScopeMatches, type GrantWorkspace } from "./authz-grants.js";
import { splitChainedCommand, isShellCommentOnly, stripCommentLines } from "./command.js";
import { createPathRestriction } from "./path-restriction.js";
import { createWorktreeRootsProvider, type RootsProvider } from "./worktree-roots.js";
import { getSubAgentIdentity } from "../subagent/identity-context.js";
import { PRODUCT_MUTATION_TOOLS } from "../agent/product-mutation-tools.js";

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
import { NOOP_APPROVAL_LOG, type ApprovalLog, type ApprovalOutcomeKind } from "./approval-log.js";

// Closes out an operator prompt: ends the wait span and records the outcome.
// buildRequests yields at most one request per tool call, and the two prompt
// sites below are mutually exclusive, so this runs once per prompt shown.
// Classifies a settled ApprovalOutcome into the approval-log taxonomy.
// gate-wire.ts's timeout/abort auto-denies carry a fixed message text (see
// autoDeny in gate-wire.ts and the timeout branch in tui/request-approval.ts's
// finish() usage); anything else that denies is a plain operator/unavailable
// decision.
function classifyOutcome(outcome: ApprovalOutcome | undefined): ApprovalOutcomeKind {
  if (outcome === undefined) return "deny";
  if (!outcome.allow) {
    const message = outcome.message ?? "";
    if (message.includes("timed out")) return "timeout";
    if (message.includes("no longer running")) return "abort";
    return "deny";
  }
  return outcome.persist !== undefined ? "allow-with-scope" : "allow-once";
}

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

export type GateVerdict = { allowed: true } | { allowed: false; reason: string };

// One shell segment's forced-ask guard: a secret-path reference or a
// restricted target, either of which forces an operator decision no matter
// what a grant would otherwise cover. Shared by evaluate() (which also needs
// to know *which* guard tripped, to drive the anySecret behavior below) and
// preGrantGuardReason (which only needs to know whether one tripped).
interface SegmentGuard {
  kind: "secret" | "restricted";
}

// `cwd`/`rootsProvider`, when both supplied, let a contained or
// permitted-sibling `git worktree add/remove` destination (see
// safeWorktreeCommand) skip the generic restricted-path scan below — the
// same exemption auto mode already applies (autoShellRuleForCall) — so a
// standing `git worktree *` grant gets a chance to match instead of the
// destination forcing an ask on every call regardless of any grant. Omitted
// (as from call sites with no cwd on hand) simply skips the exemption and
// falls back to today's behavior.
function segmentGuard(
  segment: string,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  cwd?: string,
  rootsProvider?: RootsProvider,
): SegmentGuard | undefined {
  if (commandReferencesSensitivePath(segment) !== undefined) return { kind: "secret" };
  if (
    cwd !== undefined &&
    rootsProvider !== undefined &&
    safeWorktreeCommand(segment, isRestricted, cwd, rootsProvider) === true
  ) {
    return undefined;
  }
  if (commandTargetsRestricted(segment, isRestricted)) return { kind: "restricted" };
  return undefined;
}

// Relative path tokens in a shell command resolve against the process cwd of the
// agent that issued the call — not the session cwd that built the gate. Absolute
// paths pass through unchanged so createPathRestriction still judges them against
// the session workspace + registered worktree roots. Without this rebinding, a
// sub-agent in an isolated worktree would have `cat secrets.txt` auto-allowed or
// restriction-checked as if it opened `$SESSION/secrets.txt` while the shell
// actually opened `$WORKTREE/secrets.txt`.
function bindRestrictedToProcessCwd(
  isRestricted: (path: string, isWrite: boolean) => boolean,
  processCwd: string,
): (path: string, isWrite: boolean) => boolean {
  return (path, isWrite) => {
    const anchored = isAbsolute(path) ? path : resolve(processCwd, path);
    return isRestricted(anchored, isWrite);
  };
}

// Every guard a run_shell request must clear BEFORE it is ever matched
// against a grant — hard-deny and forced-ask checks that no grant, however
// broad, is allowed to bypass. This is the single place that sequence is
// owned: both evaluate() and isRequestCoveredByGrant call it (directly or
// via segmentGuard), so a guard added here automatically applies to fresh
// requests and to reconciliation of already-queued ones alike. Returns the
// deny/ask reason if any guard trips, or undefined when the request is clear
// to proceed to grant evaluation. Non-shell tools have no pre-grant guard
// sequence today, so this always returns undefined for them.
export function preGrantGuardReason(
  request: PermissionRequest,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  rootsProvider?: RootsProvider,
): string | undefined {
  if (request.tool !== "run_shell") return undefined;
  const fullCommand = request.subject;
  const segments = splitChainedCommand(fullCommand).filter((s) => !isShellCommentOnly(s));
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
    const guard = segmentGuard(segment, restricted, request.cwd, rootsProvider);
    if (guard !== undefined) {
      return guard.kind === "secret"
        ? `${segment} references a sensitive path`
        : `${segment} targets a restricted path`;
    }
  }
  return undefined;
}

// Pure reconciliation check used to re-evaluate the TUI's pending approval
// queue against newly-minted grant(s) (see PermissionGateOptions.onGrant).
// A queued request is covered only when the supplied approval(s) would let
// evaluate() skip the prompt — same per-segment matching and the same
// preGrantGuardReason sequence — so reconciliation never auto-approves
// something evaluate() would still ask for or hard-deny.
//
// For run_shell, coverage is per-segment: every real segment must match some
// supplied approval (or be an auto-allowed no-op/safe tail). A legacy
// whole-string chain pattern (e.g. `"a && b"`) is not special-cased and does
// not cover — minting decomposes chains into per-segment grants, and evaluate()
// likewise matches per segment only.
export function isRequestCoveredByGrant(
  request: PermissionRequest,
  approval: Approval,
  activeProviderModel: string | undefined,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  workspace: GrantWorkspace,
  rootsProvider?: RootsProvider,
): boolean {
  return isRequestCoveredByApprovals(
    request,
    [approval],
    activeProviderModel,
    isRestricted,
    workspace,
    rootsProvider,
  );
}

// Same coverage predicate as isRequestCoveredByGrant, but against a live
// approvals list. mintGrant hands this to onGrant so that after per-segment
// minting of `a && b`, the second onGrant sees both `a` and `b` already in the
// list and can drain a queued identical chain.
function isRequestCoveredByApprovals(
  request: PermissionRequest,
  approvals: readonly Approval[],
  activeProviderModel: string | undefined,
  isRestricted: (path: string, isWrite: boolean) => boolean,
  workspace: GrantWorkspace,
  rootsProvider?: RootsProvider,
): boolean {
  const scoped = approvals.filter((a) =>
    grantScopeMatches(a, request.tool, activeProviderModel, request.cwd, workspace),
  );
  if (scoped.length === 0) return false;
  if (request.tool !== "run_shell") {
    return scoped.some((a) => matchesPattern(request.subject, a.pattern));
  }
  if (preGrantGuardReason(request, isRestricted, rootsProvider) !== undefined) return false;
  const segments = splitChainedCommand(request.subject).filter((s) => !isShellCommentOnly(s));
  if (segments.length === 0) return false;
  const cwd = request.cwd ?? workspace.resolvedCwd;
  return segments.every((segment) => {
    if (scoped.some((a) => matchesPattern(segment, a.pattern))) return true;
    return isAutoAllowedShellSegment(segment, cwd, rootsProvider);
  });
}

// In auto mode these non-shell built-in tools auto-allow without an operator
// prompt: file mutations plus the benign built-ins that a hands-off run should
// not stop for. Reads auto-allow via their own path and run_shell via the shell
// policy. Read-only MCP (annotations or list_/get_ prefixes) auto-allows via
// classifyTool. Everything else — ask_operator, unknown built-ins, mutating MCP —
// falls through to prompt.
const AUTO_ALLOWED_TOOLS = new Set([
  ...PRODUCT_MUTATION_TOOLS,
  "manage_tasks",
  "present",
  "tool_search",
  "use_skill",
  "search_agents",
  "spawn_agent",
  "wait_agents",
]);

export interface PermissionGateOptions {
  // Approvals already remembered for this directory. Used only to SEED the gate;
  // the gate copies them and owns its in-memory list, so the caller's array is
  // never mutated and two gates never cross-contaminate through a shared array.
  approvals: Approval[];
  // Surface a request to the operator. Required when interactive.
  requestApproval?: RequestApproval;
  // Persist a newly granted approval to the store selected by `scope`
  // (best-effort). `session` grants are never routed here — they stay in the
  // gate's in-memory list only.
  persist?: (approval: Approval, scope: GrantScope) => void;
  // No operator is attached (headless). An unresolved "ask" becomes a denial
  // unless skipPermissions is set.
  interactive: boolean;
  // The --dangerously-skip-permissions escape hatch: auto-allow anything the
  // authorization layer did not already deny.
  skipPermissions: boolean;
  // Auto-approve non-destructive permissions (repeat writes, safe shell commands).
  auto?: boolean | undefined;
  // The active inference provider name and model. A `provider-model` grant only
  // auto-allows future calls when these still match the grant's providerModel.
  providerName?: string | undefined;
  model?: string | undefined;
  // The workspace root. Used to confine auto-allowed shell reads to the project;
  // a command whose path arguments resolve outside it is never auto-allowed.
  // Defaults to the process cwd (the workspace) when omitted.
  cwd?: string;
  // Supplies additional directories that count as inside the workspace
  // boundary — e.g. the session's registered git worktrees. Read/write/edit
  // paths inside these roots are treated the same as paths inside `cwd`;
  // everything outside every root asks regardless of tool or auto mode.
  // Defaults to a provider that lazily discovers `cwd`'s git worktrees,
  // re-listing (debounced) whenever a checked path is outside the roots it
  // already knows about — so a worktree created mid-session is picked up
  // without a restart.
  rootsProvider?: RootsProvider;
  // Tiers learned from connected MCP servers (tools/list annotations). Tests may
  // inject a shared registry; production gates create one when omitted.
  mcpTiers?: McpToolPermissionRegistry;
  // Fires synchronously right after a grant is minted (in-memory list already
  // updated), before evaluate() moves on to the next request. Callers use this
  // to re-evaluate any requests already queued behind the one just answered —
  // see isRequestCoveredByGrant — so a scope-widening grant drains the rest of
  // the queue instead of re-prompting for coverage it already grants.
  // `covers` answers whether an already-queued request is drained by this
  // grant. The gate supplies it because only the gate holds the path
  // restriction anchored to the session cwd; a caller resolving a sub-agent
  // request's own cwd would clear restrictions the gate still enforces.
  onGrant?:
    ((approval: Approval, covers: (request: PermissionRequest) => boolean) => void) | undefined;
  // Records that a prompt was shown and how it was answered. Injected rather
  // than read from the process-wide handle so a gate built without one is
  // silent by construction.
  telemetry?: Telemetry | undefined;
  // Ask/settle event log (see approval-log.ts): one record per consequential
  // decision, auto or interactive. Defaults to a no-op so nothing depends on
  // logging being wired.
  approvalLog?: ApprovalLog;
}

export interface PermissionGate {
  evaluate: (call: ToolCall) => Promise<GateVerdict>;
  // The gate's current in-memory approvals, including any granted this session.
  getApprovals: () => readonly Approval[];
  // Forget every remembered approval so a fresh session re-prompts from scratch.
  reset: () => void;
  // The approvals granted only for this session (not persisted to any store).
  getSessionApprovals: () => readonly Approval[];
  // Drop one approval from the gate's live list and from the session set so the
  // /permissions surface can revoke a session grant without a restart.
  removeSessionApproval: (target: Approval) => void;
  // Replace the persisted portion of the live list (session grants are kept) so
  // a store edit made through /permissions takes effect immediately.
  setSeededApprovals: (seeded: readonly Approval[]) => void;
  // Whether auto mode is currently on. Auto mode auto-approves non-destructive
  // consequential actions (file writes/edits, unconstrained shell) without prompting.
  getAuto: () => boolean;
  // Turn auto mode on or off for the rest of the session. Live callers (slash
  // commands, settings) wire the toggle here so a switch takes effect on the
  // next tool call. There is currently no in-session key chord for this.
  // `/yolo` toggles skip-permissions (getSkipPermissions / setSkipPermissions),
  // not auto mode.
  setAuto: (value: boolean) => void;
  // Whether --dangerously-skip-permissions / yolo mode is active for this session.
  // Pre-gate sandboxes (path-escape, shell cwd bounds) consult this so
  // outside-workspace access is not hard-denied under yolo mode.
  getSkipPermissions: () => boolean;
  // Turn skip-permissions on or off for the rest of the session. `/yolo` in the
  // TUI wires the toggle here so a switch takes effect on the next tool call —
  // including pre-gate sandboxes that read getSkipPermissions live.
  setSkipPermissions: (value: boolean) => void;
  // Point matching and newly minted provider-model grants at a different
  // providerName:model. A live `/model` switch calls this so a grant scoped to
  // the previous pair no longer auto-allows, and new grants tag the new pair.
  setProviderIdentity: (providerName: string, model: string) => void;
  registerMcpClient: (client: MCPClient) => void;
  unregisterMcpServer: (serverName: string) => void;
}

// True when splitChainedCommand can be trusted to yield only real segments for
// grant minting. False for patterns that confuse the no-backslash-escape
// splitter into phantom segments — those mint as one exact whole-pattern grant.
function canSafelyMintPerSegment(pattern: string): boolean {
  if (/\\["`]/.test(pattern)) return false;
  if (pattern.includes("#")) return false;
  return true;
}

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { requestApproval, persist, interactive, providerName, model, cwd } = options;
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;
  const approvalLog = options.approvalLog ?? NOOP_APPROVAL_LOG;
  const mcpTiers = options.mcpTiers ?? createMcpToolPermissionRegistry();
  const resolvedCwd = cwd ?? process.cwd();
  const rootsProvider = options.rootsProvider ?? createWorktreeRootsProvider(resolvedCwd);
  const pathRestriction = createPathRestriction(resolvedCwd, rootsProvider);
  const isRestricted = pathRestriction.isRestricted;
  // This gate's project boundary for grant matching (see cwdMatchesGrant):
  // this session's root plus its currently-known registered worktrees. Built
  // fresh per read from the same rootsProvider the gate already uses for
  // path containment, so "same project" for a grant and "inside the
  // workspace" for a path share one authority.
  const grantWorkspace = (): GrantWorkspace => ({ resolvedCwd, roots: rootsProvider() });
  let auto = options.auto;
  let skipPermissions = options.skipPermissions;
  // Own a private copy so evaluating a grant never mutates the caller's array.
  const approvals: Approval[] = [...options.approvals];
  let activeProviderModel =
    providerName !== undefined && model !== undefined ? `${providerName}:${model}` : undefined;
  // Session grants live only in this array; persisted grants are seeded in via
  // options.approvals and re-routed to a store by the persist callback.
  const sessionGrants: Approval[] = [];

  // Record an operator-granted approval in the live list and route it to the
  // scope-appropriate home: session grants stay in memory, everything else is
  // persisted. Both approval branches must mint identically — this is the
  // single place a grant comes into existence.
  const mintGrant = (tool: string, outcome: ApprovalOutcome): void => {
    if (!outcome.persist || outcome.persist.pattern === null) return;
    const grant: GrantScope = outcome.persist.grant ?? "session";
    // A run_shell pattern may still carry a model-authored comment line (the
    // multi-segment chain scope persists the command verbatim as its payload).
    // Strip it here, at the single place a grant comes into existence, so every
    // stored run_shell pattern is already in the same normalized space grant
    // matching works against.
    //
    // Decompose the chain payload into one Approval per real segment (reusing
    // the same quote-aware splitter the gate's own evaluation loop uses) so
    // approving `a && b` grants `a` and `b` individually — reusable on their
    // own. That is broader than a whole-string grant was (a segment can replay
    // outside the original chain); the CHANGELOG Security note documents the
    // tradeoff. onGrant's covers predicate consults the live approvals list so
    // a queued identical chain drains only once every segment has been minted.
    //
    // splitChainedCommand / tokenize intentionally have no backslash-escape
    // support (CL-6988 / #673 rely on that so misparsed wrappers stay opaque).
    // When the pattern contains escapes or inline `#` comments, the naive
    // splitter can invent phantom segments (`printf "…\" && evil"` → `evil`).
    // Fall back to one exact grant for the whole normalized pattern instead of
    // minting those phantoms.
    const normalizedPattern =
      tool === "run_shell"
        ? stripCommentLines(outcome.persist.pattern).trim()
        : outcome.persist.pattern;
    const shellSegments =
      tool === "run_shell"
        ? splitChainedCommand(normalizedPattern).filter((segment) => !isShellCommentOnly(segment))
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
        ),
      );
    }
  };

  // An auto-mode (or non-interactive-unavailable) decision settles the
  // instant it is made — there is no operator to wait on, so queued/displayed/
  // settled all collapse to now. Interactive prompts use approvalLog.ask
  // directly (see below) so their real queued/displayed/settled timestamps
  // are captured.
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

  const evaluate = async (call: ToolCall): Promise<GateVerdict> => {
    if (skipPermissions) return { allowed: true };
    // Sub-agent tool calls run under ALS identity (identity-context.ts). The
    // process cwd is the worktree (or session when no identity is set); every
    // relative-path judgment below must use it so auto-allow and restriction
    // match what the shell will open.
    const subAgentIdentity = getSubAgentIdentity();
    const effectiveCwd = subAgentIdentity?.cwd ?? resolvedCwd;

    const isRestrictedHere = bindRestrictedToProcessCwd(isRestricted, effectiveCwd);
    // A call targeting a restricted path (outside the workspace, or a write
    // under the session state root) drops from allow to ask, so it never auto-allows on

    // tier or shell-safety below.
    const restricted = callTargetsRestricted(call, isRestrictedHere);
    const shellCmd =
      call.name === "run_shell" && typeof call.arguments.command === "string"
        ? call.arguments.command
        : undefined;
    // Full-command secret check: whole-call auto-allow and headless messaging.
    // Per-segment secret checks below govern grants and segment auto-skip so a
    // safe pipeline tail (e.g. `| sort`) is not re-prompted when only an earlier
    // segment mentions a secret path.
    const shellReferencesSecret =
      shellCmd !== undefined && commandReferencesSensitivePath(shellCmd) !== undefined;
    if (!restricted && classifyTool(call.name, mcpTiers) === "allow") {
      return { allowed: true };
    }
    if (
      !restricted &&
      !shellReferencesSecret &&
      isAutoAllowedShellCall(call, effectiveCwd, rootsProvider)
    ) {
      return { allowed: true };
    }
    if (auto) {
      if (call.name === "run_shell") {
        // Auto-shell policy: `deny` (file mutations) blocks outright; `ask`
        // (dependency installs, sensitive-path refs) falls through to the
        // operator prompt. Everything else auto-allows. Path-keyed secret
        // reads stay hard-denied by secret-guard; shell that only *mentions*
        // a secret path is ask so an explicit one-time approval can pass it.
        const shellRule = autoShellRuleForCall(call, isRestrictedHere, effectiveCwd, rootsProvider);
        if (shellRule?.effect === "deny") {
          recordAutoDecision(call.name, shellRule.name, "auto-deny");
          return { allowed: false, reason: shellRule.reason };
        }
        if (shellRule === undefined) {
          recordAutoDecision(call.name, undefined, "auto-allow");
          return { allowed: true };
        }
      } else if (!restricted && AUTO_ALLOWED_TOOLS.has(call.name)) {
        recordAutoDecision(call.name, "auto-allowed-tool", "auto-allow");
        return { allowed: true };
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
        ...(subAgentIdentity !== undefined ? { agentLabel: subAgentIdentity.description } : {}),
      };
      // Shell: security still splits the chain, but the operator sees (and
      // accepts/rejects) the full command once. Any unapproved segment fails the
      // whole block. Execution always runs the full string the model asked for.
      if (request.tool === "run_shell") {
        const fullCommand = request.subject;
        const segments = splitChainedCommand(fullCommand).filter(
          (segment) => !isShellCommentOnly(segment),
        );
        if (segments.length === 0) continue;

        // A command authz would hard-deny at execution is stricter than "ask":
        // the gate must deny the call outright rather than show an Accept
        // button for a command that can never actually run. Judged against the
        // full command string with the same predicate authz enforces at
        // execution time — not per split segment — so a stage that only reads
        // bounded, already-piped data (e.g. `git show sha:path | rg -n foo`)
        // is not denied in isolation when the full pipeline is exempt. This
        // must run before the exact-full-command grant shortcut below — a
        // stored grant must never let a hard-denied command skip straight
        // past the check that would otherwise deny it (see preGrantGuardReason).
        const blockReason = runShellAuthzBlockReason(fullCommand);
        if (blockReason !== undefined) {
          return { allowed: false, reason: blockReason };
        }

        let needsOperator = false;
        let anySecret = false;
        for (const segment of segments) {
          // A secret-path reference or restricted target always requires the
          // operator, whether the segment would otherwise auto-allow or match
          // a stored grant — a grant approved for a safe command must never
          // replay for a guarded one just because the pattern also matches it.
          // segmentGuard is the same guard preGrantGuardReason applies before
          // isRequestCoveredByGrant lets a queued request skip the prompt.
          const guard = segmentGuard(segment, isRestrictedHere, effectiveCwd, rootsProvider);
          if (guard !== undefined) {
            if (guard.kind === "secret") anySecret = true;
            needsOperator = true;
            continue;
          }
          if (
            await evaluateApprovals({
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
          // Containment is judged against the process cwd, not the session cwd.
          if (isAutoAllowedShellSegment(segment, effectiveCwd, rootsProvider)) {
            continue;
          }
          needsOperator = true;
        }
        if (!needsOperator) continue;

        const askRule = anySecret ? "sensitive-path" : undefined;

        if (!interactive || requestApproval === undefined) {
          recordAutoDecision(request.tool, askRule ?? "non-interactive", "deny");
          return {
            allowed: false,
            reason: anySecret
              ? `${request.action} references a sensitive path and requires operator approval, which is unavailable in a non-interactive run.`
              : `${request.action} requires operator approval, which is unavailable in a non-interactive run. Re-run with --dangerously-skip-permissions to bypass, or narrow the action.`,
          };
        }

        // Secret-path shell must never mint a stored grant — even an exact match
        // would be misleading because future secret-path shell always re-asks.
        const requestForOperator = anySecret ? { ...request, scopes: [] } : request;
        const ask = approvalLog.ask({
          tool: request.tool,
          mode: "interactive",
          ...(askRule !== undefined ? { rule: askRule } : {}),
          segments: segments.length,
        });
        requestForOperator.markDisplayed = ask.markDisplayed;
        const turnId = currentTurnId();
        const waitSpanId = start("permission.wait", {
          ...(turnId !== null && turnId.length > 0 ? { parentId: turnId } : {}),
          tags: { tool_id: request.tool },
        });
        let outcome: ApprovalOutcome | undefined;
        try {
          outcome = await requestApproval(requestForOperator);
        } finally {
          finishApprovalWait(telemetry, waitSpanId, request.tool, outcome);
          ask.settle(classifyOutcome(outcome));
        }
        if (outcome === undefined || !outcome.allow) {
          const suffix =
            outcome?.message !== undefined && outcome.message.length > 0
              ? ` — ${outcome.message}`
              : "";
          return {
            allowed: false,
            reason: `Operator declined: ${request.action} (${request.subject})${suffix}`,
          };
        }
        if (!anySecret) {
          mintGrant(request.tool, outcome);
        }
        continue;
      }

      // Path-arg tools already drop to ask via callTargetsRestricted; grants
      // match on the path subject the same as before.
      const alreadyApproved = await evaluateApprovals({
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
        return {
          allowed: false,
          reason: `${request.action} requires operator approval, which is unavailable in a non-interactive run. Re-run with --dangerously-skip-permissions to bypass, or narrow the action.`,
        };
      }

      const ask = approvalLog.ask({
        tool: request.tool,
        mode: "interactive",
      });
      request.markDisplayed = ask.markDisplayed;
      const turnId = currentTurnId();
      const waitSpanId = start("permission.wait", {
        ...(turnId !== null && turnId.length > 0 ? { parentId: turnId } : {}),
        tags: { tool_id: request.tool },
      });
      let outcome: ApprovalOutcome | undefined;
      try {
        outcome = await requestApproval(request);
      } finally {
        finishApprovalWait(telemetry, waitSpanId, request.tool, outcome);
        ask.settle(classifyOutcome(outcome));
      }
      if (outcome === undefined || !outcome.allow) {
        const suffix =
          outcome?.message !== undefined && outcome.message.length > 0
            ? ` — ${outcome.message}`
            : "";
        return {
          allowed: false,
          reason: `Operator declined: ${request.action} (${request.subject})${suffix}`,
        };
      }
      mintGrant(request.tool, outcome);
    }
    return { allowed: true };
  };

  const reset = (): void => {
    for (const grant of sessionGrants) {
      const index = approvals.indexOf(grant);
      if (index !== -1) approvals.splice(index, 1);
    }
    sessionGrants.length = 0;
  };

  const sameApproval = (a: Approval, b: Approval): boolean =>
    a.tool === b.tool && a.pattern === b.pattern && a.providerModel === b.providerModel;

  const getSessionApprovals = (): readonly Approval[] => [...sessionGrants];

  const removeSessionApproval = (target: Approval): void => {
    for (let i = approvals.length - 1; i >= 0; i--) {
      if (sameApproval(approvals[i]!, target)) approvals.splice(i, 1);
    }
    for (let i = sessionGrants.length - 1; i >= 0; i--) {
      if (sameApproval(sessionGrants[i]!, target)) sessionGrants.splice(i, 1);
    }
  };

  const setSeededApprovals = (seeded: readonly Approval[]): void => {
    approvals.length = 0;
    approvals.push(...seeded, ...sessionGrants);
  };

  const registerMcpClient = (client: MCPClient): void => {
    registerMcpClientTools(mcpTiers, client.serverName, client.tools);
  };

  const unregisterMcpServer = (serverName: string): void => {
    mcpTiers.removeToolsForServer(serverName);
  };

  return {
    evaluate,
    getApprovals: () => approvals,
    reset,
    getSessionApprovals,
    removeSessionApproval,
    setSeededApprovals,
    getAuto: () => auto === true,
    setAuto: (value: boolean) => {
      auto = value;
    },
    getSkipPermissions: () => skipPermissions,
    setSkipPermissions: (value: boolean) => {
      skipPermissions = value;
    },
    setProviderIdentity: (nextProviderName: string, nextModel: string) => {
      activeProviderModel = `${nextProviderName}:${nextModel}`;
    },
    registerMcpClient,
    unregisterMcpServer,
  };
}
