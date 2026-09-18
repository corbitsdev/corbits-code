import { COMMAND_NAME } from "../branding.js";

// Printed when an interactive session ends so the operator can get back to
// the exact session they just left. Kept in its own module (branding only)
// so the process-level signal handlers can use it without pulling the TUI
// or config graph — see the import-cost comment in process-handlers.ts.
export function formatResumeHint(sessionId: string): string {
  return `Run ${COMMAND_NAME} resume ${sessionId}`;
}

export function printResumeHint(sessionId: string): void {
  process.stdout.write(`${formatResumeHint(sessionId)}\n`);
}
