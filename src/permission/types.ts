// A single persistable approval: a tool name plus a glob pattern that, when it
// matches a future call's subject (a shell command or a file path), auto-allows
// it without asking again. Scoped to one working directory by the store.
export type Approval = { tool: string; pattern: string };

// One option offered to the operator at approval time. `pattern` is the glob
// that gets persisted if the operator picks this scope; `null` means "just this
// once" — allow now, remember nothing.
// `hint`, when set, is shown to the operator in place of the raw `pattern`
// (e.g. an MCP tool's human label instead of its mcp__ identifier).
export type ApprovalScope = { id: string; label: string; pattern: string | null; hint?: string };

// A request surfaced to the operator for one consequential action. For a shell
// command this is a single segment of a chained command; for a file tool it is
// the target path.
export type PermissionRequest = {
  tool: string;
  action: string;
  subject: string;
  arguments?: Record<string, unknown>;
  scopes: ApprovalScope[];
};

// The operator's answer. `allow` gates the action; `persist`, when present, is
// the scope to remember for this directory; `message`, when present, is an
// operator-supplied explanation surfaced in the tool result.
export type ApprovalOutcome = { allow: boolean; persist?: ApprovalScope; message?: string };

export type RequestApproval = (request: PermissionRequest) => Promise<ApprovalOutcome>;
