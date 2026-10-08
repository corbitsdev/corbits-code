import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { LastCycleSource, TokenUsage } from "@intx/types/runtime";
import { createPerfReactorObserver } from "../perf/reactor-spans.js";
import {
  isReactorErrorFatal,
  onTurnBoundary,
} from "../agent/reactor-events.js";
import {
  createTurnContextCollector,
  type LifecycleHookManager,
  type RunSummary,
} from "./hooks.js";

type TurnCollector = ReturnType<typeof createTurnContextCollector>;

export interface RunSinkArgs {
  emitter: EventEmitter;
  hookManager: Pick<LifecycleHookManager, "dispatchPostTurn" | "getStatuses">;
  // Fired per completed turn, alongside dispatchPostTurn. Kept off
  // hookManager so telemetry sees completion without run-sink knowing
  // telemetry. TurnContext carries the source the turn ran against, so
  // consumers report per-turn provider/model even if the live selection
  // changed mid-run.
  onTurnComplete?:
    | ((ctx: import("./hooks.js").TurnContext) => void)
    | undefined;
  // Fired once per turn that ends in error. onTurnComplete only sees turns
  // that produced a full TurnContext, so a consumer relying on it alone goes
  // silent exactly when a run goes wrong. Turn index is the collector's
  // current count: the in-flight turn is the one recorded next.
  onTurnFailed?:
    | ((info: { turnIndex: number; error: string }) => void)
    | undefined;
  // Fired per inference attempt. Model from inference.start; turn index is
  // the collector's current in-flight turn count.
  onTurnStarted?:
    | ((info: { turnIndex: number; model: string }) => void)
    | undefined;
  // inference.usage is the first attempt event carrying the resolved
  // provider/model pair; authoritative across retries.
  onTurnSourceObserved?:
    | ((info: { turnIndex: number; source: LastCycleSource }) => void)
    | undefined;
  // Continues a resumed session's persisted run.json turn count instead of
  // restarting the collector at zero.
  initialTurnCount?: number | undefined;

  // Fired at every turn boundary so a caller can persist a mid-run run.json
  // snapshot. `inference.done` is the boundary every reactor cycle
  // guarantees; `reactor.done` fires once, at shutdown, never between turns.
  // Keying the snapshot off `reactor.done` froze turnsUsed at its resume-time
  // value for the whole session. Cadence lives here with the turn count, not
  // in a second renderer subscription — that constraint already moved three
  // times. The event is the finished inference, so the snapshot can stamp an
  // Anthropic cache write before the director's own bookkeeping runs.
  onTurnBoundarySnapshot?: (
    event: Extract<ReactorEmittedEvent, { type: "inference.done" }>,
  ) => void;
}

export interface RunSink {
  sink: (event: ReactorEmittedEvent) => void;
  getStatus: () => RunSummary["status"];
  getRunError: () => string | undefined;
  getTurnCount: () => number;
  getTokenUsage: () => TokenUsage;
  getLastTurnUsage: () => TokenUsage;
  getToolCallCount: () => number;
  // Full turn history (with tool results) is retained only when a hook
  // consumes it; null otherwise so a hookless run carries no second standing
  // copy of recent history.
  getTurnCollector: () => TurnCollector | null;
  // Resets accumulated run state (completed flag, error, turn history) so the
  // post-run hook for a new session reports only the turns from that session.
  reset: () => void;
}

export function getTUIRunSummaryStatus(
  runCompleted: boolean,
  runError: string | undefined,
): RunSummary["status"] {
  if (runError !== undefined) return "failed";
  if (runCompleted) return "done";
  return "cancelled";
}

/**
 * Map exec lifecycle signals to a run status. Chat sessions never emit
 * `reactor.done` until close, so after a post-send close the sink alone
 * often says "cancelled". A completed `send()` is success unless the sink
 * still holds a real run error.
 */
export function resolveExecRunStatus(args: {
  sendCompleted: boolean;
  sinkStatus: RunSummary["status"];
  runError: string | undefined;
}): RunSummary["status"] {
  if (args.runError !== undefined || args.sinkStatus === "failed")
    return "failed";
  if (args.sendCompleted) return "done";
  if (args.sinkStatus === "done") return "done";
  return "cancelled";
}

export function createRunSink(args: RunSinkArgs): RunSink {
  const {
    emitter,
    hookManager,
    onTurnComplete,
    onTurnFailed,
    onTurnStarted,
    onTurnSourceObserved,
    initialTurnCount,
    onTurnBoundarySnapshot,
  } = args;

  function hasConfiguredHooks(): boolean {
    return hookManager.getStatuses().length > 0;
  }

  // One collector tracks turn/token/tool-call counts for the run's lifetime,
  // needed for run-state persistence regardless of hooks. It retains full
  // turn history only when a hook consumes it (see getTurnCollector).
  const handleTurn = (
    ctx: Parameters<NonNullable<typeof onTurnComplete>>[0],
  ): void => {
    hookManager.dispatchPostTurn(ctx);
    onTurnComplete?.(ctx);
  };

  // Seed applies only to the first collector (a resumed session's prior
  // turnsUsed); reset() starts a fresh sub-session counting from zero.
  function createCollector(seedTurnCount?: number): TurnCollector {
    return createTurnContextCollector(handleTurn, Date.now, {
      retainHistory: hasConfiguredHooks(),
      ...(seedTurnCount !== undefined
        ? { initialTurnCount: seedTurnCount }
        : {}),
    });
  }

  let runCompleted = false;
  let runError: string | undefined;
  let turnCollector = createCollector(initialTurnCount);
  // A provider failure is only an attempt failure until the message run
  // settles. Retries reuse the same turn index, so emitting at
  // inference.error would create a terminal generation for a recoverable retry.
  let turnInFlight = false;
  let pendingInferenceError: string | undefined;
  // Always-on local PerfTrace: not gated by lifecycle hooks.
  const perfObserver = createPerfReactorObserver();

  function settleTurnFailure(error: string): void {
    if (!turnInFlight) return;
    turnInFlight = false;
    pendingInferenceError = undefined;
    onTurnFailed?.({ turnIndex: turnCollector.getTurnCount(), error });
  }

  const sink = (event: ReactorEmittedEvent): void => {
    turnCollector.observe(event);
    perfObserver.observe(event);
    if (event.type === "inference.start") {
      turnInFlight = true;
      onTurnStarted?.({
        turnIndex: turnCollector.getTurnCount(),
        model: event.data.model,
      });
    }
    if (event.type === "inference.usage") {
      onTurnSourceObserved?.({
        turnIndex: turnCollector.getTurnCount(),
        source: event.data.source,
      });
    }

    if (event.type === "reactor.done") {
      runCompleted = true;
      // Terminal success clears any earlier transient inference error.
      runError = undefined;
    }
    // A completed inference turn supersedes a prior recoverable inference.error
    // (ChatDirector retries timeout/retryable/aborted); leaving it would mark
    // a recovered send as failed.
    if (onTurnBoundary(event)) {
      turnInFlight = false;
      pendingInferenceError = undefined;
      runError = undefined;
      onTurnBoundarySnapshot?.(event);
    }
    if (event.type === "reactor.error" && isReactorErrorFatal(event.data)) {
      const data = event.data as { error: string };
      runError = data.error;
    }
    if (event.type === "inference.error") {
      const data = event.data as { error: { message: string } };
      pendingInferenceError = data.error.message;
      runError = data.error.message;
    }
    if (event.type === "message.run.ended") {
      if (event.data.status === "failed" && turnInFlight) {
        settleTurnFailure(
          pendingInferenceError ??
            event.data.error?.message ??
            "Inference failed",
        );
      } else {
        pendingInferenceError = undefined;
      }
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
      turnInFlight = false;
      pendingInferenceError = undefined;
      turnCollector = createCollector();
      perfObserver.reset();
    },
  };
}
