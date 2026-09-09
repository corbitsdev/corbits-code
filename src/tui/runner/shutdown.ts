export interface RuntimeShutdownDeps {
  disposeHost: () => void;
  cancelWorkers: () => void | Promise<void>;
  closeAgent: () => Promise<void>;
  disposeToolset: () => Promise<void>;
}

function rethrowShutdownFailures(failures: unknown[]): void {
  const first = failures[0];
  if (first === undefined) return;
  if (failures.length === 1) throw first;
  throw new AggregateError(failures, "runtime shutdown failed");
}

/** Start every process-owned teardown path once, even when exit races a signal. */
export function createRuntimeShutdown(deps: RuntimeShutdownDeps): () => Promise<void> {
  let started = false;
  let completion = Promise.resolve();

  return (): Promise<void> => {
    if (started) return completion;
    started = true;

    const failures: unknown[] = [];
    let cancelWorkersResult: void | Promise<void> = undefined;

    try {
      deps.disposeHost();
    } catch (err) {
      failures.push(err);
    }
    try {
      cancelWorkersResult = deps.cancelWorkers();
    } catch (err) {
      failures.push(err);
    }

    completion = (async () => {
      try {
        if (cancelWorkersResult !== undefined) await cancelWorkersResult;
      } catch (err) {
        failures.push(err);
      }
      try {
        await deps.closeAgent();
      } catch (err) {
        failures.push(err);
      }
      try {
        await deps.disposeToolset();
      } catch (err) {
        failures.push(err);
      }
      rethrowShutdownFailures(failures);
    })();
    return completion;
  };
}
