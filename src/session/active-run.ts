// A module-level slot the top-level uncaughtException/unhandledRejection
// handler (src/index.ts) can reach even though persistRunSnapshot is a
// closure local to runTUI. Only ever consulted from the crash path: a run
// that never crashes never has this read.
export type RunStateHandle = {
  sessionId: string;
  cwd: string;
  active: boolean;
};

let activeRun: RunStateHandle | null = null;

export function setActiveRun(handle: RunStateHandle): void {
  activeRun = handle;
}

export function clearActiveRun(): void {
  activeRun = null;
}

export function getActiveRun(): RunStateHandle | null {
  return activeRun;
}
