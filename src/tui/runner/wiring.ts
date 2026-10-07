/**
 * Post-mount TUI startup wiring: model prefetch, shutdown registration,
 * provider stamping, fleet watch, resume hydration, MCP connect, notices.
 * Owns the fleet timers so the quit path can stop them via the state slot.
 */

import { getLogger } from "@intx/log";
import {
  loadSettings,
  listFavoriteModels,
  listRecentModels,
} from "../../config/settings.js";
import { refreshLiveProviderCatalog } from "../../config/index.js";
import type { ResolvedProvider } from "../../config/settings.js";
import {
  prefetchGoModels,
  prefetchZenModels,
} from "../../provider/model-catalogs.js";
import { isOpenCodeGoProvider } from "../../../packages/opencode-go/src/index.js";
import { isZenProvider } from "../../../packages/zen/src/index.js";
import { loadRecentTurns } from "../../session/optimized-context-store.js";
import { loadSentMessages } from "../../session/sent-messages.js";
import { setActiveDisposeHost } from "../../session/active-host.js";
import {
  createFleetWatch,
  driveOpenTasksAfterFleetDry,
  driveMailboxMail,
  latchMailboxMailDrive,
  FLEET_REPORT_SETTLE_MS,
  FLEET_STALL_POLL_MS,
  liveFleetCount,
  observeFleet,
  pendingAskSnapshot,
} from "../../subagent/index.js";
import { scheduleUpgradeNotice } from "../../upgrade/index.js";
import pkg from "../../../package.json" with { type: "json" };
import { hydrateTasksFromTurns } from "../../agent/director.js";
import {
  cycleReasoningEffort,
  resolveSessionEffort,
} from "../../provider/reasoning-effort.js";
import { isCodexProviderName } from "../../config/codex-providers.js";
import { customReasoningSettings } from "../../config/providers.js";
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import {
  RESUME_TRANSCRIPT_TURN_LIMIT,
  turnsToContentBlocks,
} from "../turns-to-blocks.js";
import { setPluginNeedsAttention, setStatusFlash } from "../shell/chrome.js";
import {
  setEffortCycleHandler,
  setMentionSuggestionSource,
  setPromptRecognitionSource,
  setShellStopAffordance,
  type AppShell,
  type ShellStopAffordance,
} from "../shell/internals.js";
import {
  setPromptModelLabel,
  setSentMessageHistory,
  surfaceSystemNotice,
} from "../shell/prompt.js";
import { listPathSuggestions } from "../components/at-mention/list.js";
import {
  composePromptActionBarModelLabel,
  yoloModeLabel,
} from "../components/prompt-action-bar-label.js";
import { composeSessionHeader } from "../components/session-header.js";
import { listCommands } from "../commands/registry.js";
import type { MCPConnectCallbacks } from "../../agent/tools.js";
import { createRuntimeShutdown } from "./shutdown.js";
import { ASK_DEADLINE_MS } from "../../subagent/session-store.js";
import { resumeTranscriptLoadErrorBlock } from "./exit.js";
import { userInboundMessage } from "./submit.js";
import {
  hostOf,
  liveAgent,
  type RunnerServices,
  type RunnerState,
} from "./state.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { savedSkipPermissionsWarning } from "../../permission/saved-skip-warning.js";
import {
  buildFleetDryContinuationMessage,
  buildMailboxMailMessage,
} from "../../session/runtime-assembly.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export function surfaceSavedSkipPermissionsWarning(
  shell: AppShell,
  config: Pick<
    RunnerState["config"],
    "globalSettingsPath" | "skipPermissionsFromSettings"
  >,
): void {
  if (!config.skipPermissionsFromSettings) return;
  surfaceSystemNotice(
    shell,
    savedSkipPermissionsWarning(config.globalSettingsPath, "tui"),
  );
}

/**
 * One tick of the periodic fleet stall poll.
 *
 * The subscribe-time mailbox edge is missable (parent mid-turn, or a
 * swallowed driver send), so re-flushing here bounds the stall to one poll
 * interval. The stall bound rides the same tick, deadline first: expired
 * asks settle before the abort reconciles, then a still-silent wake turn
 * aborts. Expire-abort fires only when asks expired this tick and nothing
 * is left to re-surface; send_input emptying pending is not an expire.
 */
export function createFleetStallPollTick(
  reportFleet: () => void,
  flushMailboxMail: () => void,
  options?: {
    abortStalledWakeTurn?: () => boolean;
    abortExpiredWakeTurn?: (expiredThisTick: boolean) => boolean;
    expireStaleAsks?: () =>
      | boolean
      | readonly { sessionId: string; questionId: string }[];
  },
): () => void {
  return () => {
    const expired = options?.expireStaleAsks?.();
    const expiredThisTick =
      expired === true || (Array.isArray(expired) && expired.length > 0);
    reportFleet();
    options?.abortExpiredWakeTurn?.(expiredThisTick);
    options?.abortStalledWakeTurn?.();
    flushMailboxMail();
  };
}

export interface StopTeardownDeps {
  subAgentSessions: Pick<
    RunnerServices["subAgentSessions"],
    "cancelAll" | "teardown"
  >;
  fleetRecords: { clear: () => void } | undefined;
  bridge: { clearQueuedDelivery: () => void };
}

/**
 * Cancel live workers and drop fleet records, leaving tombstones so a later
 * quit-path cancelAll is a no-op. Does not wipe the held delivery queue —
 * stay-alive 2nd-press stop uses this so follow-ups stay pending.
 */
export async function cancelLiveWorkers(
  deps: Omit<StopTeardownDeps, "bridge">,
): Promise<void> {
  await deps.subAgentSessions.cancelAll("Session closed");
  deps.subAgentSessions.teardown("Session closed");
  deps.fleetRecords?.clear();
}

/**
 * Stop teardown: cancel the workers, wipe the sessions (leaving
 * tombstones so a late send_input names the teardown), drop the mailbox
 * lanes that pin them, and clear the bridge queue so no wake-turn bound
 * outlives the sessions it was owed to. Exported so the stall-bound
 * regression test drives this exact production path instead of re-wiring
 * the three clears by hand. Quit / shutdown keep this wipe; stay-alive
 * stop uses `cancelLiveWorkers` instead.
 */
export async function cancelWorkersForStop(
  deps: StopTeardownDeps,
): Promise<void> {
  await cancelLiveWorkers(deps);
  deps.bridge.clearQueuedDelivery();
}

/**
 * Stop-teardown sources for the shell stop affordance (CL-10149 Phase 4).
 * Live-worker count is the authoritative `liveFleetCount` over the session
 * store (not the bridge-local mirror); the stop callback cancels workers
 * and fleet records without wiping the held queue, so a 2nd-press stay-alive
 * stop keeps pending follow-ups. Quit still goes through
 * `cancelWorkersForStop` (wiring.ts shutdown path) and wipes. Extracted so
 * the Phase 4 wiring test can drive the real closure against a harnessed
 * store without a full runner harness.
 */
export function buildShellStopAffordance(deps: {
  subAgentSessions: Pick<
    RunnerServices["subAgentSessions"],
    "list" | "cancelAll" | "teardown"
  >;
  toolset: { fleetRecords?: { clear: () => void } | undefined };
}): ShellStopAffordance {
  return {
    liveWorkerCount: () => liveFleetCount(deps.subAgentSessions.list()),
    onStopWorkers: () =>
      cancelLiveWorkers({
        subAgentSessions: deps.subAgentSessions,
        fleetRecords: deps.toolset.fleetRecords,
      }),
  };
}

export function createFleetWakePublisher(
  sessions: RunnerServices["subAgentSessions"],
  emitter: RunnerServices["emitter"],
  // Fired on fleet-count transitions so the director's seeded allowance
  // tracks the live fleet. Omitted in tests that only assert events.
  onFleetCount?: (running: number) => void,
) {
  let lastLiveFleet = 0;
  let suspended = false;
  const publish = (): { previousRunning: number; running: number } => {
    if (suspended)
      return { previousRunning: lastLiveFleet, running: lastLiveFleet };
    const lanes = sessions.list();
    // Reconcile an empty snapshot before a fleet drop settles the parent.
    const asks = pendingAskSnapshot(lanes, (id) => sessions.peekAsk(id));
    emitter.emit("event", { type: "agent-ask", asks });
    const previousRunning = lastLiveFleet;
    const fleet = liveFleetCount(lanes);
    if (fleet !== lastLiveFleet) {
      lastLiveFleet = fleet;
      emitter.emit("event", { type: "fleet", running: fleet });
      onFleetCount?.(fleet);
    }
    return { previousRunning, running: fleet };
  };
  const withSuspended = (reset: () => void): void => {
    suspended = true;
    // The bridge clears its fleet count even when the store's count is unchanged.
    lastLiveFleet = -1;
    try {
      reset();
    } finally {
      suspended = false;
    }
    // Reached only after reset() returns; a throw leaves publication
    // suppressed so a failed reset cannot publish a partial snapshot.
    publish();
  };
  return { publish, withSuspended };
}

export function wirePostStartup(
  state: RunnerState,
  services: RunnerServices,
  mcpConnectCallbacks: MCPConnectCallbacks,
): void {
  if (state.config.providers.some((p) => isOpenCodeGoProvider(p))) {
    void prefetchGoModels()
      .then(async () => {
        if (services.hostHolder.instance === undefined) return;
        const onDisk = await loadSettings(state.trueGlobalSettingsPath);
        const resolvedForCatalog: ResolvedProvider = {
          apiKey: state.config.apiKey,
          baseURL: state.config.baseURL,
          model: state.config.model,
          providerName: state.config.providerName,
          ...(state.config.keyless !== undefined
            ? { keyless: state.config.keyless }
            : {}),
        };
        const providers = await refreshLiveProviderCatalog(
          onDisk,
          resolvedForCatalog,
        );
        state.config = {
          ...state.config,
          providers,
          ...(onDisk !== null ? { settings: onDisk } : {}),
        };
        services.hostHolder.instance.refreshModels(
          listRecentModels(state.config.settings ?? { providers: {} }),
          listFavoriteModels(state.config.settings ?? { providers: {} }),
          providers,
        );
      })
      .catch((err: unknown) => {
        tuiLogger.debug("go model prefetch failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (state.config.providers.some((p) => isZenProvider(p))) {
    void prefetchZenModels()
      .then(async () => {
        if (services.hostHolder.instance === undefined) return;
        const onDisk = await loadSettings(state.trueGlobalSettingsPath);
        const resolvedForCatalog: ResolvedProvider = {
          apiKey: state.config.apiKey,
          baseURL: state.config.baseURL,
          model: state.config.model,
          providerName: state.config.providerName,
          ...(state.config.keyless !== undefined
            ? { keyless: state.config.keyless }
            : {}),
        };
        const providers = await refreshLiveProviderCatalog(
          onDisk,
          resolvedForCatalog,
        );
        state.config = {
          ...state.config,
          providers,
          ...(onDisk !== null ? { settings: onDisk } : {}),
        };
        services.hostHolder.instance.refreshModels(
          listRecentModels(state.config.settings ?? { providers: {} }),
          listFavoriteModels(state.config.settings ?? { providers: {} }),
          providers,
        );
      })
      .catch((err: unknown) => {
        tuiLogger.debug("zen model prefetch failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  const shutdownRuntime = createRuntimeShutdown({
    disposeHost: hostOf(state).dispose,
    cancelWorkers: async () => {
      await cancelWorkersForStop({
        subAgentSessions: services.subAgentSessions,
        fleetRecords: services.toolset.fleetRecords,
        bridge: hostOf(state).bridge,
      });
    },
    closeAgent: () => liveAgent(state).close(),
    disposeToolset: () => services.toolset.dispose(),
  });
  state.shutdownRuntime = shutdownRuntime;
  services.crashGuard.setDisposeHost(() => shutdownRuntime());
  setActiveDisposeHost(() => services.crashGuard.invokeDisposeHost());

  // CL-10149 three-press: register the shell stop affordance so the 2nd Ctrl+C
  // (with live sub-agents) stops workers while the app stays running. The
  // runner owns the source of truth; the shell stays service-free. Stay-alive
  // stop cancels workers without wiping the held queue; quit still wipes
  // through cancelWorkersForStop. Tombstones keep a later quit-path cancelAll
  // a no-op.
  setShellStopAffordance(
    hostOf(state).shell,
    buildShellStopAffordance(services),
  );

  // Inference.error events omit providerId; stamp the live catalog id so
  // transcript copy can identify known-xAI short 429s.
  state.stampProvider.fn = (id) =>
    hostOf(state).bridge.setInferenceProviderId(
      id,
      id === undefined ? undefined : state.config.settings?.providers[id]?.name,
    );
  state.stampProvider.fn(state.config.providerName);

  setMentionSuggestionSource(hostOf(state).shell, (prefix) =>
    listPathSuggestions(prefix, state.config.cwd),
  );

  // Store changes drive the fleet report, so a lane surfaces the moment it
  // finishes; the settle timer coalesces a burst, and the stall poll re-runs
  // a lane that goes quiet without a store event.
  const sessionBridge = hostOf(state).bridge;
  let fleetWatch = createFleetWatch();
  const reportFleet = (): void => {
    const observation = observeFleet(
      fleetWatch,
      services.subAgentSessions.list(),
      Date.now(),
    );
    fleetWatch = observation.watch;
    for (const update of observation.updates)
      surfaceSystemNotice(hostOf(state).shell, update);
  };
  let fleetSettle: ReturnType<typeof setTimeout> | null = null;
  const fleetWakePublisher = createFleetWakePublisher(
    services.subAgentSessions,
    services.emitter,
    // Keep the seeded idle-with-fleet allowance live; degrades gracefully
    // before the director is built.
    (running) =>
      services.directorHolder.instance?.setAllowIdleWithFleet(running > 0),
  );
  state.withFleetPublicationSuspended = fleetWakePublisher.withSuspended;
  sessionBridge.setDryOpenTaskDriver(() => {
    const send = state.sendWithAttemptIdentity;
    if (send === undefined) return false;
    const storage = state.currentStorage;
    return driveOpenTasksAfterFleetDry({
      deferredDryEdge: true,
      openTasks: services.directorHolder.instance?.getTasks() ?? [],
      parentProcessing: false,
      isParentProcessing: () => sessionBridge.turn.isProcessing,
      mailbox: services.toolset.fleetRecords,
      lanes: services.subAgentSessions.list(),
      ...(storage !== null
        ? {
            writeBlob: (key, bytes, contentType) =>
              storage.writeBlob(key, bytes, contentType),
          }
        : {}),
      beginSystemContinuation: (prompt) => {
        sessionBridge.beginSystemContinuation(prompt);
      },
      send: (prompt) => send(buildFleetDryContinuationMessage(prompt)),
      onSendFailure: () => {
        sessionBridge.abortSystemContinuation();
      },
    });
  });
  sessionBridge.setMailboxMailDriver(
    latchMailboxMailDrive(() => {
      const send = state.sendWithAttemptIdentity;
      if (send === undefined) return false;
      const storage = state.currentStorage;
      return driveMailboxMail({
        parentProcessing: sessionBridge.turn.isProcessing,
        isParentProcessing: () => sessionBridge.turn.isProcessing,
        mailbox: services.toolset.fleetRecords,
        lanes: services.subAgentSessions.list(),
        ...(storage !== null
          ? {
              writeBlob: (key, bytes, contentType) =>
                storage.writeBlob(key, bytes, contentType),
            }
          : {}),
        beginSystemContinuation: (prompt) => {
          sessionBridge.beginSystemContinuation(prompt);
        },
        send: (prompt) => send(buildMailboxMailMessage(prompt)),
        onSendFailure: () => {
          sessionBridge.abortSystemContinuation({ rearmDry: false });
        },
      });
    }),
  );
  sessionBridge.setOnAskWakeSent((asks) => {
    services.toolset.fleetRecords?.noteParkedAsksSurfaced(
      asks.map((ask) => ({
        id: ask.sessionId,
        questionId: ask.questionId,
      })),
    );
  });
  sessionBridge.setWaitYieldWake(() => {
    services.subAgentSessions.wake();
  });
  const unsubscribeFleetReport = services.subAgentSessions.subscribe(() => {
    fleetWakePublisher.publish();
    sessionBridge.flushMailboxMail();
    if (fleetSettle !== null) return;
    fleetSettle = setTimeout(() => {
      fleetSettle = null;
      reportFleet();
    }, FLEET_REPORT_SETTLE_MS);
    if (typeof fleetSettle.unref === "function") fleetSettle.unref();
  });
  const fleetStallPollTick = createFleetStallPollTick(
    reportFleet,
    () => sessionBridge.flushMailboxMail(),
    {
      // Deadline-past asks settle inside the tick before the abort reconciles.
      abortStalledWakeTurn: () => sessionBridge.abortStalledWakeTurn(),
      abortExpiredWakeTurn: (expiredThisTick) =>
        sessionBridge.abortExpiredWakeTurn(expiredThisTick),
      expireStaleAsks: () =>
        services.subAgentSessions.expireStaleAsks(ASK_DEADLINE_MS),
    },
  );
  const fleetStallPoll = setInterval(fleetStallPollTick, FLEET_STALL_POLL_MS);
  if (typeof fleetStallPoll.unref === "function") fleetStallPoll.unref();
  state.stopFleetReporting = (): void => {
    clearInterval(fleetStallPoll);
    if (fleetSettle !== null) clearTimeout(fleetSettle);
    unsubscribeFleetReport();
    sessionBridge.setDryOpenTaskDriver(undefined);
    sessionBridge.setMailboxMailDriver(undefined);
    sessionBridge.setOnAskWakeSent(undefined);
    sessionBridge.setWaitYieldWake(undefined);
  };

  // Registered slash-command names only — bare skill/agent words stay unstyled.
  setPromptRecognitionSource(hostOf(state).shell, () => ({
    commandNames: listCommands().map((command) => command.name),
  }));

  // Shift+Tab cycles reasoning effort; rebuild sources so the next turn
  // picks up the new providerOptions.reasoning_effort.
  setEffortCycleHandler(hostOf(state).shell, () => {
    const reasoning = customReasoningSettings(
      state.config.providerName,
      state.config.settings?.providers[state.config.providerName],
      state.config.providers.find(
        (entry) => entry.name === state.config.providerName,
      ),
    );
    const next = cycleReasoningEffort(
      state.config.model,
      state.config.reasoningEffort,
      isCodexProviderName(state.config.providerName),
      reasoning?.reasoningEfforts,
      reasoning?.defaultReasoningEffort,
    );
    if (next === undefined) {
      setStatusFlash(
        hostOf(state).shell,
        "this model has no reasoning effort levels",
        {
          ttlMs: RUNTIME_FLASH_MS,
        },
      );
      return;
    }
    state.config = { ...state.config, reasoningEffort: next };
    const bundle = services.buildSessionSources();
    state.agentProxy?.setSources(bundle.sources, bundle.defaultSource);
    setPromptModelLabel(hostOf(state).shell, {
      profile: state.config.providerName,
      model: state.config.model,
      effort: next,
      mode: yoloModeLabel(state.config.dangerouslySkipPermissions),
    });
    setStatusFlash(hostOf(state).shell, `reasoning effort: ${next}`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
  });

  // Recall spans the whole session, including pre-resume sends.
  void loadSentMessages(state.config.cwd, state.sessionId)
    .then((sent) => setSentMessageHistory(hostOf(state).shell, sent))
    .catch((err: unknown) => {
      tuiLogger.debug("sent-message history load failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  if (!state.resumeSkipInitialTask && state.config.task.trim().length > 0) {
    // The operator's initial CLI task — same provenance as a prompt submit.
    void state.sendWithAttemptIdentity?.(
      userInboundMessage(state.config.task.trim(), []),
    );
  }

  // Hydrate the resumed transcript after first paint; the mapping is pure I/O,
  // so the App renders empty and fills in once ready. The window is in turns,
  // sized so a tool-pair-heavy tail still fills the row cap after fold. Agent
  // conversation state loads in full elsewhere; this path is display-only.
  void loadRecentTurns(state.workdir, RESUME_TRANSCRIPT_TURN_LIMIT)
    .then((recent) => {
      const blocks = turnsToContentBlocks(recent.turns);
      const tasks = hydrateTasksFromTurns(recent.turns);
      // Restored tasks go to the panel only; scrollback too would render the
      // list twice.
      if (tasks.length > 0) {
        // The director holds the list; the host announces what the
        // tasks-changed event would carry.
        services.directorHolder.instance?.restoreTasks(tasks);
        services.emitter.emit("tasks", tasks);
      }
      if (blocks.length > 0) {
        services.emitter.emit("history.hydrate", {
          blocks,
          truncated: recent.truncated,
        });
      }
    })
    .catch((err: unknown) => {
      // A silent empty transcript looks like a brand-new session; surface a
      // one-line error block so the operator knows history failed to load.
      const block = resumeTranscriptLoadErrorBlock(err);
      tuiLogger.warn(
        "Failed to load resume transcript from {workdir}: {error}",
        {
          workdir: state.workdir,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      services.emitter.emit("history.hydrate", [block]);
    });

  // Connect MCP after the TUI is up so auth surfaces as a copyable link, not
  // a browser pop; tools land on the live runner and stay unadvertised until
  // tool_search promotes them. On settle, reload-if-idle so construction-time
  // maps match, then resume any persisted workflow. Aborted on exit so an
  // unfinished auth wait does not keep the process alive.
  void services.toolset
    .connectMCP(mcpConnectCallbacks, services.mcpConnectController.signal)
    .then(async () => {
      if (
        services.toolset.dynamicRunner.currentDefinitions().length >
        services.baseToolCount
      ) {
        state.pendingReload = true;
        state.reloadIfIdle?.();
      }
      // Capability map reflects connected servers; restore any persisted workflow.
      await services.workflowHost.resume();
    })
    .catch((err: unknown) => {
      // Aborts on exit are expected; log other failures instead of an
      // unhandled rejection.
      if (err instanceof Error && err.name === "AbortError") return;
      getLogger([LOG_NAMESPACE_ROOT, "tui", "mcp"]).error(
        "MCP connect failed: {error}",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    });

  // The session header goes first among the deferred startup rows; a
  // re-filed telemetry disclosure still lands ahead of it. Later /yolo or
  // effort toggles move the prompt border label only.
  const reasoning = customReasoningSettings(
    state.config.providerName,
    state.config.settings?.providers[state.config.providerName],
    state.config.providers.find(
      (entry) => entry.name === state.config.providerName,
    ),
  );
  const headerEffort = resolveSessionEffort(
    state.config.model,
    state.config.reasoningEffort,
    isCodexProviderName(state.config.providerName),
    reasoning?.reasoningEfforts,
    reasoning?.defaultReasoningEffort,
  );
  surfaceSystemNotice(
    hostOf(state).shell,
    composeSessionHeader({
      essentials: composePromptActionBarModelLabel({
        profile: state.config.providerName,
        model: state.config.model,
        ...(headerEffort !== undefined ? { effort: headerEffort } : {}),
        mode: yoloModeLabel(state.config.dangerouslySkipPermissions),
      }),
    }),
  );

  // Surface startup notices now that a shell exists. Plugin load warnings are
  // NOT notices — they drive `plugin !` and `/plugins` instead.
  for (const notice of state.startupPluginNotices)
    surfaceSystemNotice(hostOf(state).shell, notice);
  state.paintPluginAttention = (needs) =>
    setPluginNeedsAttention(hostOf(state).shell, needs);
  state.paintPluginAttention(state.standingPluginWarnings.length > 0);

  // A persisted /yolo default is otherwise silent; surface it so the operator
  // knows prompts are off.
  surfaceSavedSkipPermissionsWarning(hostOf(state).shell, state.config);

  // Soft upgrade check: never blocks startup; offline/rate-limit skips quietly.
  scheduleUpgradeNotice({
    notify: (text) => surfaceSystemNotice(hostOf(state).shell, text),
    options: {
      currentVersion: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    },
  });
}
