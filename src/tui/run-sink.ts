import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import {
  createTurnContextCollector,
  type LifecycleHookManager,
  type RunSummary,
} from "../hooks.js";

type TurnCollector = ReturnType<typeof createTurnContextCollector>;

export type RunSinkArgs = {
  emitter: EventEmitter;
  hookManager: Pick<LifecycleHookManager, "dispatchPostTurn">;
};

export type RunSink = {
  sink: (event: ReactorEmittedEvent) => void;
  getStatus: () => RunSummary["status"];
  getRunError: () => string | undefined;
  getTurnCollector: () => TurnCollector;
};

export function getTUIRunSummaryStatus(
  runCompleted: boolean,
  runError: string | undefined,
): RunSummary["status"] {
  if (runError !== undefined) return "failed";
  if (runCompleted) return "done";
  return "cancelled";
}

export function createRunSink(args: RunSinkArgs): RunSink {
  const { emitter, hookManager } = args;

  let runCompleted = false;
  let runError: string | undefined;

  const turnCollector = createTurnContextCollector((ctx) => {
    hookManager.dispatchPostTurn(ctx);
  });

  const sink = (event: ReactorEmittedEvent): void => {
    turnCollector.observe(event);
    if (event.type === "reactor.done") {
      runCompleted = true;
    }
    if (event.type === "reactor.error") {
      const data = event.data as { error: string };
      runError = data.error;
    }
    if (event.type === "inference.error") {
      const data = event.data as { error: { message: string } };
      runError = data.error.message;
    }
    emitter.emit("event", event);
  };

  return {
    sink,
    getStatus: () => getTUIRunSummaryStatus(runCompleted, runError),
    getRunError: () => runError,
    getTurnCollector: () => turnCollector,
  };
}
