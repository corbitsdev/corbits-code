import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { TokenUsage } from "@intx/types/runtime";
import {
  createTurnContextCollector,
  type LifecycleHookManager,
  type RunSummary,
} from "./hooks.js";

type TurnCollector = ReturnType<typeof createTurnContextCollector>;

export type RunSinkArgs = {
  emitter: EventEmitter;
  hookManager: Pick<LifecycleHookManager, "dispatchPostTurn" | "getStatuses">;
};

export type RunSink = {
  sink: (event: ReactorEmittedEvent) => void;
  getStatus: () => RunSummary["status"];
  getRunError: () => string | undefined;
  getTurnCount: () => number;
  getTokenUsage: () => TokenUsage;
  getToolCallCount: () => number;
  // The full turn history — including tool results — is retained only when a
  // lifecycle hook is configured to consume it; null otherwise so a hookless
  // run does not carry a second standing copy of recent history in memory.
  getTurnCollector: () => TurnCollector | null;
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
  const { emitter, hookManager } = args;

  function hasConfiguredHooks(): boolean {
    return hookManager.getStatuses().length > 0;
  }

  // One collector tracks turn/token/tool-call counts for the lifetime of the
  // run, needed for run-state persistence regardless of hooks. It only
  // retains full turn history — including tool results — when a hook is
  // configured to consume it, so a hookless run never carries a second
  // standing copy of recent history.
  function createCollector(): TurnCollector {
    return createTurnContextCollector(
      (ctx) => hookManager.dispatchPostTurn(ctx),
      Date.now,
      { retainHistory: hasConfiguredHooks() },
    );
  }

  let runCompleted = false;
  let runError: string | undefined;
  let turnCollector = createCollector();

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
    getTurnCount: () => turnCollector.getTurnCount(),
    getTokenUsage: () => turnCollector.getTokenUsage(),
    getToolCallCount: () => turnCollector.getToolCallCount(),
    getTurnCollector: () => (hasConfiguredHooks() ? turnCollector : null),
    reset: () => {
      runCompleted = false;
      runError = undefined;
      turnCollector = createCollector();
    },
  };
}
