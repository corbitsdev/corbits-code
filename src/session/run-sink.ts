import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import {
  createTurnContextCollector,
  type LifecycleHookManager,
  type RunSummary,
} from "./hooks.js";

type TurnCollector = ReturnType<typeof createTurnContextCollector>;

export type RunSinkArgs = {
  emitter: EventEmitter;
  hookManager: Pick<LifecycleHookManager, "dispatchPostTurn">;
  // Fired alongside dispatchPostTurn for each completed turn. Separate from
  // hookManager so telemetry can observe turn completion without run-sink
  // knowing anything about telemetry. The TurnContext carries the source the
  // turn actually ran against, so consumers report per-turn provider/model
  // even if the live selection changed mid-run.
  onTurnComplete?: (ctx: import("./hooks.js").TurnContext) => void;
};

export type RunSink = {
  sink: (event: ReactorEmittedEvent) => void;
  getStatus: () => RunSummary["status"];
  getRunError: () => string | undefined;
  getTurnCollector: () => TurnCollector;
  // Resets accumulated run state (completed flag, error, turn history) so the
  // post-run hook for a new session reports only the turns from that session.
  reset: () => void;
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
  const { emitter, hookManager, onTurnComplete } = args;

  let runCompleted = false;
  let runError: string | undefined;
  const handleTurn = (ctx: Parameters<NonNullable<typeof onTurnComplete>>[0]): void => {
    hookManager.dispatchPostTurn(ctx);
    onTurnComplete?.(ctx);
  };
  let turnCollector = createTurnContextCollector(handleTurn);

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
    reset: () => {
      runCompleted = false;
      runError = undefined;
      turnCollector = createTurnContextCollector(handleTurn);
    },
  };
}
