// Decision for the quota auto-retry loop: after a provider rate-limit error the
// TUI polls and resubmits the last prompt once the retry-after window expires.
// An interrupt clears the last-sent prompt, so a blank message here means there
// is nothing legitimate to replay — resubmitting it would silently re-drive a
// turn the operator already stopped, duplicating its tool executions.

export type QuotaRetryDecisionInput = {
  readonly quotaError: { readonly retryAt: number } | null
  readonly alreadyFired: boolean
  readonly nowMs: number
  readonly lastSentMessage: string
}

export function shouldAutoRetryQuota(input: QuotaRetryDecisionInput): boolean {
  if (input.quotaError === null) return false
  if (input.alreadyFired) return false
  if (input.nowMs < input.quotaError.retryAt) return false
  if (input.lastSentMessage.trim().length === 0) return false
  return true
}

/** Seconds still to wait, for the status line. Never negative. */
export function quotaWaitSeconds(retryAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((retryAt - nowMs) / 1000))
}
