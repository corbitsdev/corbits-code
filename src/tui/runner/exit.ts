/**
 * Exit and rebuild paths for the TUI runner: the exit-code contract, the
 * close/rebuild failure helpers, the run.json snapshot writers, the agent
 * lifecycle (reload-if-idle, interrupt, session rotation, the stable agent
 * proxy), the stream sink, and the quit-time finalization tail.
 */

import {
  AgentClosedError,
  AgentContextLockError,
  type Agent,
} from "@intx/agent";
import { getLogger } from "@intx/log";
import { consumeStream } from "../../session/stream-consumer.js";
import { COMPACTION_CONTINUATION_EVENT } from "../../agent/compaction.js";
import {
  buildCompactionContinuationMessage,
  createContinuationGate,
} from "../../session/runtime-assembly.js";
import { liveFleetCount } from "../../subagent/index.js";
import { getTelemetry } from "../../telemetry/singleton.js";
import { onTurnBoundary } from "../../agent/reactor-events.js";
import { setAgentSourceUnlessClosed } from "../agent-source-sync.js";
import { billingIdentityFromSource } from "../../cost/session-cost.js";
import { createRunSummary, type RunSummary } from "../../session/hooks.js";
import {
  finalizeRunState,
  saveState,
  type RunState,
} from "../../session/state.js";
import {
  generateSessionId,
  initSessionDir,
  sessionContextDir,
} from "../../session/index.js";
import {
  resolveSessionLabel,
  truncateSessionLabel,
} from "../../session/session-label.js";
import { printResumeHint } from "../../session/resume-hint.js";
import { clearActiveDisposeHost } from "../../session/active-host.js";
import { syncRunStateHandle } from "../../session/active-run.js";
import { startRunHeartbeat } from "../../session/run-liveness.js";
import {
  suppressProviderFailurePresentation,
  type ProviderFailureAttempt,
} from "../provider/failure-attempt.js";
import { normalizeInferenceErrorForTerminal } from "../../inference-gateway-error.js";
import { ensureFreshInferenceSource } from "../../subagent/refresh-inference-source.js";
import { peekSourceCredentialSecret } from "../../config/source-credentials.js";
import { sanitizeDiagnosticValue } from "../../diagnostic-sanitize.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { cancelFeedbackCapture } from "../../telemetry/feedback.js";
import {
  hostOf,
  liveAgent,
  recordRunError,
  runWhileAgentBusy,
  type RunnerServices,
  type RunnerState,
  type SnapshotExtra,
  type SnapshotKind,
  type SnapshotStatus,
} from "./state.js";
import { handleChatDirectorEvent } from "../../agent/chat-event-subscribers.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export function resetSessionForRotation(
  state: Pick<RunnerState, "withFleetPublicationSuspended">,
  services: Pick<
    RunnerServices,
    "deliveryGeneration" | "emitter" | "subAgentSessions"
  >,
): Promise<string[]> {
  let cancelledWorkers: Promise<string[]> = Promise.resolve([]);
  const reset = (): void => {
    services.deliveryGeneration.bump();
    cancelFeedbackCapture();
    services.emitter.emit("session.clear");
    cancelledWorkers = services.subAgentSessions.cancelAll("Session cleared");
  };
  if (state.withFleetPublicationSuspended === undefined) {
    reset();
  } else {
    state.withFleetPublicationSuspended(reset);
  }
  return cancelledWorkers;
}

export interface ResolveExitCodeArgs {
  runError: string | undefined;
  sinkError: string | undefined;
  status: RunSummary["status"];
  teardownFailed?: boolean;
}

export function resolveExitCode(args: ResolveExitCodeArgs): number {
  const { runError, sinkError, status, teardownFailed } = args;
  if (
    teardownFailed === true ||
    runError !== undefined ||
    sinkError !== undefined ||
    status !== "done"
  ) {
    return 1;
  }
  return 0;
}

/** One-line transcript block when resume history fails to load. */
export function resumeTranscriptLoadErrorBlock(err: unknown): {
  type: "error";
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: "error",
    message: `Could not load prior session transcript: ${message}`,
  };
}

// agent.close() releases its workdir lock last, after abort/drain and the
// shutdown-complete race. If any of that throws (likely under an interrupt
// mid-inference), the lock leaks — and the agent is already marked closed,
// so retrying close() cannot free it. Every rebuild site reusing the *same*
// workdir (interrupt, reloadIfIdle) must treat that as fatal: a second
// createAgent() for it then throws AgentContextLockError for a lock nothing
// will ever free. Rotation is exempt — it mints a fresh workdir before
// rebuilding, so the leaked lock is never re-acquired (see the comment at
// its close() call).
export async function closeAgentForRebuild(
  agent: Agent,
  context: string,
): Promise<boolean> {
  try {
    await agent.close();
    return true;
  } catch (err) {
    tuiLogger.debug(`agent.close during ${context} teardown failed: {error}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Directors seed allowIdleWithFleet=true because fleet lanes may appear
// mid-session. Rebuilds re-sync from the live count: the publisher only
// fires on a count change, so a session that never sees 0→1→0 keeps the seed.
export function resyncIdleWithFleetFlag(
  services: Pick<RunnerServices, "directorHolder" | "subAgentSessions">,
): void {
  services.directorHolder.instance?.setAllowIdleWithFleet(
    liveFleetCount(services.subAgentSessions.list()) > 0,
  );
}

// Funnel every rebuild failure (leaked lock or buildAgent failure) into a
// plain-language caught error instead of an unhandled rejection.
export function agentRebuildFailure(err: unknown): Error {
  return err instanceof AgentContextLockError
    ? new Error(
        "Could not start a new agent: the previous one did not shut down cleanly. Restart Corbits to continue.",
      )
    : err instanceof Error
      ? err
      : new Error(String(err));
}

/**
 * Hard-stop interrupt: bump delivery generation, then enqueue the rebuild.
 * The bump aborts the outstanding permission gate before enqueue so a later
 * accept cannot mint into the rebuilt identity.
 */
export function startInterruptRebuild(args: {
  deliveryGeneration: { bump: () => void };
  markSendAborted: () => void;
  enqueue: (op: () => Promise<void>) => unknown;
  rebuild: () => Promise<void>;
}): void {
  args.deliveryGeneration.bump();
  args.markSendAborted();
  void args.enqueue(args.rebuild);
}

export function clearsActiveRun(kind: SnapshotKind): boolean {
  return kind === "run-end";
}

/**
 * The run.json snapshot writers. Pure over (state, services), so the
 * lifecycle and the finalize tail can each build their own instance.
 */
function createRunPersistence(state: RunnerState, services: RunnerServices) {
  const writeRunSnapshot = async (
    status: SnapshotStatus,
    extra?: SnapshotExtra,
    kind: SnapshotKind = "progress",
  ): Promise<void> => {
    const task =
      state.runTaskTitle.trim().length > 0
        ? state.runTaskTitle.trim()
        : "(conversation)";
    const model = `${state.liveSource.id}:${state.liveSource.model}`;
    // Kept in step with every persisted snapshot so the crash handler's copy
    // (activeRunHandle, read by index.ts) never lags what's actually on disk.
    const turnsUsed = services.runSink.getTurnCount();
    const activatedTools = services.activatedToolNames.list();
    syncRunStateHandle(services.activeRunHandle, {
      turnsUsed,
      task,
      startedAt: state.startedAt,
      model,
      activatedTools,
    });
    const persisted: RunState = {
      status,
      turnsUsed,
      task,
      startedAt: state.startedAt,
      model,
      mcpServers: state.connectedMcpServers,
      ...(activatedTools.length > 0 ? { activatedTools } : {}),
      ...(services.activeRunHandle.lastCacheWriteAt !== undefined
        ? { lastCacheWriteAt: services.activeRunHandle.lastCacheWriteAt }
        : {}),
      ...extra,
    };
    if (clearsActiveRun(kind)) {
      await finalizeRunState(state.config.cwd, state.sessionId, persisted);
    } else {
      await saveState(state.config.cwd, state.sessionId, persisted);
    }
  };

  // Progress snapshots fire unsequenced (model switch, MCP connect, turn
  // completion), so a straggler could land after the terminal write and
  // resurrect "running" — atomicWrite is last-rename-wins. Once the run is
  // finalized, drop them; the run-ending path writes directly.
  //
  // Never a "run-end" write: everything here happens while the process is
  // alive and must stay crash-coverable, including the rotation "done" that
  // closes out a session on /clear or /new.
  const persistRunSnapshot = async (
    status: SnapshotStatus,
    extra?: SnapshotExtra,
    kind: Exclude<SnapshotKind, "run-end"> = "progress",
  ): Promise<void> => {
    if (services.crashGuard.isFinalized()) return;
    await writeRunSnapshot(status, extra, kind);
  };

  return { writeRunSnapshot, persistRunSnapshot };
}

/**
 * Fan one sink event out to whichever recovery attempts track the current
 * provider-failure attempt. The credential picker and the reconnect offer
 * share this submit/exit seat, so both observe the same retry/error stream
 * and settle independently when the send ends.
 */
export function observeRecoveryAttempts(
  state: Pick<
    RunnerState,
    | "credentialRecovery"
    | "credentialRecoveryAttempts"
    | "reconnectRecovery"
    | "reconnectRecoveryAttempts"
  >,
  providerAttempt: ProviderFailureAttempt | undefined,
  event: { readonly type: string; readonly data?: unknown },
): void {
  if (providerAttempt === undefined) return;
  const credentialAttempt =
    state.credentialRecoveryAttempts.get(providerAttempt);
  if (credentialAttempt !== undefined) {
    state.credentialRecovery.observe(credentialAttempt, event);
  }
  const reconnectAttempt = state.reconnectRecoveryAttempts.get(providerAttempt);
  if (reconnectAttempt !== undefined) {
    state.reconnectRecovery.observe(reconnectAttempt, event);
  }
}

/**
 * Build the mutable run lifecycle over the assembled session: snapshot
 * persistence, the stream sink, the initial agent build, and the
 * rebuild/rotation paths. Wires interrupt/newSession/agentProxy onto the
 * state slots the command, submit, and host layers read.
 */
export async function createRunLifecycle(
  state: RunnerState,
  services: RunnerServices,
): Promise<{
  interrupt: () => void;
  newSession: () => void;
  agentProxy: Agent;
}> {
  const { persistRunSnapshot } = createRunPersistence(state, services);
  state.persistRunSnapshot = persistRunSnapshot;
  const activateAndCommitWire = (names: string[]): void => {
    if (!services.activatedToolNames.activate(names)) return;
    if (services.flushPromotions()) {
      services.directorHolder.instance?.updateToolDefinitions(
        services.computeAdvertised(
          services.toolset.dynamicRunner.currentDefinitions(),
        ),
      );
    }
    void persistRunSnapshot("running");
  };
  const stopHeartbeat = startRunHeartbeat({
    shouldTick: () => !services.crashGuard.isFinalized(),
    tick: () => persistRunSnapshot("running"),
  });
  state.stopRunHeartbeat = stopHeartbeat;

  // Cycles persist to the context store only on inference.done; the assembled
  // recorder keeps the in-flight cycle's text so an errored or interrupted
  // turn leaves its partial output in partial.jsonl instead of vanishing.
  const providerFailureAttempts = services.providerFailureAttempts;
  services.crashGuard.setPartialFlush(() =>
    services.cycleRecorder.dispose("crashed").then(() => undefined),
  );
  // Consume-once gate for the compaction continuation emit: a replayed
  // duplicate of an already-answered emission must not re-deliver.
  const continuationGate = createContinuationGate();
  const streamSink = (
    event: Parameters<typeof services.runSink.sink>[0],
  ): void => {
    let eventForSink = event;
    if (event.type === "message.received") {
      providerFailureAttempts.advanceToNextMessage();
    }
    services.correlationAcceptance.observe(event);
    if (event.type === "reactor.gate.blocked") {
      // A gate that parks outside a send() has no caller to hand the
      // suspension to the operator; route it through the approval path here.
      services.suspendedApprovalRecovery.observeParked(
        event.data,
        services.deliveryGeneration.capture(),
      );
    }
    observeRecoveryAttempts(state, providerFailureAttempts.current(), event);
    if (event.type === "inference.start" || event.type === "inference.done") {
      providerFailureAttempts.reset();
    } else if (event.type === "inference.error") {
      const error = event.data.error;
      const executingAttempt = providerFailureAttempts.current();
      const providerId =
        "providerId" in error && typeof error.providerId === "string"
          ? error.providerId
          : (executingAttempt?.providerId ?? state.config.providerName);
      providerFailureAttempts.observe(
        normalizeInferenceErrorForTerminal(error, providerId),
      );
    } else if (event.type === "connector.reply") {
      const reply = providerFailureAttempts.consumeConnectorReply();
      if (reply?.suppressPresentation === true) {
        eventForSink = suppressProviderFailurePresentation(event);
      }
    } else if (event.type === "message.run.ended") {
      providerFailureAttempts.consumeTerminal();
    } else if (event.type === COMPACTION_CONTINUATION_EVENT) {
      // Compaction continuation as a ReactorAction: re-enter the loop with
      // the same message the old requestContinuation closure delivered,
      // through the serial op queue like every other deliver. Each emission
      // is answered once: a replayed duplicate of an already-answered
      // emission is ignored instead of re-delivered. A hop superseded by
      // interrupt rebuild (generation bump + rebuild already queued) is
      // re-queued onto the replacement agent so consume-once cannot land on
      // the outgoing liveAgent.
      // CL-10149 pause gate: while the operator holds the queue (first
      // Ctrl+C), the continuation is NOT re-queued onto the rebuilt agent —
      // that would be the visible auto-restart. It stays consume-once-intact
      // and only fires after resume (an explicit new send clears the flag;
      // the next boundary re-drives the emit). The observer is optional so
      // tests build partial sessions without the shell mount.
      if (
        state.isPaused?.() !== true &&
        continuationGate.shouldDeliver(event.seq)
      ) {
        state.enqueueCompactionContinuation?.(() =>
          liveAgent(state).deliver(buildCompactionContinuationMessage()),
        );
      }
    }
    // Chat-director reactor events (replacing the former onTasksChange /
    // onActivateTools closures): task-list changes repaint the chrome panel,
    // tool activation opens the call gate for the named tools.
    handleChatDirectorEvent(
      event,
      {
        onTasksChanged: (tasks) => services.emitter.emit("tasks", tasks),
        onToolsActivate: (names) => activateAndCommitWire(names),
        onFoldNonConverged: (notice) => state.systemNotice?.(notice),
      },
      (message, fields) => tuiLogger.debug(message, fields),
    );
    const configuredSecret = peekSourceCredentialSecret(
      state.liveSource.credentialId,
    );
    const sanitizedEventForSink = sanitizeDiagnosticValue(eventForSink, [
      configuredSecret,
    ]) as typeof eventForSink;
    const sanitizedEvent = sanitizeDiagnosticValue(event, [
      configuredSecret,
    ]) as typeof event;
    services.runSink.sink(sanitizedEventForSink);
    services.cycleRecorder.handleEvent(sanitizedEvent);
    if (onTurnBoundary(event)) {
      services.sessionCost.addTurn(
        event.data.usage,
        billingIdentityFromSource(event.data.source),
      );
    }
  };

  state.currentAgent = await services.buildAgent();
  resyncIdleWithFleetFlag(services);
  await persistRunSnapshot("running");
  void resolveSessionLabel(
    state.config.cwd,
    state.sessionId,
    state.runTaskTitle,
  ).then((label) => {
    services.emitter.emit("session.title", label);
  });
  state.streamPromise = consumeStream(liveAgent(state).stream(), streamSink);

  // Serial operation queue for rotation, compaction continuation, and proxy
  // deliver; tasks run one at a time. `send` awaits the tail, then drops if
  // /clear|/new bumped the delivery generation during the wait so the prompt
  // cannot land on the rebuilt agent.
  const enqueueOp = services.sessionOps.enqueue;

  const reloadIfIdle = (): void => {
    if (!state.pendingReload || state.inFlight > 0) return;
    state.pendingReload = false;
    void enqueueOp(async () => {
      try {
        const old = liveAgent(state);
        const closedCleanly = await closeAgentForRebuild(old, "reload");
        await state.streamPromise?.catch((err: unknown) => {
          tuiLogger.debug(
            "stream drain during reload teardown failed: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        });
        if (!closedCleanly) {
          throw new AgentContextLockError(state.workdir);
        }
        state.currentAgent = await services.buildAgent();
        resyncIdleWithFleetFlag(services);
        state.streamPromise = consumeStream(
          liveAgent(state).stream(),
          streamSink,
        );
        // The rebuild made a fresh director; re-attach the active workflow.
        services.workflowHost.reattach();
      } catch (err) {
        recordRunError(state, err);
        state.fatalBuildError = agentRebuildFailure(err);
        // A failed rebuild never reaches onBuilt/reset: un-poison the
        // lifecycle here so later compacts work instead of silently no-op
        // (same guard as interrupt and rotation).
        state.compactionLifecycle?.reset();
      }
    });
  };
  state.reloadIfIdle = reloadIfIdle;

  // Search loads top hits onto the next infer's tail; promote-on-execute
  // still declares a called name outside that prefix, at the cost of cache
  // prefix growth for strict providers.
  const promoteTools = (names: string[]): void => {
    activateAndCommitWire(names);
  };
  services.toolset.setToolPromoter(promoteTools);

  const refreshBeforeSend = async (): Promise<void> => {
    const source = await ensureFreshInferenceSource(
      state.liveSource,
      state.config.providers,
    );
    state.liveSource = source;
    setAgentSourceUnlessClosed(liveAgent(state), source);
  };

  // Stable handle handed to the App so the underlying agent can be swapped out
  // from under it without a remount; method calls always target the live agent.
  // Host mounts later; stampProvider.fn is wired once the bridge exists.
  const agentProxy: Agent = {
    send: async (content, opts) => {
      const stillCurrent = services.deliveryGeneration.capture();
      const dropIfRotated = (): void => {
        if (stillCurrent()) return;
        state.sendAborted = true;
        throw new AgentClosedError();
      };
      await services.sessionOps.awaitTail();
      dropIfRotated();
      if (state.fatalBuildError !== null) throw state.fatalBuildError;
      const trimmed = typeof content === "string" ? content.trim() : "";
      if (trimmed.length > 0 && state.runTaskTitle.trim().length === 0) {
        state.runTaskTitle =
          trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
        services.emitter.emit(
          "session.title",
          truncateSessionLabel(state.runTaskTitle),
        );
        void persistRunSnapshot("running");
      }
      return await runWhileAgentBusy(state, async () => {
        await refreshBeforeSend();
        dropIfRotated();
        return await liveAgent(state).send(content, opts);
      });
    },
    stream: () => liveAgent(state).stream(),
    deliver: (message) => {
      const targetAgent = liveAgent(state);
      state.enqueueAgentDeliver?.(() => targetAgent.deliver(message));
    },
    close: () => liveAgent(state).close(),
    setSource: (source) => {
      state.liveSource = source;
      state.liveSources = [source];
      state.liveDefaultSource = source.id;
      setAgentSourceUnlessClosed(liveAgent(state), source);
      state.stampProvider.fn?.(source.id);
      void persistRunSnapshot("running");
    },
    setSources: (sources, defaultSource) => {
      liveAgent(state).setSources(sources, defaultSource);
      state.liveSources = sources;
      state.liveDefaultSource = defaultSource;
      const head = sources.find((s) => s.id === defaultSource) ?? sources[0];
      if (head !== undefined) {
        state.liveSource = head;
        state.stampProvider.fn?.(head.id);
      }
      void persistRunSnapshot("running");
    },
    history: () => liveAgent(state).history(),
    checkpoints: (limit) => liveAgent(state).checkpoints(limit),
    readAt: (hash) => liveAgent(state).readAt(hash),
    get blobReader() {
      return liveAgent(state).blobReader;
    },
  };
  state.agentProxy = agentProxy;

  // Hard stop only (Ctrl+C / doInterrupt). Soft steer (Enter mid-run enqueue)
  // and follow-up (queued drain / deliver) must never call this — those paths
  // leave in-flight workers running. Closing the agent is the only thing that
  // aborts the reactor mid-inference (the send signal only rejects the send
  // promise); that close cascades: operationController.abort → child
  // parent-abort forwarding → child abort. Do not add cancelAll here — fleet cancelAll is
  // reserved for /clear (newSession), shutdown, and the explicit 2nd-press
  // stop-workers gesture (see wiring.cancelWorkersForStop). This interrupt must
  // stay cancelAll-free; the 2nd-press stop is a distinct caller that snapshots
  // live sessions and leaves tombstones, so a later quit-path stop finds
  // nothing live and is a no-op (no double cancel).
  // Close it, drain the old stream, and rebuild a fresh agent so the next send
  // works.
  const interrupt = (): void => {
    state.credentialRecovery?.clear();
    // An in-flight compact runs inline on the vendored reactor with no abort
    // hop of its own, so an interrupt that queues behind it parks on the
    // summary call. Abort the compact first — the wrapper no-ops and the
    // reactor reaches dequeue — then rebuild. The bumped generation retires
    // the compaction continuation onto the replacement agent; no hop drops.
    if (state.compactionLifecycle?.isCompacting() === true) {
      state.systemNotice?.("Compaction in progress — interrupting…");
    }
    // Abort unconditionally: a compact issued but not yet inside apply()
    // would otherwise start hung after this guard with no abort observed.
    state.compactionLifecycle?.abortCompaction("operator interrupt");
    startInterruptRebuild({
      deliveryGeneration: services.deliveryGeneration,
      markSendAborted: () => {
        state.sendAborted = true;
      },
      enqueue: enqueueOp,
      rebuild: async () => {
        try {
          // close() tears down stream consumers before the aborted cycle's
          // inference.error is delivered, so the recorder never sees a
          // terminal event. Dispose before that teardown salvages the buffer
          // so it is never lost or misattributed to the next cycle.
          await services.cycleRecorder.dispose("interrupted");
          const closedCleanly = await closeAgentForRebuild(
            liveAgent(state),
            "interrupt",
          );
          await state.streamPromise?.catch((err: unknown) => {
            tuiLogger.debug(
              "stream drain during interrupt teardown failed: {error}",
              {
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
          if (!closedCleanly) {
            throw new AgentContextLockError(state.workdir);
          }
          state.currentAgent = await services.buildAgent();
          resyncIdleWithFleetFlag(services);
          services.cycleRecorder.reset();
          state.streamPromise = consumeStream(
            liveAgent(state).stream(),
            streamSink,
          );
          services.workflowHost.reattach();
          state.fatalBuildError = null;
        } catch (err) {
          recordRunError(state, err);
          state.fatalBuildError = agentRebuildFailure(err);
          // A failed rebuild never reaches onBuilt/reset: un-poison the
          // lifecycle here so later compacts work instead of silently no-op.
          state.compactionLifecycle?.reset();
        }
      },
    });
  };
  state.interrupt = interrupt;

  // /clear and /new mint a new session id and state directory, repoint the
  // working tree, and rebuild the agent from an empty git-backed store; the
  // prior session stays on disk under its own id, resumable later. The App
  // cancels live workers (cancelAll + abort handles → child agent.close)
  // before clearing the session store so /clear leaves no orphaned child
  // reactors burning tokens.
  const newSession = (): void => {
    state.credentialRecovery?.clear();
    // Rotation must not park behind an in-flight compact either.
    state.compactionLifecycle?.abortCompaction("session rotation");
    const cancelledWorkers = resetSessionForRotation(state, services);
    // Backend rotation is always enqueued regardless of contention; the queue
    // serialises it behind any in-progress op. Sub-agents nest under the new
    // session automatically because getWorkdirBase reads the live sessionId.
    void enqueueOp(async () => {
      try {
        await cancelledWorkers;
        // Tear the old agent down and dispose the recorder before workdir is
        // repointed: the pump can deliver stray deltas until the stream
        // settles, and a dead cycle's partial must land in the session that
        // produced it, not the fresh one.
        await services.cycleRecorder.dispose("rotation");
        // Not routed through closeAgentForRebuild/agentRebuildFailure
        // (unlike interrupt and reloadIfIdle): rotation mints a fresh
        // sessionId/workdir below before buildAgent(), so a leaked lock on
        // the old workdir can never be re-acquired — buildAgent() always
        // targets the new, unlocked directory (see closeAgentForRebuild's
        // doc comment).
        await liveAgent(state)
          .close()
          .catch((err: unknown) => {
            tuiLogger.debug(
              "agent.close during session-rotation teardown failed: {error}",
              {
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
        await state.streamPromise?.catch((err: unknown) => {
          tuiLogger.debug(
            "stream drain during session-rotation teardown failed: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        });
        await persistRunSnapshot(
          "done",
          { finishedAt: Date.now() },
          "session-rotation",
        );
        state.sessionId = generateSessionId();
        state.startedAt = Date.now();
        state.runTaskTitle = state.config.task;
        const rotatedBundle = services.buildSessionSources();
        // Repointed, not cleared: the process lives on, so the crash handler
        // must keep finding this handle and close out the *new* session. The
        // copied fields reseed with the repoint — a crash below would
        // otherwise stamp the outgoing session's turnsUsed (and task,
        // startedAt, model) onto a session that has run zero turns.
        services.activeRunHandle.sessionId = state.sessionId;
        syncRunStateHandle(services.activeRunHandle, {
          turnsUsed: 0,
          task:
            state.runTaskTitle.trim().length > 0
              ? state.runTaskTitle.trim()
              : "(conversation)",
          startedAt: state.startedAt,
          model: `${rotatedBundle.selected.id}:${rotatedBundle.selected.model}`,
          activatedTools: [],
        });
        delete services.activeRunHandle.lastCacheWriteAt;
        delete services.activeRunHandle.cacheWriteModel;
        services.emitter.emit(
          "session.title",
          state.runTaskTitle.trim().length > 0
            ? truncateSessionLabel(state.runTaskTitle)
            : "Untitled session",
        );
        state.workdir = sessionContextDir(state.config.cwd, state.sessionId);
        await initSessionDir(state.config.cwd, state.sessionId);
        state.liveSources = rotatedBundle.sources;
        state.liveDefaultSource = rotatedBundle.defaultSource;
        state.liveSource = rotatedBundle.selected;
        services.permissionGate.reset();
        services.runSink.reset();
        services.sessionCost.reset();
        // The rotated session's transcript never recorded the activations, so
        // its wire starts at the prefix and its run.json does not inherit them.
        services.activatedToolNames.clear();
        state.currentAgent = await services.buildAgent();
        resyncIdleWithFleetFlag(services);
        services.cycleRecorder.reset();
        state.streamPromise = consumeStream(
          liveAgent(state).stream(),
          streamSink,
        );
        await persistRunSnapshot("running");
        // A fresh session drops any active workflow.
        services.workflowHost.reset();
        state.fatalBuildError = null;
        // Sink and director are empty now — repaint so the meter stays hidden
        // rather than showing the pre-clear occupancy until the next turn.
        services.hostHolder.instance?.refreshCostContext();
      } catch (err) {
        recordRunError(state, err);
        state.fatalBuildError =
          err instanceof Error ? err : new Error(String(err));
        // Same poison guard as the interrupt rebuild above.
        state.compactionLifecycle?.reset();
      }
    });
  };
  state.newSession = newSession;
  return { interrupt, newSession, agentProxy };
}

/**
 * The quit path: everything from waitUntilExit through the terminal run.json
 * write, post-run hooks, telemetry flush, and teardown awaits, returning the
 * process exit code.
 */
export async function finalizeTUIRun(
  state: RunnerState,
  services: RunnerServices,
): Promise<number> {
  await hostOf(state).waitUntilExit();
  state.stopRunHeartbeat?.();
  delete state.stopRunHeartbeat;
  // Stop workers before awaiting the session-op tail so a hung enqueue cannot
  // delay abort/reap; persistence, hooks, and telemetry stay after stop.
  // Toolset dispose lives inside shutdownRuntime so quit, crash, and signals
  // share one owner. Quit must not park behind a hung summary call: abort
  // the compact first so the in-flight apply race resolves before shutdown.
  state.compactionLifecycle?.abortCompaction("quit");
  let teardownFailed = false;
  try {
    await state.shutdownRuntime?.();
  } catch (err) {
    teardownFailed = true;
    tuiLogger.error("runtime shutdown failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await services.sessionOps.awaitTail();

  state.stopFleetReporting?.();
  // Quitting mid-stream is an abnormal end for the in-flight cycle: nothing
  // downstream delivers its terminal event once the app is gone.
  await services.cycleRecorder.dispose("exit");
  services.mcpConnectController.abort();

  const finishedAt = Date.now();
  const turnCollector = services.runSink.getTurnCollector();
  const sinkError = services.runSink.getRunError();
  const summaryStatus = services.runSink.getStatus();
  // RunSummary's status ("done" | "failed" | "cancelled") maps directly onto
  // RunState's terminal statuses — no fallback to "running" here, otherwise a
  // finished run (finishedAt set) can be left reading as still in progress.
  const persistedStatus: RunState["status"] = summaryStatus;
  services.crashGuard.markFinalized();
  // The run is over here, so the terminal write clears the active-run handle
  // (via finalizeRunState in state.ts) in the same call rather than pairing
  // the on-disk write with a separate in-memory statement. The dispose host
  // has no on-disk counterpart to piggyback on, so it clears its own handle,
  // mirroring finalizeOnCrash — otherwise a late signal finds a handle
  // pointing at a torn-down closure.
  clearActiveDisposeHost();
  const { writeRunSnapshot } = createRunPersistence(state, services);
  await writeRunSnapshot(
    persistedStatus,
    {
      finishedAt,
      ...(sinkError !== undefined ? { error: sinkError } : {}),
    },
    "run-end",
  );
  const runSummary = createRunSummary({
    task:
      state.runTaskTitle.length > 0 ? state.runTaskTitle : state.config.task,
    status: summaryStatus,
    startedAt: state.startedAt,
    finishedAt,
    turnsUsed: services.runSink.getTurnCount(),
    tokenUsage: services.runSink.getTokenUsage(),
    turns: turnCollector?.getTurns() ?? [],
    toolCallCount: services.runSink.getToolCallCount(),
    ...(sinkError !== undefined ? { error: sinkError } : {}),
  });
  await services.hookManager.dispatchPostRun(runSummary);
  // exit_reason mirrors status — "cancelled" covers both interrupt and
  // Ctrl+C, since runSink only distinguishes done/failed/cancelled.
  const exitReason =
    runSummary.status === "done"
      ? "done"
      : runSummary.status === "failed"
        ? "error"
        : "cancelled";
  getTelemetry().capture("session_end", {
    status: runSummary.status,
    turn_count: runSummary.turnsUsed,
    duration_ms: runSummary.durationMs,
    session_mode: services.liveSessionMode,
    exit_reason: exitReason,
  });
  // Flush before process.exit can drop the session_end capture for short
  // sessions; flush is deadline-capped so exit stays snappy. PerfTrace OTEL
  // export runs once at process exit in main (flushPerfToOtel).
  await getTelemetry().flush();

  try {
    await state.streamPromise;
  } catch (err: unknown) {
    tuiLogger.debug("stream promise rejected during exit: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Last word on the restored terminal: every normal quit (exit/quit command,
  // Ctrl+C, session end) funnels through here, so the exited session's id is
  // always the one printed.
  printResumeHint(state.sessionId);

  return resolveExitCode({
    runError: state.runError,
    sinkError,
    status: services.runSink.getStatus(),
    teardownFailed,
  });
}
