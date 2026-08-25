// Where a granted approval is remembered. `session` lives only in memory for the
// current run; the rest are persisted to a store that survives restart.
//   - `session`: in-memory only (the historical default)
//   - `project`: per-repo file at <cwd>/.corbits/permissions.json
//   - `global`: every project, in <home>/.corbits/permissions.json
//   - `provider-model`: scoped to the active providerName+model, persisted
//     globally under a key of `${providerName}:${model}`
export type GrantScope = "session" | "project" | "global" | "provider-model";

// A single persistable approval: a tool name plus a glob pattern that, when it
// matches a future call's subject (a shell command or a file path), auto-allows
// it without asking again. `providerModel`, when set, restricts the approval to
// the matching active providerName+model. `cwd`, when set (project-scoped
// grants only), restricts the approval to requests originating from that
// workspace root — a project grant minted in one repo must never auto-allow a
// queued request from a different repo.
export interface Approval {
  tool: string;
  pattern: string;
  providerModel?: string;
  cwd?: string;
}

// One option offered to the operator at approval time. `pattern` is the glob
// that gets persisted if the operator picks this scope; `null` means "just this
// once" — allow now, remember nothing. `grant` selects where the approval is
// remembered; it defaults to `session` when absent so older callers keep their
// in-memory behavior.
// `hint`, when set, is shown to the operator in place of the raw `pattern`
// (e.g. an MCP tool's human label instead of its mcp__ identifier).
export interface ApprovalScope {
  id: string;
  label: string;
  pattern: string | null;
  hint?: string;
  grant?: GrantScope;
}

// A request surfaced to the operator for one consequential action. For shell
// this is the full command the model asked to run (security still splits the
// chain under the hood); for a file tool it is the target path.
export interface PermissionRequest {
  tool: string;
  action: string;
  subject: string;
  arguments?: Record<string, unknown>;
  scopes: ApprovalScope[];
  // The workspace root this request was raised from. Used to confine
  // project-scoped grant reconciliation to the repo the grant was minted in.
  cwd?: string;
  // The requesting sub-agent's label (its dispatch description), when this
  // request originated from a sub-agent's own tool call rather than the
  // top-level session. Undefined for top-level requests.
  agentLabel?: string;
  // A single muted-line explanation shown to the operator when scopes were
  // withheld for a reason beyond the ordinary "no persistent option exists
  // yet" case. Plain literal text, never model-authored.
  notice?: string;
  // Set by the gate right before handing this request to requestApproval, so
  // whichever surface actually renders it (see gate-wire.ts's overlay host)
  // can report the moment it reached the operator's screen — distinct from
  // the moment it was raised, when a busy overlay host queues it first (see
  // src/permission/approval-log.ts). Never present on requests built for
  // display/matching only (buildRequests), only on the copy passed to
  // requestApproval.
  markDisplayed?: () => void;
}

// The operator's answer. `allow` gates the action; `persist`, when present, is
// the scope to remember for this directory; `message`, when present, is an
// operator-supplied explanation surfaced in the tool result.
export interface ApprovalOutcome {
  allow: boolean;
  persist?: ApprovalScope;
  message?: string;
}

export type RequestApproval = (request: PermissionRequest) => Promise<ApprovalOutcome>;
