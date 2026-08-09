import type { TurnStatus } from "./session-chrome.js"
import { detectSequencePeriod, type SequencePeriodCheck } from "../util/period-detection.js"

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
  readonly activeToolCalls: readonly string[]
}

// The captured incident looped two sentences with no line break between them
// ("...ranked findings.Confirming callId emission...") — degeneration is a
// character-level loop, not a line-level one. Splitting on "\n" misses it
// entirely, so the tail is treated as a plain string and checked for the
// smallest period it exactly repeats: the shortest span p such that the last
// several hundred characters equal p repeated.
//
// A period below this is more likely a short structural tic (indentation, a
// repeated bullet or table-cell divider) than a looping phrase. Chosen well
// under the ~140-char period of the captured incident's two-sentence cycle,
// with headroom for shorter degenerate loops (a single repeated sentence).
const REPETITION_MIN_PERIOD = 24
// How many exact repeats of the period are required before it counts as a
// loop rather than a coincidence. Verified against real non-degenerate
// repetition: a 6-row markdown table separator (period ~51 chars, 6 exact
// repeats) and 3 identical code lines (period ~60 chars, 3 exact repeats)
// both land under this bar and are not flagged; the captured incident's
// sentence pair comfortably clears it well before the stream ends.
const REPETITION_MIN_REPEATS = 8
// Hard ceiling on the period search regardless of buffer size, purely to cap
// worst-case work per check — token-level degeneration loops on a phrase or
// two, never on multi-paragraph spans.
const REPETITION_MAX_PERIOD_CAP = 2_000
// A monochrome run ("x".repeat(500), a "----" rule, a wall of spaces) is
// trivially periodic at *every* period, which would otherwise make it the
// single easiest thing to false-trigger on — verified by execution against
// `thinking-reveal.test.ts`'s burst-of-"x" fixture, which tripped the guard
// before this floor existed. Requiring the repeating unit itself to contain
// this many distinct characters keeps single-character and low-variety runs
// out without weakening the sentence-level case: the captured incident's
// cycle spans two full sentences, comfortably above it.
const REPETITION_MIN_DISTINCT_CHARS = 8

export type RepetitionCheck = SequencePeriodCheck

/**
 * Whether the tail of `text` is an exact repeat of some short span at least
 * `REPETITION_MIN_REPEATS` times. Pure text-in, decision-out: the caller owns
 * accumulating the buffer across deltas and cycles within a turn.
 *
 * Delegates to the generic detectSequencePeriod over the character array —
 * periods longer than `text.length / REPETITION_MIN_REPEATS` are skipped
 * there, not as an arbitrary cutoff but because they cannot mathematically
 * reach the occurrence threshold within the given text.
 */
export function detectRepetition(text: string): RepetitionCheck {
  return detectSequencePeriod(text.split(""), {
    minPeriod: REPETITION_MIN_PERIOD,
    maxPeriod: REPETITION_MAX_PERIOD_CAP,
    minRepeats: REPETITION_MIN_REPEATS,
    minDistinct: () => REPETITION_MIN_DISTINCT_CHARS,
  })
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
  // A parallel fan-out flips `awaitingResponse` true the moment any one
  // sub-agent's tool call finishes, even while siblings are still running.
  // Outstanding calls mean the run is not silent, regardless of that flag.
  if (args.awaitingResponse && args.activeToolCalls.length === 0) return true
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
  /** Whether the repetition guard currently sees a looping tail. */
  readonly repeating: boolean
}

export type StallLevel = "quiet" | "notice" | "abort"

/**
 * How stuck the run is. Three levels, because the two consumers want different
 * cuts of the same clock: the status flash wants "silent, but not yet handled"
 * so it does not shout over the abort's own message, while the phase indicator
 * wants "silent at all" — it must keep reading as a problem right through the
 * abort threshold rather than flipping back to healthy at the worst possible
 * instant. Both read this one function so they can never disagree about which
 * runs are stalled, only about what to do at each level.
 *
 * Quiet while repeating: that run is producing output, just not useful output,
 * and "no response" would misdescribe it.
 */
export function stallLevel(args: ShouldNoticeStallArgs): StallLevel {
  if (args.repeating) return "quiet"
  if (shouldAbortForStall(args)) return "abort"
  return silentPastThreshold(args, args.stallNoticeMs) ? "notice" : "quiet"
}

/**
 * Returns true while the run has been silent long enough to say so but not yet
 * long enough to abort, so the notice and the abort never speak at once.
 */
export function shouldNoticeStall(args: ShouldNoticeStallArgs): boolean {
  return stallLevel(args) === "notice"
}

/** Whether the phase indicator should paint the run as stalled. */
export function isStalledForDisplay(args: ShouldNoticeStallArgs): boolean {
  return stallLevel(args) !== "quiet"
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
