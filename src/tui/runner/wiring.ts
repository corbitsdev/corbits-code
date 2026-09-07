/**
 * Post-mount startup wiring for the TUI runner: go-model prefetch, runtime
 * shutdown registration, provider-id stamping, mention/prompt recognition,
 * the fleet watch, the effort-cycle chord, resume hydration, initial MCP
 * connect, and startup notices. Owns the fleet timers so the quit path can
 * stop them through the state slot.
 */

import { getLogger } from "@intx/log";
import { loadSettings, listFavoriteModels, listRecentModels } from "../../config/settings.js";
import { refreshLiveProviderCatalog } from "../../config/index.js";
import type { ResolvedProvider } from "../../config/settings.js";
import { prefetchGoModels } from "../../provider/opencode-go-models.js";
import { isOpenCodeGoProvider } from "../../../packages/opencode-go/src/index.js";
import { loadRecentTurns } from "../../session/optimized-context-store.js";
import { loadSentMessages } from "../../session/sent-messages.js";
import { setActiveDisposeHost } from "../../session/active-host.js";
import {
  createFleetWatch,
  FLEET_REPORT_SETTLE_MS,
  FLEET_STALL_POLL_MS,
  liveFleetCount,
  observeFleet,
} from "../../subagent/index.js";
import { scheduleUpgradeNotice } from "../../upgrade/index.js";
import pkg from "../../../package.json" with { type: "json" };
import { hydrateTasksFromTurns } from "../../agent/director.js";
import { cycleReasoningEffort } from "../../provider/reasoning-effort.js";
import { isCodexProviderName } from "../../config/codex-providers.js";
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import { RESUME_TRANSCRIPT_BLOCK_LIMIT, turnsToContentBlocks } from "../turns-to-blocks.js";
import { setPluginNeedsAttention, setStatusFlash } from "../shell/chrome.js";
import {
  setEffortCycleHandler,
  setMentionSuggestionSource,
  setPromptRecognitionSource,
} from "../shell/internals.js";
import {
  setPromptModelLabel,
  setSentMessageHistory,
  surfaceSystemNotice,
} from "../shell/prompt.js";
import { listPathSuggestions } from "../components/at-mention/list.js";
import { listCommands } from "../commands/registry.js";
import type { MCPConnectCallbacks } from "../../agent/tools.js";
import { createRuntimeShutdown } from "./shutdown.js";
import { resumeTranscriptLoadErrorBlock } from "./exit.js";
import { userInboundMessage } from "./submit.js";
import { hostOf, liveAgent, type RunnerServices, type RunnerState } from "./state.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

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
          ...(state.config.keyless !== undefined ? { keyless: state.config.keyless } : {}),
        };
        const providers = await refreshLiveProviderCatalog(onDisk, resolvedForCatalog);
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

  const shutdownRuntime = createRuntimeShutdown({
    disposeHost: hostOf(state).dispose,
    cancelWorkers: () => {
      services.subAgentSessions.cancelAll("Session closed");
    },
    closeAgent: () => liveAgent(state).close(),
  });
  state.shutdownRuntime = shutdownRuntime;
  services.crashGuard.setDisposeHost(() => {
    void shutdownRuntime();
  });
  setActiveDisposeHost(() => services.crashGuard.invokeDisposeHost());

  // Harness inference.error events omit providerId; stamp the live catalog id
  // onto the stream map so transcript copy can identify known-xAI short 429s.
  state.stampProvider.fn = (id) =>
    hostOf(state).bridge.setInferenceProviderId(
      id,
      id === undefined ? undefined : state.config.settings?.providers[id]?.name,
    );
  state.stampProvider.fn(state.config.providerName);

  setMentionSuggestionSource(hostOf(state).shell, (prefix) =>
    listPathSuggestions(prefix, state.config.cwd),
  );

  // The fleet reports itself. Store changes drive it, so a lane finishing or
  // failing is on screen the moment it happens rather than at the next turn
  // boundary. The settle timer coalesces a parallel burst into one observation;
  // the stall poll re-runs so a lane that goes quiet with no further store
  // event is still announced once. `observeFleet` decides what is worth saying.
  let fleetWatch = createFleetWatch();
  const reportFleet = (): void => {
    const observation = observeFleet(fleetWatch, services.subAgentSessions.list(), Date.now());
    fleetWatch = observation.watch;
    for (const update of observation.updates) surfaceSystemNotice(hostOf(state).shell, update);
  };
  let fleetSettle: ReturnType<typeof setTimeout> | null = null;
  // Live-lane count feeds the bridge's idle-with-fleet hold (CL-7057): the
  // run stays busy after the parent turn settles until the last lane
  // terminalizes. Store notifications fire per child event, not per status
  // flip, so emit only when the count itself moves.
  let lastLiveFleet = 0;
  const unsubscribeFleetReport = services.subAgentSessions.subscribe(() => {
    const fleet = liveFleetCount(services.subAgentSessions.list());
    if (fleet !== lastLiveFleet) {
      lastLiveFleet = fleet;
      services.emitter.emit("event", { type: "fleet", running: fleet });
    }
    if (fleetSettle !== null) return;
    fleetSettle = setTimeout(() => {
      fleetSettle = null;
      reportFleet();
    }, FLEET_REPORT_SETTLE_MS);
    if (typeof fleetSettle.unref === "function") fleetSettle.unref();
  });
  const fleetStallPoll = setInterval(reportFleet, FLEET_STALL_POLL_MS);
  if (typeof fleetStallPoll.unref === "function") fleetStallPoll.unref();
  state.stopFleetReporting = (): void => {
    clearInterval(fleetStallPoll);
    if (fleetSettle !== null) clearTimeout(fleetSettle);
    unsubscribeFleetReport();
  };

  // Registered slash-command names only — bare skill/agent words stay unstyled.
  setPromptRecognitionSource(hostOf(state).shell, () => ({
    commandNames: listCommands().map((command) => command.name),
  }));

  // Shift+Tab: cycle reasoning effort for the live model and rebuild sources so
  // the next inference turn picks up the new providerOptions.reasoning_effort.
  setEffortCycleHandler(hostOf(state).shell, () => {
    const next = cycleReasoningEffort(
      state.config.model,
      state.config.reasoningEffort,
      isCodexProviderName(state.config.providerName),
    );
    if (next === undefined) {
      setStatusFlash(hostOf(state).shell, "this model has no reasoning effort levels", {
        ttlMs: RUNTIME_FLASH_MS,
      });
      return;
    }
    state.config = { ...state.config, reasoningEffort: next };
    const bundle = services.buildSessionSources();
    state.agentProxy?.setSources(bundle.sources, bundle.defaultSource);
    setPromptModelLabel(hostOf(state).shell, {
      profile: state.config.providerName,
      model: state.config.model,
      effort: next,
    });
    setStatusFlash(hostOf(state).shell, `reasoning effort: ${next}`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
  });

  // Recall spans the whole session, including what was sent before a resume.
  void loadSentMessages(state.config.cwd, state.sessionId)
    .then((sent) => setSentMessageHistory(hostOf(state).shell, sent))
    .catch(() => undefined);

  if (!state.resumeSkipInitialTask && state.config.task.trim().length > 0) {
    // The operator's initial task, typed as a CLI argument before launch —
    // same provenance as a prompt submit.
    void state.sendWithAttemptIdentity?.(userInboundMessage(state.config.task.trim(), []));
  }

  // Hydrate a resumed session's transcript after first paint. Reading history and
  // mapping it to content blocks is pure I/O with no bearing on the shell, so the
  // App renders empty immediately and fills in the past turns once they are ready.
  // Only the tail needed to fill RESUME_TRANSCRIPT_BLOCK_LIMIT blocks is read from
  // disk — a long session's full history is not needed just to paint a transcript
  // that itself caps how much it displays.
  void loadRecentTurns(state.workdir, RESUME_TRANSCRIPT_BLOCK_LIMIT)
    .then((turns) => {
      const blocks = turnsToContentBlocks(turns, { maxBlocks: RESUME_TRANSCRIPT_BLOCK_LIMIT });
      const tasks = hydrateTasksFromTurns(turns);
      // Restored tasks go to the panel only. They are live state, not something
      // that happened in the conversation, so putting them in scrollback as well
      // renders the same list twice on one screen.
      if (tasks.length > 0) services.directorHolder.instance?.restoreTasks(tasks);
      if (blocks.length > 0) services.emitter.emit("history.hydrate", blocks);
    })
    .catch((err: unknown) => {
      // Resume still works without painted history, but a silent empty
      // transcript looks like a brand-new session. Log and surface a one-line
      // error block so the operator knows history failed to load.
      const block = resumeTranscriptLoadErrorBlock(err);
      tuiLogger.warn("Failed to load resume transcript from {workdir}: {error}", {
        workdir: state.workdir,
        error: err instanceof Error ? err.message : String(err),
      });
      services.emitter.emit("history.hydrate", [block]);
    });

  // Connect MCP servers after the TUI is up so the UI is usable immediately and
  // any OAuth authorization is surfaced as a copyable link rather than a browser
  // pop. Each connected server's tools land on the live runner and are
  // dispatchable the same turn (createAgentWithLiveToolDispatch). They stay
  // unadvertised until tool_search promotes them. When every server has
  // settled, reload-if-idle so construction-time maps match, then resume any
  // persisted workflow. Aborted on exit so an unfinished auth wait does not
  // keep the process alive.
  void services.toolset
    .connectMCP(mcpConnectCallbacks, services.mcpConnectController.signal)
    .then(async () => {
      if (services.toolset.dynamicRunner.currentDefinitions().length > services.baseToolCount) {
        state.pendingReload = true;
        state.reloadIfIdle?.();
      }
      // Now that the capability map reflects connected MCP servers, restore any
      // persisted workflow. New workflows are manual-only slash commands.
      await services.workflowController.resume();
    })
    .catch((err: unknown) => {
      // Fire-and-forget: an aborted connect on exit is expected and ignored;
      // any other failure is logged rather than raised as an unhandled rejection.
      if (err instanceof Error && err.name === "AbortError") return;
      getLogger([LOG_NAMESPACE_ROOT, "tui", "mcp"]).error("MCP connect failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Surface fire-and-forget startup notices now that there is a shell (queued
  // above, before `host` existed). Plugin load warnings are NOT notices — they
  // drive `plugin !` and `/plugins` instead.
  for (const notice of state.startupPluginNotices) surfaceSystemNotice(hostOf(state).shell, notice);
  state.paintPluginAttention = (needs) => setPluginNeedsAttention(hostOf(state).shell, needs);
  state.paintPluginAttention(state.standingPluginWarnings.length > 0);

  // The persisted /yolo default is otherwise silent: nothing on screen would
  // otherwise tell the operator that permission prompts are off for a repo
  // they never ran --dangerously-skip-permissions or /yolo in.
  if (state.config.skipPermissionsFromSettings) {
    surfaceSystemNotice(
      hostOf(state).shell,
      "Permission prompts are disabled by your saved default (/yolo off to re-enable).",
    );
  }

  // Soft upgrade check: never blocks startup; offline / rate-limit is a quiet skip.
  // surfaceSystemNotice keeps the landing hero up and flushes into the transcript
  // once a session row ends the landing (same path as MCP startup chatter).
  scheduleUpgradeNotice({
    notify: (text) => surfaceSystemNotice(hostOf(state).shell, text),
    options: {
      currentVersion: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    },
  });
}
