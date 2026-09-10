/**
 * TUI runner orchestration (CL-6791 phase 4): runTUI assembles the state bag
 * and services, wires the split modules in the original runTUI order
 * (session assembly → run lifecycle → settings → commands → submit → mcp →
 * host mount → post-startup wiring → exit), and owns the crash-guard
 * try/catch. Behavior lives in the sibling modules; this file owns ordering.
 */

import { EventEmitter } from "node:events";
import type { Config } from "../../config/index.js";
import { listFavoriteModels, listRecentModels } from "../../config/settings.js";
import { isCodexProviderName } from "../../config/codex-providers.js";
import { resolveSessionEffort } from "../../provider/reasoning-effort.js";
import { liveTelemetry } from "../../telemetry/singleton.js";
import { isFeedbackCapturePending } from "../../telemetry/feedback.js";
import { emitPluginWarningLog } from "../../plugins/diagnostics.js";
import { createPluginsAdminState } from "../plugins-admin-backend.js";
import { prepareTUISession } from "../session-start.js";
import {
  addProviderSelectorChoices,
  providerChoices,
} from "../provider/choices.js";
import { listCommands } from "../commands/registry.js";
import { mountRunnerHost } from "./host.js";
import { assembleTUISession } from "./session.js";
import { createRunLifecycle, finalizeTUIRun } from "./exit.js";
import { wireSettings } from "./settings.js";
import { setUpCommandRegistry, createCommandLayer } from "./commands.js";
import {
  classifySubmission,
  createDeliverRouting,
  createSubmitPath,
  routeSubmission,
} from "./submit.js";
import { wireMcp } from "./mcp.js";
import { wirePostStartup } from "./wiring.js";
import { createRunnerState } from "./state.js";
import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export { getTUIRunSummaryStatus } from "../../session/run-sink.js";

export async function runTUI(initialConfig: Config): Promise<number> {
  const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);
  const start = await prepareTUISession(initialConfig, liveTelemetry);
  if (start === null) return 0;
  const state = createRunnerState(start);

  const { pluginModules } = start.trust;
  // /plugins UI backend state: discovered modules plus live, persisted config
  // (enabled flag, credentials, web override, extra paths). Trust grants swap
  // metadata-only stubs for full loads without restarting the process.
  const pluginState = createPluginsAdminState({
    cwd: state.config.cwd,
    settings: state.config.settings,
    modules: pluginModules,
    pathTrust: start.trust.pathTrust,
    projectTrust: start.trust.projectTrust,
  });
  emitPluginWarningLog(start.pluginLoadDiag);
  // Fire-and-forget startup diagnostics (this + tool-plugin / profile
  // resolution in the session assembly) have no result channel back to an
  // operator action. Log-only is fine for the structured logger; the standing
  // `plugin !` mark and `/plugins` surface carry the same warnings to the
  // operator instead of a startup system notice.
  const executablePlugins = () =>
    pluginState.modules.filter((m) => m.metadataOnly !== true);
  setUpCommandRegistry(
    state.config.settings,
    executablePlugins(),
    () => pluginState.pluginConfig,
  );
  start.crashGuard.bindLiveSession(() => ({
    cwd: state.config.cwd,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    runTaskTitle: state.runTaskTitle,
    providerName: state.config.providerName,
    model: state.config.model,
  }));

  try {
    const services = await assembleTUISession(state, start, pluginState);
    const lifecycle = await createRunLifecycle(state, services);
    const settings = await wireSettings(state, services);
    const commands = createCommandLayer(state, services);
    const live = {
      attemptIdentity: commands.currentAttemptIdentity,
      agentProxy: lifecycle.agentProxy,
    };
    const submit = createSubmitPath(state, services, live);
    const mcp = wireMcp(state, services);

    // Mount OpenTUI before the initial task is sent so gate and stream listeners
    // are registered first. Ctrl+C stays with the shell (interrupt the run);
    // OpenTUI owns the alternate screen and mouse reporting itself.
    // Alt+A add-provider selector rows: every first-class provider kind,
    // including Custom (full manual form). No already-connected filtering —
    // OAuth and multi-instance accounts are per-name, so dropping a kind once
    // it has one account would hide the path to a second. Read fresh on each
    // open against the live catalog.
    const computeAddProviderChoices = () =>
      addProviderSelectorChoices(providerChoices(), state.config.providers);

    const host = await mountRunnerHost({
      // An unnamed session shows nothing rather than a placeholder.
      title: state.runTaskTitle,
      cwd: process.cwd(),
      eventEmitter: services.emitter,
      send: submit.send,
      classifySubmit: (text, attachments) =>
        classifySubmission(text, {
          hasAttachments: attachments !== undefined && attachments.length > 0,
          feedbackPending: isFeedbackCapturePending(),
          feedbackCaptureEnabled: true,
        }),
      interrupt: lifecycle.interrupt,
      deliver: createDeliverRouting(state, services, live),
      // Consent by proceeding requires the disclosure to be on screen before the
      // first prompt activates the held telemetry instance: the landing shows it,
      // and the shell re-files it into the transcript when the landing clears.
      ...(settings.telemetryNotice !== undefined
        ? { telemetryNotice: settings.telemetryNotice }
        : {}),
      providers: state.config.providers,
      recentModels: listRecentModels(
        state.config.settings ?? { providers: {} },
      ),
      favoriteModels: listFavoriteModels(
        state.config.settings ?? { providers: {} },
      ),
      addProviderChoices: computeAddProviderChoices,
      onConnectProvider: settings.onConnectProvider,
      modelLabel: () => {
        const effort = resolveSessionEffort(
          state.config.model,
          state.config.reasoningEffort,
          isCodexProviderName(state.config.providerName),
        );
        return {
          profile: state.config.providerName,
          model: state.config.model,
          ...(effort !== undefined ? { effort } : {}),
        };
      },
      activeModel: () => ({
        provider: state.config.providerName,
        model: state.config.model,
      }),
      readCostSummary: () => commands.commandContext.getCostSummary?.(),
      showPromptCost: () => state.liveShowPromptCost,
      onModelSelect: settings.onModelSelect,
      onFavoriteToggle: settings.onFavoriteToggle,
      onSetDefault: settings.onSetDefault,
      commands: () =>
        listCommands().map((c) => ({
          name: c.name,
          description: c.description,
        })),
      onCommand: (name) => {
        const route = routeSubmission(name);
        if (route.kind === "empty") return;
        if (route.kind === "command") {
          state.dispatchCommand?.(route.name, route.args);
          return;
        }
        const [commandName = "", ...rest] = route.text.split(/\s+/);
        state.dispatchCommand?.(commandName, rest.join(" "));
      },
      chrome: () => ({
        tasks: services.directorHolder.instance?.getTasks() ?? null,
        agents: services.subAgentSessions.listForStrip().map((s) => ({
          agentId: s.agentId,
          id: s.id,
          description: s.description,
          status: s.status,
          lifecycleStatus: s.lifecycleStatus,
          currentToolName: s.currentToolName,
          currentToolPreview: s.currentToolPreview,
          currentToolStartedAt: s.currentToolStartedAt,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
          ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
          ...(s.runInFlight !== undefined
            ? { runInFlight: s.runInFlight }
            : {}),
        })),
      }),
      subscribeChrome: (notify) => {
        const unsubscribeAgents = services.subAgentSessions.subscribe(notify);
        services.emitter.on("tasks", notify);
        return () => {
          unsubscribeAgents();
          services.emitter.off("tasks", notify);
        };
      },
      subAgentSessions: () => services.subAgentSessions.list(),
      surfaces: {
        permissions: settings.surfaces.permissions,
        plugins: settings.surfaces.plugins,
        mcp: mcp.surface,
        hooks: settings.surfaces.hooks,
        settings: settings.surfaces.settings,
      },
    });
    state.host = host;
    services.hostHolder.instance = host;

    wirePostStartup(state, services, mcp.mcpConnectCallbacks);

    return await finalizeTUIRun(state, services);
  } catch (err) {
    // Terminal first: state persistence below can await disk I/O, and every
    // millisecond before this runs is a millisecond the operator is staring at
    // a frozen alternate screen. Kept outside finalizeOnCrash because that
    // short-circuits once the clean path has marked the run finalized, and a
    // throw after that point still has to give the terminal back.
    try {
      await start.crashGuard.invokeDisposeHost();
    } catch (disposeErr: unknown) {
      tuiLogger.warn("crash finalize: host dispose failed: {error}", {
        error:
          disposeErr instanceof Error ? disposeErr.message : String(disposeErr),
      });
    }
    await start.crashGuard.finalizeOnCrash(err);
    throw err;
  }
}
