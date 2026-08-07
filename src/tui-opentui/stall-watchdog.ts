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

// A repeated line has to be long enough that short, legitimately-recurring
// fragments ("Let me check.") do not trip the guard.
const REPETITION_MIN_LINE_LENGTH = 20
// How far back into the streamed text to look for repeats. Bounded so the
// check stays cheap however long the turn runs.
const REPETITION_LOOKBACK_LINES = 12
// Three verbatim repeats of the same substantial line is not a coincidence
// of phrasing — it is the model looping.
const REPETITION_MIN_OCCURRENCES = 3

export type RepetitionCheck = {
  readonly repeating: boolean
  readonly repeatedLine: string | null
  readonly occurrences: number
}

/**
 * Whether the tail of the streamed text is dominated by a line repeated
 * verbatim. Pure text-in, decision-out: the caller owns accumulating the
 * buffer across deltas and cycles within a turn.
 */
export function detectRepetition(text: string): RepetitionCheck {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= REPETITION_MIN_LINE_LENGTH)
  const tail = lines.slice(-REPETITION_LOOKBACK_LINES)
  const counts = new Map<string, number>()
  for (const line of tail) counts.set(line, (counts.get(line) ?? 0) + 1)
  for (const [line, occurrences] of counts) {
    if (occurrences >= REPETITION_MIN_OCCURRENCES) {
      return { repeating: true, repeatedLine: line, occurrences }
    }
  }
  return { repeating: false, repeatedLine: null, occurrences: 0 }
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

/**
 * Shown while nothing is arriving at all. Never fires while tokens are
 * flowing — a model looping on repeated content is still producing output,
 * so it is reported by `repetitionRecoveryMessage` instead, not this one.
 */
export const STALL_NOTICE_MESSAGE = "no response for a while — ctrl+c to interrupt"

export const STALL_RECOVERY_MESSAGE =
  "stopped after no response — send again to retry"

/**
 * Shown once a repeated line aborts the turn. Named as degeneration, not a
 * generic failure, so a retry reads as the reasonable next step rather than
 * papering over a suspected hang or network fault.
 */
export function repetitionRecoveryMessage(repeatedTokens: number): string {
  return `stopped after repeating itself — ~${repeatedTokens} tokens looped — send again to retry`
}

export type ApplyStallRecoveryDeps = {
  /** Abort the in-flight run through the session port. */
  readonly abort: () => void
  readonly notify: (message: string) => void
}

export function applyStallRecovery(
  deps: ApplyStallRecoveryDeps,
  message: string = STALL_RECOVERY_MESSAGE,
): void {
  deps.abort()
  deps.notify(message)
}
