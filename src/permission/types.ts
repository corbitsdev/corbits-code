// Where a granted approval is remembered. `session` lasts only for the current
// run; the rest are persisted across restarts (`project` per repo, `global`
// for every project, `provider-model` scoped to the active provider+model).
export type GrantScope = "session" | "project" | "global" | "provider-model";

// A persistable approval: a tool name plus a glob pattern that auto-allows a
// future call whose subject (shell command or file path) matches it.
// `providerModel` scopes the grant to that provider+model; `cwd` (project
// grants only) confines it to the workspace root it was minted in.
export interface Approval {
  tool: string;
  pattern: string;
  providerModel?: string;
  cwd?: string;
}

// One scope option shown at approval time. `pattern` is the glob persisted if
// chosen; `null` allows once and remembers nothing. `grant` picks where the
// approval is remembered (default `session`). `hint` is shown to the operator
// in place of the raw `pattern` (e.g. an MCP tool's human label).
export interface ApprovalScope {
  id: string;
  label: string;
  pattern: string | null;
  hint?: string;
  grant?: GrantScope;
}

// A request surfaced to the operator for one consequential action: the full
// shell command, or the target path for a file tool.
export interface PermissionRequest {
  tool: string;
  action: string;
  subject: string;
  arguments?: Record<string, unknown>;
  scopes: ApprovalScope[];
  // Workspace root the request came from; confines project grant checks to
  // the repo the grant was minted in.
  cwd?: string;
  // Sub-agent's dispatch label when the request came from a sub-agent tool
  // call; undefined for top-level requests.
  agentLabel?: string;
  // Muted one-line reason scopes were withheld (beyond "no persistent option
  // yet"). Literal text, never model-authored.
  notice?: string;
  // Set by the gate before handing the request to requestApproval so surfaces
  // can report when it reached the operator's screen (a busy host queues it
  // first). Absent on display/matching-only requests (buildRequests).
  markDisplayed?: () => void;
}

// The operator's answer. `allow` gates the action; `persist` is the scope to
// remember for this directory; `message` is an operator-supplied explanation
// surfaced in the tool result.
export interface ApprovalOutcome {
  allow: boolean;
  persist?: ApprovalScope;
  message?: string;
}

export type RequestApproval = (
  request: PermissionRequest,
) => Promise<ApprovalOutcome>;
