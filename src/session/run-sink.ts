import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { TokenUsage } from "@intx/types/runtime";
import { createPerfReactorObserver } from "../perf/reactor-spans.js";
import {
  createTurnContextCollector,
  type LifecycleHookManager,
  type RunSummary,
} from "./hooks.js";

type TurnCollector = ReturnType<typeof createTurnContextCollector>;

export type RunSinkArgs = {
  emitter: EventEmitter;
  hookManager: Pick<LifecycleHookManager, "dispatchPostTurn" | "getStatuses">;
  // Fired alongside dispatchPostTurn for each completed turn. Separate from
  // hookManager so telemetry can observe turn completion without run-sink
  // knowing anything about telemetry. The TurnContext carries the source the
  // turn actually ran against, so consumers report per-turn provider/model
  // even if the live selection changed mid-run.
  onTurnComplete?: (ctx: import("./hooks.js").TurnContext) => void;
  // Continues a resumed session's persisted run.json turn count instead of
  // restarting the collector at zero.
  initialTurnCount?: number;
};

export type RunSink = {
  sink: (event: ReactorEmittedEvent) => void;
  getStatus: () => RunSummary["status"];
  getRunError: () => string | undefined;
  getTurnCount: () => number;
  getTokenUsage: () => TokenUsage;
  getLastTurnUsage: () => TokenUsage;
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
  const { emitter, hookManager, onTurnComplete, initialTurnCount } = args;

  function hasConfiguredHooks(): boolean {
    return hookManager.getStatuses().length > 0;
  }

  // One collector tracks turn/token/tool-call counts for the lifetime of the
  // run, needed for run-state persistence regardless of hooks. It only
  // retains full turn history — including tool results — when a hook is
  // configured to consume it, so a hookless run never carries a second
  // standing copy of recent history.
  const handleTurn = (ctx: Parameters<NonNullable<typeof onTurnComplete>>[0]): void => {
    hookManager.dispatchPostTurn(ctx);
    onTurnComplete?.(ctx);
  };

  // The initial seed only applies to the run's first collector (a resumed
  // session's prior turnsUsed); a later reset() starts a fresh sub-session
  // and should count from zero, not re-seed.
  function createCollector(seedTurnCount?: number): TurnCollector {
    return createTurnContextCollector(handleTurn, Date.now, {
      retainHistory: hasConfiguredHooks(),
      ...(seedTurnCount !== undefined ? { initialTurnCount: seedTurnCount } : {}),
    });
  }

  let runCompleted = false;
  let runError: string | undefined;
  let turnCollector = createCollector(initialTurnCount);
  // Always-on local PerfTrace: not gated by lifecycle hooks.
  let perfObserver = createPerfReactorObserver();

  const sink = (event: ReactorEmittedEvent): void => {
    turnCollector.observe(event);
    perfObserver.observe(event);
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
    getTurnCount: () => turnCollector.getTurnCount(),
    getTokenUsage: () => turnCollector.getTokenUsage(),
    getLastTurnUsage: () => turnCollector.getLastTurnUsage(),
    getToolCallCount: () => turnCollector.getToolCallCount(),
    getTurnCollector: () => (hasConfiguredHooks() ? turnCollector : null),
    reset: () => {
      runCompleted = false;
      runError = undefined;
      turnCollector = createCollector();
      perfObserver.reset();
    },
  };
}
