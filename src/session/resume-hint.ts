import { COMMAND_NAME } from "../branding.js";

// Printed when an interactive session ends so the operator can get back to
// the exact session they just left. Kept in its own module (branding only)
// so the process-level signal handlers can use it without pulling the TUI
// or config graph — see the import-cost comment in process-handlers.ts.
export function formatResumeHint(sessionId: string): string {
  return `Run ${COMMAND_NAME} resume ${sessionId}`;
}

// Exactly-once per process. finalizeTUIRun and installSignalHandlers both
// funnel through printResumeHint, and a signal mid-finalize would otherwise
// print twice: the process-level `terminating` guard covers signal-vs-signal
// only, never signal-vs-finalize. The flag lives at the single choke point.
let printed = false;

export function resetResumeHintForTests(): void {
  printed = false;
}

export function printResumeHint(sessionId: string): void {
  if (printed) return;
  printed = true;
  // stderr, not stdout: an exec run killed by a signal must not pollute piped
  // stdout (JSON consumers). Matches the crash-report/fatal convention, which
  // also reports on stderr; on a restored terminal both streams are visible.
  process.stderr.write(`${formatResumeHint(sessionId)}\n`);
}
