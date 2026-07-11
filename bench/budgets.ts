// Release budgets per workload. `minEventCount` and `maxHeapDeltaBytes` are the
// hard gates for every workload; `maxRetainedBytes` is a hard gate only where a
// real retention cap is exercised (the transcript family — its retained bytes
// are the serialized capped transcript). The inference family reports retained
// bytes as delivered-output size only, so it carries no `maxRetainedBytes`.
// Elapsed time and RSS are reported but not gated: wall time is
// environment-dependent (the CLI flags it as a soft warning) and RSS is a
// process-global backstop, not a per-workload figure.

export type Budget = {
  readonly minEventCount: number;
  // Set only where retained bytes measure a real cap (transcript family).
  readonly maxRetainedBytes?: number;
  readonly maxHeapDeltaBytes: number;
  readonly softMaxElapsedMs: number;
};

const MB = 1024 * 1024;

export const BUDGETS: Record<string, Budget> = {
  "small-token-deltas": {
    minEventCount: 3000,
    // ~20 MB retained events observed; a leak that roughly doubles retention trips.
    maxHeapDeltaBytes: 32 * MB,
    softMaxElapsedMs: 4000,
  },
  "long-reasoning-output": {
    minEventCount: 2500,
    // ~48 MB retained events observed; sits below a doubled-retention regression.
    maxHeapDeltaBytes: 72 * MB,
    softMaxElapsedMs: 4000,
  },
  "large-tool-results": {
    minEventCount: 2,
    // 4 MB in, retained must stay near the 48k tool-result cap.
    maxRetainedBytes: 256 * 1024,
    maxHeapDeltaBytes: 1 * MB,
    softMaxElapsedMs: 1000,
  },
  "resumed-session": {
    minEventCount: 5000,
    // 5000 blocks in, retained must fall to the 600-block cap.
    maxRetainedBytes: 128 * 1024,
    maxHeapDeltaBytes: 1 * MB,
    softMaxElapsedMs: 1000,
  },
  "tool-heavy-transcript": {
    minEventCount: 800,
    maxRetainedBytes: 2 * MB,
    maxHeapDeltaBytes: 4 * MB,
    softMaxElapsedMs: 2000,
  },
};
