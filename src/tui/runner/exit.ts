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
import type { InferenceSource } from "@intx/types/runtime";
import { consumeStream } from "../../session/stream-consumer.js";
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
import { clearActiveDisposeHost } from "../../session/active-host.js";
import { syncRunStateHandle } from "../../session/active-run.js";
import { startRunHeartbeat } from "../../session/run-liveness.js";
import { getValidCodexToken } from "../../auth/codex/session.js";
import { getValidXaiToken } from "../../auth/xai/session.js";
import { suppressProviderFailurePresentation } from "../provider/failure-attempt.js";
import { normalizeInferenceErrorForTerminal } from "../../inference-gateway-error.js";
import { codexProfileFromProviderName } from "../../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../../config/xai-providers.js";
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

// The agent package releases its workdir lock at the very end of close(),
// after reactor.abort()/sendQueue.drain() and the shutdown-complete race have
// all run. If any of that throws (most likely right when an operator
// interrupts mid-inference, which is exactly when those paths are under
// stress), the lock is never released — and because the agent is already
// marked closed internally, retrying close() is a silent no-op that can
// never release it either. Every rebuild site that reuses the *same* workdir
// (interrupt, reloadIfIdle) must treat that as fatal for the current rebuild
// instead of calling buildAgent() again: a second createAgent() for the same
// workdir is then guaranteed to throw AgentContextLockError for a lock
// nothing will ever free, which is the "agent already open" crash. Session
// rotation (newSession) is the one rebuild site that does NOT route through
// this helper: it always points buildAgent() at a freshly minted workdir
// before rebuilding, so a leaked lock on the old workdir can never be
// re-acquired there — see the comment at its close() call for why.
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

// Every rebuild site funnels its failure (a lock left held by a failed
// close, or any other buildAgent failure) through here so it surfaces as a
// plain-language, caught error rather than an unhandled rejection.
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
 * Hard-stop interrupt: bump delivery generation, then enqueue the agent rebuild.
 * The bump aborts the outstanding permission gate (overlay dismissed, no grant)
 * before enqueue so a later accept cannot mint into the rebuilt identity.
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
      ...extra,
    };
    if (clearsActiveRun(kind)) {
      await finalizeRunState(state.config.cwd, state.sessionId, persisted);
    } else {
      await saveState(state.config.cwd, state.sessionId, persisted);
    }
  };

  // Progress snapshots are fired unsequenced (model switch, MCP connect, turn
  // completion), so a straggler could otherwise land after the terminal write
  // and resurrect status "running" — atomicWrite is last-rename-wins. Once the
  // run is finalized, drop them; the run-ending path writes through
  // writeRunSnapshot directly.
  //
  // Never a "run-end" write: everything routed here happens while the process
  // is still alive and must stay crash-coverable, including the rotation
  // "done" that closes out a session on /clear or /new.
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
  const streamSink = (
    event: Parameters<typeof services.runSink.sink>[0],
  ): void => {
    let eventForSink = event;
    if (event.type === "message.received") {
      providerFailureAttempts.advanceToNextMessage();
    }
    services.correlationAcceptance.observe(event);
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
    }
    services.runSink.sink(eventForSink);
    services.cycleRecorder.handleEvent(event);
    if (onTurnBoundary(event)) {
      services.sessionCost.addTurn(
        event.data.usage,
        billingIdentityFromSource(event.data.source),
      );
    }
  };

  state.currentAgent = await services.buildAgent();
  await persistRunSnapshot("running");
  void resolveSessionLabel(
    state.config.cwd,
    state.sessionId,
    state.runTaskTitle,
  ).then((label) => {
    services.emitter.emit("session.title", label);
  });
  state.streamPromise = consumeStream(liveAgent(state).stream(), streamSink);

  // Serial operation queue. Rotation (reload, interrupt, newSession), compaction
  // continuation, and proxy deliver enqueue async tasks; they run one at a time.
  // `send` awaits the tail, then drops if /clear|/new bumped delivery generation
  // during the wait or token refresh so the prompt cannot land on the rebuilt agent.
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
        state.streamPromise = consumeStream(
          liveAgent(state).stream(),
          streamSink,
        );
        // The rebuild made a fresh director; re-attach the active workflow.
        services.workflowHost.reattach();
      } catch (err) {
        recordRunError(state, err);
        state.fatalBuildError = agentRebuildFailure(err);
      }
    });
  };
  state.reloadIfIdle = reloadIfIdle;

  // tool_search (and contextual triggers, e.g. the lsp hint) promote tools into
  // the advertised set. Advertising takes effect on the next infer; a reload is
  // scheduled so a newly connected MCP tool also becomes dispatchable after a
  // rebuild (built-in tools are already dispatchable, so promoting them alone
  // needs no reload, but the reload is a cheap no-op in that case).
  const promoteTools = (names: string[]): void => {
    if (!services.activatedToolNames.activate(names)) return;
    services.directorHolder.instance?.updateToolDefinitions(
      services.computeAdvertised(
        services.toolset.dynamicRunner.currentDefinitions(),
      ),
    );
    // Activation is model-visible contract — persist it now so a crash or
    // restart before the next turn boundary does not strand the transcript's
    // "these tools are available" record.
    void persistRunSnapshot("running");
    state.pendingReload = true;
    reloadIfIdle();
  };
  services.toolset.setToolPromoter(promoteTools);

  // The active Codex source, tracked whenever a "codex/<profile>" source is
  // selected so its access token can be refreshed before each send. Seeded from
  // config when the session starts on a Codex profile (buildAgent sets that
  // source directly, not through the proxy's setSource).
  state.activeCodexSource =
    state.initialCodexProfile !== undefined
      ? { profile: state.initialCodexProfile, source: state.liveSource }
      : undefined;
  state.activeXaiSource =
    state.initialXaiProfile !== undefined
      ? { profile: state.initialXaiProfile, source: state.liveSource }
      : undefined;

  // Refresh the active Codex access token (if any) and push it onto the live
  // agent before a send. getValidCodexToken returns the stored token when still
  // valid and refreshes transparently otherwise, so this satisfies "check
  // before each inference call" without crashing the loop: a failure surfaces
  // as a CodexAuthError naming the profile and rejects the send.
  //
  // The source is pushed on every send, not only when the token changed: an
  // agent rebuild (tool promotion, interrupt, /clear) reseeds the source from
  // the original login-time token, so unconditionally re-pushing the live token
  // is what keeps the rebuilt agent from sending a stale credential.
  const refreshCodexBeforeSend = async (): Promise<void> => {
    const active = state.activeCodexSource;
    if (active === undefined) return;
    const { access } = await getValidCodexToken(active.profile);
    const source: InferenceSource =
      access === active.source.apiKey
        ? active.source
        : { ...active.source, apiKey: access };
    state.activeCodexSource = { profile: active.profile, source };
    state.liveSource = source;
    setAgentSourceUnlessClosed(liveAgent(state), source);
  };

  const refreshXaiBeforeSend = async (): Promise<void> => {
    const active = state.activeXaiSource;
    if (active === undefined) return;
    const { access } = await getValidXaiToken(active.profile);
    const source: InferenceSource =
      access === active.source.apiKey
        ? active.source
        : { ...active.source, apiKey: access };
    state.activeXaiSource = { profile: active.profile, source };
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
        await refreshCodexBeforeSend();
        await refreshXaiBeforeSend();
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
      const codexProfile = codexProfileFromProviderName(source.id);
      const xaiProfile = xaiProfileFromProviderName(source.id);
      state.activeCodexSource =
        codexProfile !== undefined
          ? { profile: codexProfile, source }
          : undefined;
      state.activeXaiSource =
        xaiProfile !== undefined ? { profile: xaiProfile, source } : undefined;
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
        const codexProfile = codexProfileFromProviderName(head.id);
        const xaiProfile = xaiProfileFromProviderName(head.id);
        state.activeCodexSource =
          codexProfile !== undefined
            ? { profile: codexProfile, source: head }
            : undefined;
        state.activeXaiSource =
          xaiProfile !== undefined
            ? { profile: xaiProfile, source: head }
            : undefined;
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
  // reserved for /clear (newSession) and shutdown.
  // Close it, drain the old stream, and rebuild a fresh agent so the next send
  // works.
  const interrupt = (): void => {
    startInterruptRebuild({
      deliveryGeneration: services.deliveryGeneration,
      markSendAborted: () => {
        state.sendAborted = true;
      },
      enqueue: enqueueOp,
      rebuild: async () => {
        try {
          // close() tears down stream consumers before the aborted cycle's
          // inference.error is delivered, so the recorder never sees a terminal
          // event for the dead cycle — dispose closes it against stray deltas
          // and salvages the buffer before that teardown, so it is never lost
          // or misattributed to the rebuilt agent's next cycle.
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
        }
      },
    });
  };
  state.interrupt = interrupt;

  // /clear and /new start a fresh conversation: mint a new session id and its
  // own state directory, repoint the working tree at it, and rebuild the agent
  // so it resumes from an empty git-backed store. The prior session stays on
  // disk under its own id, resumable later.
  //
  // Sub-agent lifecycle on rotation: App cancels live workers (cancelAll +
  // abort handles → child agent.close) before clearing the session store so
  // /clear does not leave orphaned child reactors burning tokens.
  const newSession = (): void => {
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
        // Deliberately not routed through closeAgentForRebuild/
        // agentRebuildFailure (unlike interrupt and reloadIfIdle, CL-5753):
        // rotation mints a fresh sessionId/workdir below before calling
        // buildAgent(), so even a close() that leaks the old workdir's lock
        // (see closeAgentForRebuild's doc comment) can never cause a second
        // acquisition on that same workdir — buildAgent() always targets
        // the new, unlocked directory. The old lock still leaks for the
        // rest of the process, but nothing ever tries to re-acquire it, so
        // there is no crash to guard against here.
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
        // fields it copies reseed with the repoint — a crash inside
        // initSessionDir/buildAgent below would otherwise stamp the outgoing
        // session's turnsUsed (and task, startedAt, model) onto a session
        // that has run zero turns.
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
  // delay abort/reap. Persistence, hooks, and telemetry stay after stop.
  // Toolset dispose lives inside shutdownRuntime so quit, crash, and signals
  // share one owner.
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
  // The run itself is over here, so this write clears the active-run handle
  // (via finalizeRunState in state.ts) in the same call, rather than pairing
  // the on-disk write with a separate in-memory statement at this call site.
  // The dispose host has no on-disk counterpart to piggyback on, so it still
  // needs its own clear here, mirroring finalizeOnCrash — otherwise a signal
  // arriving after this normal exit would find a handle pointing at a
  // torn-down closure.
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
  // exit_reason mirrors status at present — "cancelled" covers both an
  // operator interrupt and Ctrl+C, since the emit site here cannot tell them
  // apart (runSink only distinguishes done/failed/cancelled).
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
  // Bound against process.exit dropping the session_end capture for short
  // sessions; flush itself is deadline-capped so exit stays snappy.
  // PerfTrace OTEL export runs once at process exit in main (flushPerfToOtel).
  await getTelemetry().flush();

  try {
    await state.streamPromise;
  } catch (err: unknown) {
    tuiLogger.debug("stream promise rejected during exit: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return resolveExitCode({
    runError: state.runError,
    sinkError,
    status: services.runSink.getStatus(),
    teardownFailed,
  });
}
