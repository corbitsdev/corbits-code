// User message sent after a slash command starts a workflow. Must not read like a
// request to *start* a workflow — the runtime is already active and the current
// step is injected into the system prompt.
export function workflowKickoffUserMessage(args?: string): string {
  const trimmed = args?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Continue.";
}
