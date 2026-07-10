// Release budgets per workload. Retained-byte and heap ceilings are the hard
// gates (deterministic, sit far below the uncapped size so a broken cap or a
// retention leak trips them). `minEventCount` guards against a workload silently
// short-circuiting. Elapsed time is reported but not gated here — wall time is
// environment-dependent; the CLI flags it as a soft warning instead.

export type Budget = {
  readonly minEventCount: number;
  readonly maxRetainedBytes: number;
  readonly maxHeapAfterGcBytes: number;
  readonly softMaxElapsedMs: number;
};

const MB = 1024 * 1024;

export const BUDGETS: Record<string, Budget> = {
  "small-token-deltas": {
    minEventCount: 3000,
    maxRetainedBytes: 16 * 1024,
    maxHeapAfterGcBytes: 300 * MB,
    softMaxElapsedMs: 4000,
  },
  "long-reasoning-output": {
    minEventCount: 2500,
    maxRetainedBytes: 48 * 1024,
    maxHeapAfterGcBytes: 300 * MB,
    softMaxElapsedMs: 4000,
  },
  "large-tool-results": {
    minEventCount: 3,
    // 4 MB in, retained must stay near the 48k tool-result cap.
    maxRetainedBytes: 256 * 1024,
    maxHeapAfterGcBytes: 300 * MB,
    softMaxElapsedMs: 1000,
  },
  "resumed-session": {
    minEventCount: 5000,
    // 5000 blocks in, retained must fall to the 600-block cap.
    maxRetainedBytes: 128 * 1024,
    maxHeapAfterGcBytes: 300 * MB,
    softMaxElapsedMs: 1000,
  },
  "tool-heavy-transcript": {
    minEventCount: 1200,
    maxRetainedBytes: 2 * MB,
    maxHeapAfterGcBytes: 300 * MB,
    softMaxElapsedMs: 2000,
  },
};
