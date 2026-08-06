import type { TurnStatus } from "./session-chrome.js"

// How long the run can be continuously awaiting a response with no new content
// before the watchdog fires and aborts the in-flight request.
export const STALL_TIMEOUT_MS = 900_000

export type ShouldAbortForStallArgs = {
  readonly status: TurnStatus
  readonly awaitingResponse: boolean
  readonly lastActivityAt: number
  readonly nowMs: number
  readonly stallTimeoutMs: number
  readonly isProcessing: boolean
  readonly streamingType: "text" | "thinking" | "tool" | null
}

// Pure decision helper: returns true when the run is genuinely stuck and should
// be aborted. Extracted so the timeout logic is unit-testable without timers.
export function shouldAbortForStall({
  status,
  awaitingResponse,
  lastActivityAt,
  nowMs,
  stallTimeoutMs,
  isProcessing,
  streamingType,
}: ShouldAbortForStallArgs): boolean {
  if (status !== "running") return false
  const stalled = nowMs - lastActivityAt >= stallTimeoutMs
  if (!stalled) return false
  if (awaitingResponse) return true
  // Mid-stream hang: model stream stalled after first token. Long in-flight
  // tool runs do not emit parent stream events; do not abort those.
  if (isProcessing && streamingType !== null && streamingType !== "tool") {
    return true
  }
  return false
}

export const STALL_RECOVERY_MESSAGE = "Recovering after an internal stall…"

export type ApplyStallRecoveryDeps = {
  /** Abort the in-flight run through the session port. */
  readonly abort: () => void
  readonly notify: (message: string) => void
}

export function applyStallRecovery(deps: ApplyStallRecoveryDeps): void {
  deps.abort()
  deps.notify(STALL_RECOVERY_MESSAGE)
}
