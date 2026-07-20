// Status-bar git branch polling. Branch lookup itself lives in
// src/agent/environment.ts (getGitBranch, which runs git with a 3s timeout);
// this module owns the interval refresh and the React state wiring, and never
// blocks render on the git process.
import { useEffect, useState } from "react";
import { getGitBranch } from "../agent/environment.js";

export type FetchBranch = (cwd: string) => Promise<string | null>;

// Returns a refresh function that skips a lookup while the previous one is
// still pending, so a hung git process (network filesystem, etc.) cannot
// accumulate child processes across interval ticks.
export function createGuardedRefresh(
  cwd: string,
  fetchBranch: FetchBranch,
  onBranch: (branch: string | null) => void,
): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    fetchBranch(cwd).then(
      (branch) => {
        inFlight = false;
        onBranch(branch);
      },
      () => {
        inFlight = false;
      },
    );
  };
}

const DEFAULT_REFRESH_MS = 5_000;

// Refreshes on a timer and whenever cwd changes; never awaits synchronously
// during render, so a slow or hanging git process can't stall the TUI.
export function useGitBranch(
  cwd: string,
  refreshMs = DEFAULT_REFRESH_MS,
  fetchBranch: FetchBranch = getGitBranch,
): string | null {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = createGuardedRefresh(cwd, fetchBranch, (next) => {
      if (!cancelled) setBranch(next);
    });

    refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, refreshMs, fetchBranch]);

  return branch;
}
