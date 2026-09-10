import { awaitCloseWithoutHidingLeftover } from "../../subagent/dispose.js";

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
export function createRuntimeShutdown(
  deps: RuntimeShutdownDeps,
): () => Promise<void> {
  let completion: Promise<void> | undefined;

  return (): Promise<void> => {
    if (completion !== undefined) return completion;

    completion = (async () => {
      const failures: unknown[] = [];
      try {
        deps.disposeHost();
      } catch (err) {
        failures.push(err);
      }
      try {
        await deps.disposeToolset();
      } catch (err) {
        failures.push(err);
      }
      try {
        await deps.cancelWorkers();
      } catch (err) {
        failures.push(err);
      }
      try {
        await awaitCloseWithoutHidingLeftover(deps.closeAgent(), failures[0]);
      } catch (err) {
        failures.push(err);
      }
      rethrowShutdownFailures(failures);
    })();
    return completion;
  };
}
