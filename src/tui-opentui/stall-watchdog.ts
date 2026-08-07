import type { TurnStatus } from "./session-chrome.js"

// How long the run can be continuously awaiting a response with no new content
// before the watchdog fires and aborts the in-flight request.
export const STALL_TIMEOUT_MS = 900_000

// When the run starts *saying* it looks stuck. Well short of the abort: nobody
// waits out the backstop, they conclude the product hung and quit, so silence
// has to be named long before it is acted on. Notice, not a shorter timeout —
// a slow model or a long tool call is not a stall, and killing it at 90s would
// break working runs to fix a wording problem.
export const STALL_NOTICE_MS = 90_000

export type ShouldAbortForStallArgs = {
  readonly status: TurnStatus
  readonly awaitingResponse: boolean
  readonly lastActivityAt: number
  readonly nowMs: number
  readonly stallTimeoutMs: number
  readonly isProcessing: boolean
  readonly streamingType: "text" | "thinking" | "tool" | null
}

/**
 * Whether silence of `thresholdMs` counts as stuck at all. Shared by the notice
 * and the abort so they never disagree about which runs are stalled — only
 * about how long they have been.
 */
function silentPastThreshold(
  args: ShouldAbortForStallArgs,
  thresholdMs: number,
): boolean {
  if (args.status !== "running") return false
  if (args.nowMs - args.lastActivityAt < thresholdMs) return false
  if (args.awaitingResponse) return true
  // Mid-stream hang: model stream stalled after first token. Long in-flight
  // tool runs do not emit parent stream events; do not abort those.
  return (
    args.isProcessing &&
    args.streamingType !== null &&
    args.streamingType !== "tool"
  )
}

// Pure decision helper: returns true when the run is genuinely stuck and should
// be aborted. Extracted so the timeout logic is unit-testable without timers.
export function shouldAbortForStall(args: ShouldAbortForStallArgs): boolean {
  return silentPastThreshold(args, args.stallTimeoutMs)
}

export type ShouldNoticeStallArgs = ShouldAbortForStallArgs & {
  readonly stallNoticeMs: number
}

/**
 * Returns true while the run has been silent long enough to say so but not yet
 * long enough to abort. False once the abort takes over, so the two never
 * paint at the same time.
 */
export function shouldNoticeStall(args: ShouldNoticeStallArgs): boolean {
  if (shouldAbortForStall(args)) return false
  return silentPastThreshold(args, args.stallNoticeMs)
}

/** Shown while the run is silent; names the state and the way out. */
export const STALL_NOTICE_MESSAGE = "no response for a while — ctrl+c to interrupt"

export const STALL_RECOVERY_MESSAGE =
  "stopped after no response — send again to retry"

export type ApplyStallRecoveryDeps = {
  /** Abort the in-flight run through the session port. */
  readonly abort: () => void
  readonly notify: (message: string) => void
}

export function applyStallRecovery(deps: ApplyStallRecoveryDeps): void {
  deps.abort()
  deps.notify(STALL_RECOVERY_MESSAGE)
}
