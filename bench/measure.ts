// Deterministic measurement wrapper shared by every benchmark workload.
//
// A workload runs a fixed, model-free amount of work and reports how much it
// produced (`eventCount`) and how large the state it retains afterward is
// (`retainedBytes`). `measure` wraps that run with timing and memory capture so
// every workload reports the same metric shape.

export type Metrics = {
  readonly elapsedMs: number;
  readonly peakRssBytes: number;
  readonly heapUsedAfterGcBytes: number;
  readonly eventCount: number;
  readonly retainedBytes: number;
};

export type WorkloadResult = {
  readonly eventCount: number;
  readonly retainedBytes: number;
};

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
  const rssStart = process.memoryUsage().rss;
  let peakRssBytes = rssStart;
  const sample = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  };

  const start = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - start;
  sample();

  forceGc();
  const heapUsedAfterGcBytes = process.memoryUsage().heapUsed;

  return {
    elapsedMs,
    peakRssBytes,
    heapUsedAfterGcBytes,
    eventCount: result.eventCount,
    retainedBytes: result.retainedBytes,
  };
}
