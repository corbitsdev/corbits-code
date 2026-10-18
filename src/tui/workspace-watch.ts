/**
 * Git branch lookup for the prompt box's bottom border.
 *
 * The label is filled once at start, then only when `refresh` runs. A fixed
 * interval used to fork `git rev-parse` every few seconds for the whole TUI
 * lifetime, including idle. Callers refresh on an event that can change the
 * branch (a finished turn); staleness between those events is acceptable.
 * While a lookup is outstanding a refresh is skipped, so a git process hung
 * on a network filesystem cannot accumulate children. A lookup that lands
 * after stop is dropped. Nothing here blocks a paint — the border keeps the
 * last branch it was given, including across a failed lookup.
 */

import { getGitBranch } from "../agent/environment.js";

export type FetchBranch = (cwd: string) => Promise<string | null>;

export interface BranchWatchInput {
  readonly cwd: string;
  readonly onBranch: (branch: string | null) => void;
  readonly fetchBranch?: FetchBranch;
}

export interface BranchWatch {
  /** Drop a lookup that lands afterwards. */
  readonly stop: () => void;
  /** Look up the branch again. Idle time never calls this. */
  readonly refresh: () => void;
}

/** Start watching. Looks up once immediately so the label is not blank. */
export function watchGitBranch(input: BranchWatchInput): BranchWatch {
  const fetchBranch = input.fetchBranch ?? getGitBranch;
  let inFlight = false;
  let stopped = false;

  const refresh = (): void => {
    if (inFlight || stopped) return;
    inFlight = true;
    fetchBranch(input.cwd).then(
      (branch) => {
        inFlight = false;
        if (!stopped) input.onBranch(branch);
      },
      () => {
        inFlight = false;
      },
    );
  };

  refresh();
  return {
    stop: () => {
      stopped = true;
    },
    refresh,
  };
}
