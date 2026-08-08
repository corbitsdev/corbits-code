/**
 * Startup diagnostics on their way to the operator.
 *
 * These are produced before the first turn, which is exactly when the landing
 * hero owns the screen. Delivered as transcript rows they reach
 * `clearLandingMark` and take the whole composition with them — the mark, the
 * guidance beside it, and the centred prompt box — not merely the mountain.
 *
 * This is a named seam rather than a loop at each call site because the
 * constraint is "a startup diagnostic is never a transcript row", and that
 * belongs in one place. CL-5618 fixed the MCP and hook producers individually
 * and the plugin producer kept the defect; a second producer getting it wrong
 * is what a per-call-site rule buys you.
 */

import { surfaceStartupNotice, type AppShell } from "./shell.js"

/**
 * Hand a batch of load-time diagnostics to the shell. Each rides the notice
 * strip while the landing is up and becomes a durable transcript row once a
 * real session row ends it; after that they are ordinary system rows.
 */
export function flushStartupNotices(
  shell: AppShell,
  notices: readonly string[],
): void {
  for (const notice of notices) surfaceStartupNotice(shell, notice)
}
