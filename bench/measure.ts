// Deterministic measurement wrapper shared by every benchmark workload.
//
// A workload runs a fixed, model-free amount of work and reports how much it
// produced (`eventCount`), how large the state it retains is (`retainedBytes`),
// and hands back the retained artifact itself so `measure` can size its live
// heap cost. `measure` wraps the run with timing and memory capture so every
// workload reports the same metric shape.

export type Metrics = {
  readonly elapsedMs: number;
  // Coarse process RSS sampled once after the run. Process-global and shared by
  // all workloads in a run, so it is a report-only backstop, not a per-workload
  // peak. Reported, never gated.
  readonly rssBytes: number;
  // Growth in V8 heapUsed, measured after a forced GC while the workload's
  // retained artifact is still referenced, minus a pre-run baseline. A
  // per-workload retention regression shows up here.
  readonly heapDeltaBytes: number;
  readonly eventCount: number;
  readonly retainedBytes: number;
};

export type WorkloadResult = {
  readonly eventCount: number;
  readonly retainedBytes: number;
  // The artifact whose retained size we are measuring (collected events for the
  // inference family, the stream state for the transcript family). `measure`
  // keeps this reachable across the post-run forced GC and heap reading, so the
  // heap delta reflects live retained state rather than collectible garbage.
  readonly retained: unknown;
};

// Live JSC/V8 heap size in bytes. Bun's `process.memoryUsage().heapUsed` is a
// coarse plateau that does not track allocations, so under Bun we read JSC's
// real heap size from `bun:jsc`; under `node --expose-gc` the V8 `heapUsed`
// figure does track growth and is used directly.
const readHeapBytes: () => number = await (async (): Promise<
  () => number
> => {
  const hasBun = (globalThis as { Bun?: unknown }).Bun !== undefined;
  if (hasBun) {
    const { heapStats } = (await import("bun:jsc")) as {
      heapStats: () => { heapSize: number };
    };
    return () => heapStats().heapSize;
  }
  return () => process.memoryUsage().heapUsed;
})();

// Force a synchronous collection so heap-after-collection readings compare like
// for like. Bun exposes `Bun.gc(true)`; under `node --expose-gc` a global `gc`
// is available. When neither exists the reading is a live-heap sample and the
// runner notes that in its output.
export function forceGc(): boolean {
  const bun = (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun;
  if (bun?.gc !== undefined) {
    bun.gc(true);
    return true;
  }
  const nodeGc = (globalThis as { gc?: () => void }).gc;
  if (nodeGc !== undefined) {
    nodeGc();
    return true;
  }
  return false;
}

export async function measure(
  run: () => Promise<WorkloadResult>,
): Promise<Metrics> {
  forceGc();
  const baselineHeapBytes = readHeapBytes();

  const start = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - start;
  const rssBytes = process.memoryUsage().rss;

  // The retained artifact is still reachable through `result` here, so a forced
  // GC keeps it while collecting everything the workload dropped. The remaining
  // growth over the baseline is the workload's retained heap cost.
  forceGc();
  const heapDeltaBytes = Math.max(0, readHeapBytes() - baselineHeapBytes);

  // A read after the heap sample above pins the artifact live through the whole
  // measurement; without a use past that point the engine could reclaim it early.
  void result.retained;

  return {
    elapsedMs,
    rssBytes,
    heapDeltaBytes,
    eventCount: result.eventCount,
    retainedBytes: result.retainedBytes,
  };
}
