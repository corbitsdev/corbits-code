import type { ToolCall } from "@intx/types/runtime";
import type { Approval, GrantScope, RequestApproval } from "./types.js";
import {
  classifyTool,
  buildRequests,
  isAutoAllowedShellCall,
  isAutoAllowedShellSegment,
  callTargetsRestricted,
  commandTargetsRestricted,
} from "./classify.js";
import { autoShellRuleForCall } from "./auto-shell-policy.js";
import { commandReferencesSensitivePath } from "../plugins/secret-guard-plugin.js";
import { isApproved } from "./matcher.js";
import { createPathRestriction } from "./path-restriction.js";
import { createWorktreeRootsProvider, type RootsProvider } from "./worktrees.js";
import {
  createMcpToolPermissionRegistry,
  registerMcpClientTools,
  type McpToolPermissionRegistry,
} from "../mcp/tool-permissions.js";
import type { MCPClient } from "../mcp/client.js";

export type GateVerdict = { allowed: true } | { allowed: false; reason: string };

// In auto mode these non-shell built-in tools auto-allow without an operator
// prompt: file mutations plus the benign built-ins that a hands-off run should
// not stop for. Reads auto-allow via their own path and run_shell via the shell
// policy. Read-only MCP (annotations or list_/get_ prefixes) auto-allows via
// classifyTool. Everything else — ask_operator, unknown built-ins, mutating MCP —
// falls through to prompt.
const AUTO_ALLOWED_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "manage_tasks",
  "present",
  "tool_search",
  "use_skill",
  "search_agents",
  "task",
]);

export type PermissionGateOptions = {
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
  auto?: boolean;
  // The active inference provider name and model. A `provider-model` grant only
  // auto-allows future calls when these still match the grant's providerModel.
  providerName?: string;
  model?: string;
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
};

export type PermissionGate = {
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
  // consequential actions (file writes/edits) without prompting.
  getAuto: () => boolean;
  // Turn auto mode on or off for the rest of the session. The /auto command
  // wires the TUI toggle here so a switch takes effect on the next tool call.
  setAuto: (value: boolean) => void;
  // Grant a session-only approval outside the normal ask flow, e.g. when the
  // operator already approved a literal command through ask_operator — so the
  // matching run_shell call that follows does not prompt a second time.
  preApprove: (tool: string, pattern: string) => void;
  registerMcpClient: (client: MCPClient) => void;
  unregisterMcpServer: (serverName: string) => void;
};

export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { requestApproval, persist, interactive, skipPermissions, providerName, model, cwd } = options;
  const mcpTiers = options.mcpTiers ?? createMcpToolPermissionRegistry();
  const resolvedCwd = cwd ?? process.cwd();
  const pathRestriction = createPathRestriction(
    resolvedCwd,
    options.rootsProvider ?? createWorktreeRootsProvider(resolvedCwd),
  );
  const isRestricted = pathRestriction.isRestricted;
  let auto = options.auto;
  // Own a private copy so evaluating a grant never mutates the caller's array.
  const approvals: Approval[] = [...options.approvals];
  const activeProviderModel =
    providerName !== undefined && model !== undefined ? `${providerName}:${model}` : undefined;
  // Session grants live only in this array; persisted grants are seeded in via
  // options.approvals and re-routed to a store by the persist callback.
  const sessionGrants: Approval[] = [];

  const evaluate = async (call: ToolCall): Promise<GateVerdict> => {
    if (skipPermissions) return { allowed: true };
    // A call targeting a restricted path (outside the workspace, or a write
    // under .agent-state) drops from allow to ask, so it never auto-allows on
    // tier or shell-safety below.
    const restricted = callTargetsRestricted(call, isRestricted);
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
    if (!restricted && !shellReferencesSecret && isAutoAllowedShellCall(call, cwd)) {
      return { allowed: true };
    }
    if (auto) {
      if (call.name === "run_shell") {
        // Auto-shell policy: `deny` (file mutations) blocks outright; `ask`
        // (dependency installs, sensitive-path refs) falls through to the
        // operator prompt. Everything else auto-allows. Path-keyed secret
        // reads stay hard-denied by secret-guard; shell that only *mentions*
        // a secret path is ask so an explicit one-time approval can pass it.
        const shellRule = autoShellRuleForCall(call, isRestricted);
        if (shellRule?.effect === "deny") return { allowed: false, reason: shellRule.reason };
        if (shellRule === undefined) return { allowed: true };
      } else if (!restricted && AUTO_ALLOWED_TOOLS.has(call.name)) {
        return { allowed: true };
      }
      // Any other tool in auto mode (MCP or unknown built-in) is not
      // blanket-allowed; fall through to the operator prompt below.
    }

    for (const request of buildRequests(call)) {
      const segmentReferencesSecret =
        request.tool === "run_shell" &&
        commandReferencesSensitivePath(request.subject) !== undefined;
      // Broad grants like `cat *` must not authorize secret-path segments after
      // the plugin hard-deny was removed. Always re-prompt (or headless-deny).
      if (
        !segmentReferencesSecret &&
        isApproved(request.tool, request.subject, approvals, activeProviderModel)
      ) {
        continue;
      }
      // A pipeline that mixes a consequential segment (e.g. `find`) with an
      // intrinsically safe one (e.g. `sort`) only needs approval for the unsafe
      // segment. Skip prompting for any non-secret segment that auto-allows.
      if (
        !segmentReferencesSecret &&
        request.tool === "run_shell" &&
        isAutoAllowedShellSegment(request.subject, cwd) &&
        !commandTargetsRestricted(request.subject, isRestricted)
      ) {
        continue;
      }

      if (!interactive || requestApproval === undefined) {
        return {
          allowed: false,
          reason: segmentReferencesSecret
            ? `${request.action} references a sensitive path and requires operator approval, which is unavailable in a non-interactive run.`
            : `${request.action} requires operator approval, which is unavailable in a non-interactive run. Re-run with --dangerously-skip-permissions to bypass, or narrow the action.`,
        };
      }

      // Secret-path shell must never mint a stored grant — even an exact match
      // would be misleading because future secret-path shell always re-asks.
      // Strip persist scopes so the UI only offers Accept once; also ignore any
      // persist payload if a caller still returns one.
      const requestForOperator = segmentReferencesSecret
        ? { ...request, scopes: [] }
        : request;

      const outcome = await requestApproval(requestForOperator);
      if (!outcome.allow) {
        const suffix = outcome.message !== undefined && outcome.message.length > 0
          ? ` — ${outcome.message}`
          : "";
        return { allowed: false, reason: `Operator declined: ${request.action} (${request.subject})${suffix}` };
      }
      if (
        !segmentReferencesSecret &&
        outcome.persist &&
        outcome.persist.pattern !== null
      ) {
        const grant: GrantScope = outcome.persist.grant ?? "session";
        const approval: Approval =
          grant === "provider-model" && activeProviderModel !== undefined
            ? { tool: request.tool, pattern: outcome.persist.pattern, providerModel: activeProviderModel }
            : { tool: request.tool, pattern: outcome.persist.pattern };
        approvals.push(approval);
        if (grant === "session") {
          sessionGrants.push(approval);
        } else {
          persist?.(approval, grant);
        }
      }
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

  const preApprove = (tool: string, pattern: string): void => {
    const approval: Approval = { tool, pattern };
    // Repeated ask_operator approvals for the same command must not pile up
    // duplicate session grants.
    if (approvals.some((a) => sameApproval(a, approval))) return;
    approvals.push(approval);
    sessionGrants.push(approval);
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
    preApprove,
    registerMcpClient,
    unregisterMcpServer,
  };
}
