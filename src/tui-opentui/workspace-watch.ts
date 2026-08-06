/**
 * Git branch polling for the prompt box's bottom border.
 *
 * The branch is the one piece of the border that changes under the operator
 * without the shell being told, so it is polled rather than pushed. Lookups are
 * guarded: while one is still outstanding the tick is skipped, so a git process
 * hung on a network filesystem cannot accumulate children across ticks. Nothing
 * here blocks a paint — the border simply keeps the last branch it was given.
 */

import { getGitBranch } from "../agent/environment.js"

export type FetchBranch = (cwd: string) => Promise<string | null>

export type BranchWatchInput = {
  readonly cwd: string
  readonly onBranch: (branch: string | null) => void
  readonly intervalMs?: number
  readonly fetchBranch?: FetchBranch
  /** Timer injection for tests; defaults to the global interval. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void
}

const DEFAULT_INTERVAL_MS = 5_000

function defaultSchedule(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  return () => {
    clearInterval(timer)
  }
}

/** Start polling; returns an unsubscribe that also silences a late lookup. */
export function watchGitBranch(input: BranchWatchInput): () => void {
  const fetchBranch = input.fetchBranch ?? getGitBranch
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS
  const schedule = input.schedule ?? defaultSchedule
  let inFlight = false
  let stopped = false

  const refresh = (): void => {
    if (inFlight || stopped) return
    inFlight = true
    fetchBranch(input.cwd).then(
      (branch) => {
        inFlight = false
        if (!stopped) input.onBranch(branch)
      },
      () => {
        inFlight = false
      },
    )
  }

  refresh()
  const cancel = schedule(refresh, intervalMs)
  return () => {
    stopped = true
    cancel()
  }
}
