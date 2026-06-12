import { useEffect, useState, useRef } from "react";
import { getWorkingTreeDiff, type DiffResult } from "../git-diff.js";

export type UseDiffArgs = {
  cwd: string;
  active: boolean;
};

export type DiffState = {
  result: DiffResult | null;
  loading: boolean;
};

export type ShouldRefreshDiffArgs = {
  active: boolean;
  lastRefreshAt: number | null;
  nowMs: number;
  intervalMs: number;
};

// Pure helper: decides whether a diff refresh should fire given current timing
// state. Extracted so the decision can be unit-tested without a React harness.
export function shouldRefreshDiff({ active, lastRefreshAt, nowMs, intervalMs }: ShouldRefreshDiffArgs): boolean {
  if (!active) return false;
  if (lastRefreshAt === null) return true;
  return nowMs - lastRefreshAt >= intervalMs;
}

const DIFF_REFRESH_INTERVAL_MS = 3000;

export function useDiff({ cwd, active }: UseDiffArgs): DiffState {
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Tracks when the last completed refresh started so we can debounce on an
  // interval rather than re-running on every streamed content block.
  const lastRefreshAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;

    // Reset the refresh timestamp so the panel always fetches immediately when
    // it is re-opened after being closed, rather than waiting out the remaining
    // debounce window from its previous open period.
    lastRefreshAt.current = null;

    let cancelled = false;
    // Guards against overlapping fetches: on a large repo a single diff can take
    // longer than the interval, and without this the next tick would start a
    // second fetch that could resolve out of order and show a stale result.
    let inFlight = false;

    const tryRefresh = () => {
      if (inFlight) return;
      const now = Date.now();
      if (!shouldRefreshDiff({ active, lastRefreshAt: lastRefreshAt.current, nowMs: now, intervalMs: DIFF_REFRESH_INTERVAL_MS })) {
        return;
      }
      lastRefreshAt.current = now;
      inFlight = true;
      setLoading(true);
      getWorkingTreeDiff(cwd)
        .then((next) => {
          if (!cancelled) setResult(next);
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) setLoading(false);
        });
    };

    // Refresh immediately when the panel opens, then poll on an interval so
    // the view stays fresh without spawning a subprocess per streamed token.
    tryRefresh();
    const handle = setInterval(tryRefresh, DIFF_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [cwd, active]);

  return { result, loading };
}
