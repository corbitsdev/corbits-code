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

/**
 * Map exec lifecycle signals to a run status.
 *
 * Chat sessions never emit `reactor.done` until close, so after an intentional
 * post-send close the sink alone often says "cancelled". A completed `send()`
 * is success unless the sink still holds a real run error.
 */
export function resolveExecRunStatus(args: {
  sendCompleted: boolean;
  sinkStatus: RunSummary["status"];
  runError: string | undefined;
}): RunSummary["status"] {
  if (args.runError !== undefined || args.sinkStatus === "failed") return "failed";
  if (args.sendCompleted) return "done";
  if (args.sinkStatus === "done") return "done";
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
      // Terminal success clears any earlier transient inference error.
      runError = undefined;
    }
    // A completed inference turn supersedes a prior recoverable inference.error
    // (ChatDirector retries timeout/retryable/aborted). Leaving the sticky error
    // would mark a recovered successful send as failed.
    if (event.type === "inference.done") {
      runError = undefined;
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
