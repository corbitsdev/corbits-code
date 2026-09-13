/**
 * Session assembly for the TUI runner: everything the old runTUI closure
 * built once inside its try block before the first agent build — the session
 * lifecycle (hooks sink, run sink, cycle recorder), the permission gate,
 * plugin/tool resolution, the agent toolset, the workflow host, and
 * the chat agent factory. Returns the const `RunnerServices` bag index.ts
 * threads through the other runner modules; mutable bindings live on
 * RunnerState.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  localSettingsPath,
  shellTimeoutFromSettings,
  toolWatchdogFromSettings,
} from "../../config/settings.js";
import { isCodexProviderName } from "../../config/codex-providers.js";
import {
  createGlobalSettingsWriter,
  createLocalSettingsWriter,
} from "../../mcp/add-server.js";
import { getProcessAdmissionQueue } from "../../subagent/admission.js";
import {
  createSubAgentSessionStore,
  liveFleetCount,
} from "../../subagent/index.js";
import {
  buildPluginDescriptor,
  createPluginsAdmin,
  type PluginsAdminState,
} from "../plugins-admin-backend.js";
import type { PluginDescriptor } from "../../plugins/admin.js";
import {
  createPluginLoadDiagnostics,
  emitPluginWarningLog,
} from "../../plugins/diagnostics.js";
import {
  collectWebPlugins,
  resolveWebProviderFromPlugins,
  webBrand,
} from "../../web/plugin-provider.js";
import {
  collectToolPlugins,
  resolveToolPlugins,
} from "../../plugins/tool-plugins.js";
import { resolveAgentPluginProfiles } from "../../plugins/agent-plugins.js";
import { loadAgentProfiles } from "../../agent/profiles.js";
import { createPermissionsAdmin } from "../../permission/admin.js";
import { setActiveWebProviderBrand } from "../tool-formatter.js";
import {
  assembleChatAgent,
  assembleSessionGate,
  assembleSessionLifecycle,
  createAdvertisedToolset,
  loadSessionLocalSettings,
  resolveLiveSessionSources,
  type LiveSessionSources,
} from "../../session/assemble-runtime.js";
import type { CompactionArchive } from "../../session/compaction-archive.js";
import { createApprovalResume } from "../../session/approval-resume.js";
import { createReactorAuthorize } from "../../permission/reactor-authorize.js";
import {
  buildCompactionContinuationMessage,
  buildShellBackgroundMessage,
  createLiveSubAgentSources,
  createSessionPruningCompactor,
  loadSessionChatPrompt,
  skillDirsFromEnabledPlugins,
} from "../../session/runtime-assembly.js";
import {
  createModelSummarizer,
  type SummaryContext,
} from "../../session/summarizer.js";
import { ensureFreshInferenceSource } from "../../subagent/refresh-inference-source.js";
import { setAgentSourceUnlessClosed } from "../agent-source-sync.js";
import { createSessionCostAccumulator } from "../../cost/session-cost.js";
import { createSessionOperationQueue } from "../session-operation-queue.js";
import { createDeliveryGeneration } from "../queued-delivery.js";
import { createCorrelationAcceptance } from "../correlation-acceptance.js";
import {
  createAgentToolset,
  type MCPServerState,
  type OperatorResult,
} from "../../agent/tools.js";
import type { ToolAvailability } from "../../agent/tool-search.js";
import { detectLanguageServerAvailable } from "../../agent/lsp-availability.js";
import type { SessionMode } from "../../config/session-mode.js";
import { WorkflowHost, type WorkflowHostState } from "../../workflows/host.js";
import type { ToolWatchdogConfig } from "../tool-execution-watchdog.js";
import {
  deliverAgentMessage,
  deliveryResultNotice,
  type AgentDeliveryResult,
} from "../deliver-agent-message.js";
import { createProviderFailureAttemptTracker } from "../provider/failure-attempt.js";
import { getTelemetry, liveTelemetry } from "../../telemetry/singleton.js";
import {
  createChatDirector,
  submitOutputDefinition,
} from "../../agent/director.js";
import {
  shellDefinition,
  updatePlanDefinition,
} from "../../agent/codex-tool-proxies.js";
import { attachApprovalBudget } from "../request-approval.js";
import { createGateRequestApproval } from "../request-approval.js";
import { getActivePricingCache } from "../../cost/cost-visibility.js";
import type { OperatorGateEvent } from "../gate-events.js";
import { sessionDir } from "../../session/index.js";
import { ID_PREFIX } from "../../branding.js";
import {
  liveAgent,
  type RunnerHost,
  type RunnerServices,
  type RunnerState,
  type TUIStart,
} from "./state.js";

export async function assembleTUISession(
  state: RunnerState,
  start: TUIStart,
  pluginState: PluginsAdminState,
): Promise<RunnerServices> {
  const config = state.config;
  const emitter = new EventEmitter();
  const globalSettingsWriter = createGlobalSettingsWriter(
    config.globalSettingsPath,
  );
  const localSettingsWriter = createLocalSettingsWriter(
    localSettingsPath(config.cwd),
  );
  const initialHookEnabled: Record<string, boolean> = Object.fromEntries(
    Object.entries(config.settings?.hooks ?? {}).map(([id, v]) => [
      id,
      v.enabled,
    ]),
  );
  const { hookManager, runSink, cycleRecorder } =
    await assembleSessionLifecycle({
      cwd: config.cwd,
      emitter,
      getTelemetry,
      getSessionId: () => state.sessionId,
      // The lifecycle starts consuming events well after the exit module wires
      // persistRunSnapshot onto the state this closure reads it from.
      getSource: () => state.liveSource,
      initialTurnCount: start.resumeSeed.turnsUsed,
      onTurnBoundarySnapshot: () => {
        void state.persistRunSnapshot?.("running");
      },
      hookEnabled: initialHookEnabled,
      onHookEvent: (event) => emitter.emit("hook", event),
      resolveContextDir: () => state.workdir,
    });

  // Shared by the permission gate and every operator-gate emission site: an
  // unattended auto-continue run must not park on any gate forever, whichever
  // kind it is. No caller arms this today — the goal subsystem was the only
  // source of an auto-deny/auto-cancel deadline and has been removed. The
  // timeout plumbing (gate-events.ts / request-approval.ts, and every
  // OperatorGateEvent/PermissionGateEvent emission site below) stays for a
  // future generalized auto-continue mechanism to re-arm by giving this a
  // real body again.
  const approvalTimeout = ():
    | { timeoutMs: number; timeoutMessage: string }
    | undefined => undefined;

  const correlationAcceptance = createCorrelationAcceptance();
  const parkedApprovalCancel = { fn: undefined as (() => void) | undefined };
  const deliveryGeneration = createDeliveryGeneration(() => {
    parkedApprovalCancel.fn?.();
    correlationAcceptance.settleAll();
  });

  const { gate: permissionGate } = await assembleSessionGate({
    cwd: config.cwd,
    sessionId: state.sessionId,
    providerName: config.providerName,
    model: config.model,
    telemetry: liveTelemetry,
    requestApproval: createGateRequestApproval({
      emitGate: (event) => emitter.emit("permission.gate", event),
      approvalTimeout,
      identitySignal: () => deliveryGeneration.signal(),
    }),
    getActiveProviderModel: () =>
      `${state.config.providerName}:${state.config.model}`,
    onPersistNotice: (text) => state.approvalPersistNotice.notify?.(text),
    onPendingProjectGrants: (text) =>
      state.approvalPersistNotice.notify?.(text),
    interactive: true,
    skipPermissions: config.dangerouslySkipPermissions,
    auto: config.auto,
    // Main session: gating rides the reactor's approval-suspend seam.
    reactorGated: true,
    onGrant: (approval, covers) =>
      emitter.emit("permission.grant", { approval, covers }),
  });

  const permissionsAdmin = createPermissionsAdmin(permissionGate, config.cwd);

  // Track the active subagent provider so a live /agent switch (provider, model,
  // or reasoning effort) reaches subagents spawned afterward. Derives from the
  // live config binding on every spawn, so every switch path that reassigns
  // config (model picker, /agent, post-connect refresh) is picked up without
  // a separate cache to keep in sync.
  const liveSubAgent = createLiveSubAgentSources(() => state.config);

  // Dedicated child-session records for enter-session inspection. Child events
  // land here only — never in the parent chat transcript.
  const subAgentSessions = createSubAgentSessionStore({
    admission: getProcessAdmissionQueue(),
  });

  const executablePlugins = () =>
    pluginState.modules.filter((m) => m.metadataOnly !== true);
  pluginState.webCandidates = collectWebPlugins(executablePlugins());
  // Tool plugins are wired in only when enabled AND consented.
  pluginState.toolCandidates = collectToolPlugins(executablePlugins());
  // Web and tool plugin resolution are independent, so resolve them concurrently.
  const toolPluginDiag = createPluginLoadDiagnostics();
  const [activeWeb, extraToolPlugins] = await Promise.all([
    resolveWebProviderFromPlugins({
      candidates: pluginState.webCandidates,
      pluginConfig: config.settings?.plugins ?? {},
      webOverride: config.settings?.web,
    }),
    resolveToolPlugins({
      candidates: pluginState.toolCandidates,
      pluginConfig: config.settings?.plugins ?? {},
      diagnostics: toolPluginDiag,
    }),
  ]);
  if (activeWeb !== undefined)
    setActiveWebProviderBrand(webBrand(activeWeb.name));
  emitPluginWarningLog(toolPluginDiag);
  state.standingPluginWarnings.push(...toolPluginDiag.warnings);

  // Descriptors mirror the mutable module list so plugins added by path
  // mid-session appear without a restart.
  pluginState.descriptors = pluginState.modules
    .map((m) => buildPluginDescriptor(m))
    .filter((d): d is PluginDescriptor => d !== undefined);
  // Attach agent profiles to their descriptors so the /plugins UI can show
  // which sub-agents a plugin contributes.
  for (const mod of pluginState.modules) {
    const manifest = mod.manifest;
    if (manifest?.kind !== "agent" || mod.agentPlugin === undefined) continue;
    const desc = pluginState.descriptors.find((d) => d.id === manifest.id);
    if (desc === undefined) continue;
    const agents = Array.isArray(mod.agentPlugin.agents)
      ? mod.agentPlugin.agents
      : [];
    desc.agentProfiles = agents
      .filter(
        (a): a is Record<string, unknown> =>
          typeof a === "object" && a !== null && "id" in a,
      )
      .map((a) => ({
        id: String(a["id"]),
        ...(typeof a["description"] === "string"
          ? { description: a["description"] }
          : {}),
      }));
  }
  const notePluginWarnings = (warnings: readonly string[]): void => {
    if (warnings.length === 0) return;
    state.standingPluginWarnings.push(...warnings);
    state.paintPluginAttention?.(state.standingPluginWarnings.length > 0);
  };
  const pluginsAdmin = createPluginsAdmin({
    state: pluginState,
    globalSettingsPath: config.globalSettingsPath,
    globalSettingsWriter,
    noteWarnings: notePluginWarnings,
  });
  const profilesDir = join(config.cwd, ".agents", "agents");
  const profileDiag = createPluginLoadDiagnostics();
  const pluginAgentProfiles = await resolveAgentPluginProfiles(
    executablePlugins(),
    config.settings?.plugins ?? {},
    { diagnostics: profileDiag },
  );
  emitPluginWarningLog(profileDiag);
  state.standingPluginWarnings.push(...profileDiag.warnings);
  const liveAgentProfiles = await loadAgentProfiles(
    profilesDir,
    pluginAgentProfiles,
  );

  // Skill directories from enabled plugins, in addition to project-local
  // `.agents`/`.claude`/`.codex/skills` that discoverSkills/resolveSkillBody check.
  const skillDirs = skillDirsFromEnabledPlugins(
    executablePlugins(),
    pluginState.pluginConfig,
  );

  const shellTimeout = shellTimeoutFromSettings(config.settings);
  // Mutable so Settings → waitForApproval takes effect on the next tool call
  // without rebuilding the toolset.
  const liveToolWatchdog: ToolWatchdogConfig = {
    ...(toolWatchdogFromSettings(config.settings) ?? {}),
  };
  // CL-5814: orchestrator is the only product path — no first-run mode picker.
  const liveSessionMode: SessionMode = "orchestrator";
  // Local settings still supply shell env; sessionMode is ignored if present.
  const localSettingsForEnv = await loadSessionLocalSettings({
    cwd: config.cwd,
    globalSettingsPath: config.globalSettingsPath,
  });
  const toolAvailability: ToolAvailability = {
    languageServerAvailable: detectLanguageServerAvailable(config.cwd),
    operatorAvailable: true,
    // TUI primary does not mount wait_agents — mailbox mail is the collect path.
    waitAgentsMounted: false,
  };
  // The workflow host is built below, after the toolset; the holder lets
  // submit_output's handler complete the live workflow without a
  // construction-order cycle.
  const workflowHostHolder: { instance?: WorkflowHost } = {};
  const evidenceArchiveHolder: { current?: CompactionArchive } = {};

  const toolset = await createAgentToolset({
    cwd: config.cwd,
    permissionGate,
    skillDirs,
    telemetry: liveTelemetry,
    isCodex: isCodexProviderName(config.providerName),
    ...(shellTimeout !== undefined ? { shellTimeout } : {}),
    ...(localSettingsForEnv?.env !== undefined
      ? { shellEnv: localSettingsForEnv.env }
      : {}),
    ...(localSettingsForEnv?.pinnedTools !== undefined
      ? { pinnedTools: localSettingsForEnv.pinnedTools }
      : {}),
    toolWatchdog: liveToolWatchdog,
    getBlobReader: () => liveAgent(state).blobReader,
    getBlobWriter: () => state.currentStorage?.writeBlob,
    getContextDir: () => state.workdir,
    // A background run_shell completion re-enters the reactor on a later turn,
    // so queued steers are not blocked by a long foreground run.
    onBackgroundShellExit: (exit) => {
      const targetAgent = liveAgent(state);
      state.enqueueAgentDeliver?.(() =>
        targetAgent.deliver(buildShellBackgroundMessage(exit)),
      );
    },
    getEvidenceArchive: () => evidenceArchiveHolder.current,
    isWorkflowActive: () => workflowHostHolder.instance?.isActive() === true,
    completeWorkflowStep: (stepId) =>
      workflowHostHolder.instance?.complete(stepId) ?? "not-current",
    ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
    onOperatorGate: (question, options) =>
      new Promise<OperatorResult>((resolve) => {
        const { finish, signal } = attachApprovalBudget<OperatorResult>(
          resolve,
          {
            tool: "ask_operator",
            kind: "operator",
          },
        );
        const timeout = approvalTimeout();
        const event: OperatorGateEvent = {
          id: randomUUID(),
          question,
          options,
          resolve: finish,
          ...(timeout !== undefined ? timeout : {}),
          ...(signal !== undefined ? { signal } : {}),
        };
        emitter.emit("operator.gate", event);
      }),
    sessionMode: liveSessionMode,
    toolAvailability,
    ...(config.mcpServers !== undefined
      ? { mcpServers: config.mcpServers }
      : {}),
    mcpServersSource: config.mcpServersSource ?? "none",
    projectTrust: pluginState.projectTrust,
    requestMcpTrust: async (server) => {
      // TOFU via operator gate: Trust this local MCP server?
      const result = await new Promise<OperatorResult>((resolve) => {
        const { finish, signal } = attachApprovalBudget<OperatorResult>(
          resolve,
          {
            tool: `mcp:${server.name}`,
            kind: "operator",
          },
        );
        const timeout = approvalTimeout();
        const event: OperatorGateEvent = {
          id: randomUUID(),
          question:
            `Trust local MCP server "${server.name}" for this project?` +
            (server.command !== undefined
              ? `\nCommand: ${server.command}${(server.args ?? []).length > 0 ? ` ${(server.args ?? []).join(" ")}` : ""}`
              : server.url !== undefined
                ? `\nURL: ${server.url}`
                : ""),
          options: ["Trust and connect", "Deny"],
          resolve: finish,
          ...(timeout !== undefined ? timeout : {}),
          ...(signal !== undefined ? { signal } : {}),
        };
        emitter.emit("operator.gate", event);
      });
      return result.kind === "option" && result.index === 0;
    },
    subAgent: {
      provider: liveSubAgent.provider,
      sessions: subAgentSessions,
      getWorkdirBase: () => sessionDir(state.config.cwd, state.sessionId),
      // Progress only — not the full event stream. Forwarding every sub-agent
      // inference.delta into the parent transcript interleaves worker text with
      // the parent turn; progress keeps the status bar alive and the Agents
      // strip current without that pollution.
      onProgress: (info) => {
        emitter.emit("subagent.progress", info);
      },
      settings: liveSubAgent.settings,
      catalog: liveSubAgent.catalog,
      profiles: () => liveAgentProfiles,
    },
  });

  const { systemPrompt } = await loadSessionChatPrompt({
    cwd: config.cwd,
    skillDirs,
    ...(config.systemPromptExtensions !== undefined
      ? { systemPromptExtensions: config.systemPromptExtensions }
      : {}),
    ...(config.promptSectionOmit !== undefined
      ? { promptSectionOmit: config.promptSectionOmit }
      : {}),
    sessionMode: liveSessionMode,
    toolAvailability,
    skills: toolset.skills,
  });

  const directorHolder: { instance?: ReturnType<typeof createChatDirector> } =
    {};
  const hostHolder: { instance?: RunnerHost } = {};

  // Owns the workflow lifecycle: slash-command starts, capability overrides,
  // resume, and publishing status via the emitter. The TUI only renders.
  const workflowHost = new WorkflowHost({
    cwd: config.cwd,
    getSessionId: () => state.sessionId,
    getToolDefinitions: () => toolset.dynamicRunner.currentDefinitions(),
    getDirector: () => directorHolder.instance,
    onChange: () => {
      emitter.emit("workflow", {
        current: workflowHost.status(),
        history: workflowHost.history(),
      } satisfies WorkflowHostState);
    },
  });
  workflowHostHolder.instance = workflowHost;

  // Dynamic tool discovery: only the fixed built-in prefix plus activated
  // tools reach the wire, so the provider cache prefix holds steady; MCP
  // tools must be promoted here before the model can invoke them.
  const {
    activated: activatedToolNames,
    computeAdvertised,
    isAdvertised,
  } = createAdvertisedToolset({
    sessionMode: liveSessionMode,
    toolAvailability,
    getProvider: () => state.config,
    ...(localSettingsForEnv?.pinnedTools !== undefined
      ? { pinnedTools: localSettingsForEnv.pinnedTools }
      : {}),
  });
  // Re-activate the prior run's promoted tools before the first build so the
  // post-resume wire matches the transcript the model still sees.
  activatedToolNames.activate(start.resumeSeed.activatedTools);
  // A registered tool the wire never advertised must error toward tool_search
  // instead of dispatching blind — the transcript would otherwise claim a call
  // the next infer does not declare. submit_output rides every infer via the
  // director, and Codex's native proxies answer calls Codex models emit
  // unaided; neither flows through the advertised set.
  const unadvertisedCallable = new Set<string>([
    submitOutputDefinition.name,
    ...(isCodexProviderName(config.providerName)
      ? [shellDefinition.name, updatePlanDefinition.name]
      : []),
  ]);
  toolset.dynamicRunner.setCallGate(
    (name) => unadvertisedCallable.has(name) || isAdvertised(name),
  );

  // Reload, interrupt, compaction continuation, and proxy deliver share one queue
  // so a rebuild never races an in-flight deliver.
  const sessionOps = createSessionOperationQueue();
  const approvalResume = createApprovalResume({
    getAgent: () => state.currentAgent,
    captureGeneration: deliveryGeneration.capture,
    onDropped: (text) => state.systemNotice?.(text),
    registerParkedCancel: (cancel) => {
      parkedApprovalCancel.fn = cancel;
    },
    deliver: (message, stillCurrent) => {
      return sessionOps.enqueue(async () => {
        if (!stillCurrent()) return;
        if (state.fatalBuildError !== null) throw state.fatalBuildError;
        const correlationId = message.headers.interchangeCorrelationId;
        const accepted =
          correlationId === undefined
            ? undefined
            : correlationAcceptance.wait(correlationId);
        try {
          liveAgent(state).deliver(message);
          await accepted;
        } catch (err) {
          if (correlationId !== undefined)
            correlationAcceptance.settle(correlationId);
          throw err;
        }
      });
    },
    gate: permissionGate,
  });
  state.enqueueAgentDeliver = (
    deliverToLiveAgent: () => void,
    onSettle?: (result: AgentDeliveryResult) => void,
  ): void => {
    const stillCurrent = deliveryGeneration.capture();
    void sessionOps.enqueue(async () => {
      if (!stillCurrent()) {
        onSettle?.({
          status: "not-delivered",
          reason: "superseded",
          detail: "session identity changed before delivery",
        });
        return;
      }
      // The shell already popped the queue item and painted it as delivered
      // by the time this runs, so a failed rebuild or closed agent must settle
      // here — otherwise the message silently never reaches the agent.
      const result = await deliverAgentMessage({
        getFatalBuildError: () => state.fatalBuildError,
        deliverToLiveAgent,
      });
      if (onSettle !== undefined) {
        onSettle(result);
        return;
      }
      if (result.status === "accepted") return;
      state.systemNotice?.(deliveryResultNotice(result));
    });
  };

  const buildSessionSources = (): LiveSessionSources =>
    resolveLiveSessionSources(state.config, state.sessionId);

  // Compaction summarizer: structured handoff via the live model. Failure
  // keeps prior context rather than substituting a stats stub. Workflow state
  // is read at compaction time so a pass mid-/build or mid-/plan still names
  // the active step. The archive, when mounted, supplies the unclipped excerpt.
  const compactionSummarize = createModelSummarizer({
    getSource: () => state.liveSource,
    deps: start.inferenceDeps,
    getArchive: () => evidenceArchiveHolder.current,
    timeoutMs: config.summarizerTimeoutMs,
    telemetry: liveTelemetry,
    // A 401 here usually means the shared OAuth file rotated under another
    // process; re-read it so the retry runs on the fresh token, and keep the
    // live source in step so the summarizer picks it up.
    refreshAuth: async () => {
      const fresh = await ensureFreshInferenceSource(
        state.liveSource,
        state.config.providers,
      );
      if (fresh.apiKey === state.liveSource.apiKey) return;
      state.liveSource = fresh;
      if (state.currentAgent !== undefined)
        setAgentSourceUnlessClosed(state.currentAgent, fresh);
    },
    onFailure: (text) => state.systemNotice?.(text),
  });
  const summaryContext = (): SummaryContext | undefined => {
    const status = workflowHost.status();
    const activatedTools = activatedToolNames.list();
    if (!status.active && activatedTools.length === 0) return undefined;
    return {
      ...(status.active
        ? {
            workflow: {
              ...(status.name !== undefined ? { name: status.name } : {}),
              stepLabel: status.label,
              stepIndex: status.stepIndex,
              total: status.total,
            },
          }
        : {}),
      ...(activatedTools.length > 0 ? { activatedTools } : {}),
    };
  };

  const chatAgent = assembleChatAgent({
    toolsId: `${ID_PREFIX}/tui-tools`,
    agentId: `${ID_PREFIX}/tui-agent`,
    systemPrompt,
    getDynamicRunner: () => toolset.dynamicRunner,
    computeAdvertised,
    activateTools: (names) => activatedToolNames.activate(names),
    inactivityTimeoutMs: config.inactivityTimeoutMs ?? 750_000,
    totalTimeoutMs: config.totalTimeoutMs,
    onTasksChange: (tasks) => emitter.emit("tasks", tasks),
    getLiveFleetCount: () => liveFleetCount(subAgentSessions.list()),
    requestContinuation: () => {
      const targetAgent = liveAgent(state);
      state.enqueueAgentDeliver?.(() =>
        targetAgent.deliver(buildCompactionContinuationMessage()),
      );
    },
    getProvider: () => state.config,
    // Live id so mid-session `/model` updates xAI bare-429 remapping
    // without rebuilding the agent (aligned with transcript stamp).
    getProviderId: () => state.config.providerName,
    directorHolder,
    onToolsPromoted: () => {
      state.pendingReload = true;
      state.reloadIfIdle?.();
    },
    getWorkdir: () => state.workdir,
    getSessionId: () => state.sessionId,
    authorize: createReactorAuthorize(permissionGate),
    inferenceDeps: start.inferenceDeps,
    getSources: () =>
      state.liveSources.length > 0 ? state.liveSources : [state.liveSource],
    getDefaultSource: () =>
      state.liveDefaultSource.length > 0
        ? state.liveDefaultSource
        : state.liveSource.id,
    getCompactor: () =>
      createSessionPruningCompactor({
        summarize: compactionSummarize,
        summaryContext,
        telemetry: liveTelemetry,
        // Main-session folds only — exec runner and subagents stay silent.
        onFolded: (info) => emitter.emit("compaction", info),
      }),
    onBuilt: (agent, storage) => {
      state.currentAgent = agent;
      state.currentStorage = storage;
    },
    evidenceArchiveHolder,
  });

  const sessionCost = createSessionCostAccumulator({
    pricingCache: getActivePricingCache,
  });

  // Every configured server's latest state, for the /mcp surface. Unlike
  // connectedMcpServers (persisted run metadata) this keeps the ones that
  // failed or are still waiting on authorization.
  const mcpStates = new Map<string, MCPServerState>();
  const mcpConnectController = new AbortController();

  // Cycles persist to the context store only on inference.done; the assembled
  // recorder keeps the in-flight cycle's text so an errored or interrupted
  // turn leaves its partial output in partial.jsonl instead of vanishing.
  const providerFailureAttempts = createProviderFailureAttemptTracker();
  // Tool count before any MCP server connects; a reload is only worthwhile if
  // connecting actually added tools.
  const baseToolCount = toolset.dynamicRunner.currentDefinitions().length;

  return {
    emitter,
    globalSettingsWriter,
    localSettingsWriter,
    hookManager,
    runSink,
    cycleRecorder,
    crashGuard: start.crashGuard,
    activeRunHandle: start.activeRunHandle,
    inferenceDeps: start.inferenceDeps,
    permissionGate,
    approvalResume,
    permissionsAdmin,
    liveSubAgent,
    subAgentSessions,
    pluginState,
    executablePlugins,
    pluginsAdmin,
    skillDirs,
    liveToolWatchdog,
    liveSessionMode,
    toolAvailability,
    toolset,
    systemPrompt,
    directorHolder,
    hostHolder,
    workflowHost,
    activatedToolNames,
    computeAdvertised,
    buildAgent: chatAgent.buildAgent,
    sessionCost,
    sessionOps,
    deliveryGeneration,
    correlationAcceptance,
    buildSessionSources,
    providerFailureAttempts,
    baseToolCount,
    mcpStates,
    mcpConnectController,
  };
}
