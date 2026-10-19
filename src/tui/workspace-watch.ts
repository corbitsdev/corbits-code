/**
 * Git branch lookup for the prompt box's bottom border.
 *
 * The label is filled once at start, then only when `refresh` runs. A fixed
 * interval used to fork `git rev-parse` every few seconds for the whole TUI
 * lifetime, including idle. Callers refresh on an event that can change the
 * branch (a finished turn); staleness between those events is acceptable.
 * A refresh that arrives while a lookup is outstanding is remembered and
 * runs once that lookup settles: one follow-up child, not a loop, and not
 * a dropped turn-end read. A lookup that lands after stop is dropped.
 * Nothing here blocks a paint. The border keeps the last branch it was
 * given across a rejected lookup and across a null result: `getGitBranch`
 * resolves null for timeout, a non-zero exit, and a non-repo, and that
 * must not be treated as detached HEAD clearing the suffix. A null before
 * any branch was shown still reports, so a non-repo stays unlabeled.
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
  let again = false;
  let shown: string | null = null;

  const refresh = (): void => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    again = false;
    fetchBranch(input.cwd).then(
      (branch) => {
        // Null after a real branch is a failed lookup (or detached HEAD, which
        // shares that null). Keep the suffix; do not clear it.
        if (!stopped && !(branch === null && shown !== null)) {
          shown = branch;
          input.onBranch(branch);
        }
        inFlight = false;
        if (!stopped && again) refresh();
      },
      () => {
        inFlight = false;
        if (!stopped && again) refresh();
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
