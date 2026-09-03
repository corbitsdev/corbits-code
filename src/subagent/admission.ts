/**
 * Admission in front of worker `run()`. Spawn never refuses for count;
 * excess jobs report `queued` until a burst slot is free.
 *
 * `DEFAULT_ADMISSION_IN_FLIGHT` is a race-avoidance burst window so a 429 freeze
 * can fire before a herd — not provider truth and not a declared-spawn cap.
 *
 * Drain is FIFO among currently admissible jobs. A paused provider is skipped
 * so it cannot block another provider; it does not freeze bypass of capacity.
 */

export const DEFAULT_ADMISSION_IN_FLIGHT = 8;

export type AdmissionStatus = "running" | "queued";

export interface AdmissionJob {
  id: string;
  start: () => void;
  provider: string;
  bypass?: boolean;
}

export interface AdmissionQueue {
  enqueue(job: AdmissionJob): AdmissionStatus;
  release(id: string): void;
  setCapacity(n: number): void;
  notePressure(provider: string, untilMs: number): void;
  cancel(id: string): void;
  /** True while this id currently occupies a burst slot. */
  occupied(id: string): boolean;
}

export interface CreateAdmissionQueueOpts {
  capacity?: number;
  now?: () => number;
}

type QueuedJob = AdmissionJob & { bypass: boolean };

function isValidCapacity(n: number): boolean {
  return n === Number.POSITIVE_INFINITY || (Number.isInteger(n) && n >= 0);
}

export function createAdmissionQueue(opts: CreateAdmissionQueueOpts = {}): AdmissionQueue {
  const now = opts.now ?? (() => Date.now());
  let capacity =
    opts.capacity !== undefined && isValidCapacity(opts.capacity)
      ? opts.capacity
      : DEFAULT_ADMISSION_IN_FLIGHT;
  const inFlight = new Set<string>();
  const queued: QueuedJob[] = [];
  const pausedUntil = new Map<string, number>();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const providerPaused = (provider: string): boolean => {
    const until = pausedUntil.get(provider);
    if (until === undefined) return false;
    if (now() >= until) {
      pausedUntil.delete(provider);
      return false;
    }
    return true;
  };

  const canAdmit = (job: QueuedJob): boolean => {
    if (providerPaused(job.provider)) return false;
    if (job.bypass) return true;
    return inFlight.size < capacity;
  };

  const occupyAndStart = (job: QueuedJob): void => {
    inFlight.add(job.id);
    try {
      job.start();
    } catch (err) {
      inFlight.delete(job.id);
      throw err;
    }
  };

  const scheduleDrain = (): void => {
    let earliest: number | undefined;
    const t = now();
    for (const until of pausedUntil.values()) {
      if (until <= t) continue;
      if (earliest === undefined || until < earliest) earliest = until;
    }
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    if (earliest === undefined) return;
    drainTimer = setTimeout(
      () => {
        drainTimer = undefined;
        drain();
      },
      Math.max(0, earliest - t),
    );
    // Keep the process alive while jobs are waiting on a pause.
    if (queued.length === 0) drainTimer.unref?.();
  };

  const drain = (): void => {
    while (true) {
      const index = queued.findIndex((job) => canAdmit(job));
      if (index < 0) break;
      const next = queued.splice(index, 1)[0];
      if (next === undefined) break;
      occupyAndStart(next);
    }
    scheduleDrain();
  };

  return {
    enqueue(job: AdmissionJob): AdmissionStatus {
      const queuedJob: QueuedJob = {
        id: job.id,
        start: job.start,
        provider: job.provider,
        bypass: job.bypass === true,
      };
      if (inFlight.has(job.id) || queued.some((q) => q.id === job.id)) {
        return inFlight.has(job.id) ? "running" : "queued";
      }
      if (canAdmit(queuedJob)) {
        occupyAndStart(queuedJob);
        return "running";
      }
      queued.push(queuedJob);
      scheduleDrain();
      return "queued";
    },

    release(id: string): void {
      inFlight.delete(id);
      drain();
    },

    setCapacity(n: number): void {
      if (!isValidCapacity(n)) return;
      capacity = n;
      drain();
    },

    notePressure(provider: string, untilMs: number): void {
      if (untilMs <= now()) return;
      const prev = pausedUntil.get(provider) ?? 0;
      if (untilMs > prev) pausedUntil.set(provider, untilMs);
      drain();
    },

    cancel(id: string): void {
      const index = queued.findIndex((job) => job.id === id);
      if (index < 0) return;
      queued.splice(index, 1);
    },

    occupied(id: string): boolean {
      return inFlight.has(id);
    },
  };
}

export function unlimitedAdmissionQueue(): AdmissionQueue {
  return createAdmissionQueue({ capacity: Number.POSITIVE_INFINITY });
}

let processQueue: AdmissionQueue | undefined;

export function getProcessAdmissionQueue(): AdmissionQueue {
  processQueue ??= createAdmissionQueue();
  return processQueue;
}
