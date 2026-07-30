import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { EventEmitter } from "node:events";
import { render } from "ink";
import {
  createAgent,
  defineAgent,
  defineTool,
  createDirectorRegistry,
  defineDirector,
  type Agent,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import { getLogger } from "@intx/log";
import { createOptimizedContextStore, loadRecentTurns } from "../session/optimized-context-store.js";
import { type } from "arktype";
import { buildCodexSource, buildOpenAISource, buildXaiSource, type Config } from "../config/index.js";
import {
  globalSettingsPath,
  loadLocalSettings,
  loadGlobalSettingsWriteBase,
  loadSettings,
  localSettingsPath,
  markTelemetryNoticeShown,
  resolveMaxConcurrentSubAgents,
  resolveTier,
  saveGlobalSettings,
  saveLocalSettings,
  shellTimeoutFromSettings,
  toolWatchdogFromSettings,
  type Settings,
  type LocalSettings,
  type PluginConfig,
  type ProviderTier,
} from "../config/settings.js";
import { resolveWaitForApproval, type ToolWatchdogConfig } from "./tool-execution-watchdog.js";
import { createGateRequestApproval } from "./request-approval.js";
import { configureSubAgentConcurrency } from "../subagent/concurrency.js";
import { codexProfileFromProviderName } from "../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../config/xai-providers.js";
import type { PluginsAdmin, PluginDescriptor } from "./components/plugins-manager.js";
import type { PluginManifest } from "../plugins/manifest.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import { getValidCodexToken } from "../auth/codex/session.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import { refreshCodexInstructions } from "../auth/codex/instructions.js";
import { discoverRepoPlugins, discoverUserPlugins, discoverClaudeInstalledPlugins, expandExistingPluginMembers, expandPluginPath, loadPluginEntry, loadPluginsFromPaths, dedupePluginModules, type PluginOrigin } from "../plugins/loader.js";
import {
  isPluginTrusted,
  loadProjectTrust,
  trustPlugin,
  type ProjectTrustStore,
} from "../trust/project-trust.js";
import {
  isPathPluginTrusted,
  migratePathTrustFromPluginPaths,
  reportPathTrustMigration,
  revokePathPlugin,
  trustPathPlugin,
  trustPathPlugins,
  type PathTrustStore,
} from "../trust/path-trust.js";
import { registerCommandPlugins, registerWorkflowPlugins, isEnabledCommandPlugin, enablePluginConfig } from "../plugins/register.js";
import { discoverSkills } from "../extensions/skills.js";
import { registerCommandPlugin, setHiddenCommands } from "./commands/registry.js";
import { activateHeldTelemetry, telemetryFirstRunPending } from "../telemetry/first-run.js";
import { TELEMETRY_NOTICE } from "../telemetry/index.js";
import { getTelemetry, setTelemetry } from "../telemetry/singleton.js";
import { createTelemetryToggleHandler } from "../telemetry/toggle.js";
import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import {
  advertisedToolNamesForSessionMode,
  advertisedTools,
  createActivatedToolTracker,
} from "../agent/tool-search.js";
import { resolveSessionMode, type SessionMode } from "../config/session-mode.js";
import { promptSessionModeIfUnset } from "./session-mode-prompt.js";
import { createSubAgentSessionStore, type SubAgentProvider } from "../subagent/index.js";
import type { InferenceSource, ToolDefinition, InboundMessage } from "@intx/types/runtime";
import { createSessionOperationQueue } from "./session-operation-queue.js";
import { setAgentSourceUnlessClosed } from "./agent-source-sync.js";
import { createChatDirector } from "../agent/director.js";
import { createGoalGovernor } from "../agent/goal.js";
import { createGoalEvaluator } from "../agent/goal-evaluator.js";
import { loadGoalState, saveGoalState } from "../session/goal-state.js";
import { buildChatSystemPrompt } from "../agent/prompts.js";
import { gatherEnvironment } from "../agent/environment.js";
import { loadAgentContextExtensions, loadSystemPromptOverrides } from "../agent/context-extensions.js";
import { buildMainSessionSources, buildInferenceSourceForRef, tierProviderRefs } from "../config/inference-sources.js";
import { loadAgentProfiles, type AgentProfile } from "../agent/profiles.js";
import { resolveAgentPluginProfiles } from "../plugins/agent-plugins.js";
import { createPermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktrees.js";
import { createPermissionsAdmin } from "../permission/admin.js";
import {
  DEFAULT_GOAL_APPROVAL_TIMEOUT_MS,
  goalApprovalTimeoutMessage,
  isGoalApprovalTimeoutActive,
} from "../permission/goal-approval-timeout.js";

import { createAgentToolset, type OperatorResult } from "../agent/tools.js";
import { collectWebPlugins, resolveWebProviderFromPlugins, webBrand } from "../web/plugin-provider.js";
import { collectToolPlugins, resolveToolPlugins } from "../plugins/tool-plugins.js";
import { scrubSecrets } from "../web/secret-scrub.js";
import { setActiveWebProviderBrand } from "./tool-formatter.js";
import {
  loadApprovals,
  loadProjectApprovals,
  loadGlobalApprovals,
  loadProviderModelApprovals,
  saveProjectApproval,
  saveGlobalApproval,
  saveProviderModelApproval,
} from "../permission/store.js";
import type { Approval, GrantScope } from "../permission/types.js";
import { consumeStream } from "../session/stream-consumer.js";
import { enterAltScreen } from "../util/alt-screen.js";
import { createFilteredStdin, enableMouseReporting } from "./stdin-filter.js";
import { App } from "./app.js";
import type { OperatorGateEvent } from "./hooks/use-gates.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
  type RunSummary,
} from "../session/hooks.js";
import { createRunSink } from "../session/run-sink.js";
import { generateSessionId, initSessionDir, renameSession, sessionContextDir, sessionDir } from "../session/index.js";
import { resolveSessionLabel, truncateSessionLabel } from "../session/session-label.js";
import { loadState, saveState, type ConnectedMcpServer, type RunState } from "../session/state.js";
import { pickSession } from "./pick-session.js";
import { RESUME_TRANSCRIPT_BLOCK_LIMIT, turnsToContentBlocks } from "./turns-to-blocks.js";
import { WorkflowController } from "./workflow-controller.js";
import { createPruningCompactor } from "../session/compactor.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { ID_PREFIX, LOG_NAMESPACE_ROOT } from "../branding.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export { getTUIRunSummaryStatus } from "../session/run-sink.js";

export type ResolveExitCodeArgs = {
  runError: string | undefined;
  sinkError: string | undefined;
  status: RunSummary["status"];
};

export function resolveExitCode(args: ResolveExitCodeArgs): number {
  const { runError, sinkError, status } = args;
  if (runError !== undefined || sinkError !== undefined || status !== "done") {
    return 1;
  }
  return 0;
}

function buildCompactionContinuationMessage(): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `compact-continue-${Date.now()}@local`,
    },
    flags: [],
    content: "",
    signatureStatus: "missing",
  };
}

export async function runTUI(initialConfig: Config): Promise<number> {
  let config = initialConfig;
  const inferenceDeps = await createInferenceDependencies();

  // Auto-discover plugins from the repo's plugins/ directory and user plugin
  // dirs, plus any explicit paths registered through the /plugins UI.
  // Project origins without a project-trust entry, and path origins without a
  // global path-trust entry, load metadata-only (no import).
  // Claude Code marketplace installs are opt-in via settings.discoverClaudePlugins.
  let projectTrust: ProjectTrustStore = await loadProjectTrust(config.cwd);
  // One-shot: seed global path trust from pluginPaths only when the store file
  // does not exist yet (legacy per-cwd grants). Later boots load the store as-is.
  let pathTrust: PathTrustStore = await migratePathTrustFromPluginPaths(
    config.settings?.pluginPaths ?? [],
    (p) => expandExistingPluginMembers(p, config.cwd),
    undefined,
    { onMigrated: reportPathTrustMigration },
  );
  const isProjectPluginTrusted = (pluginPath: string) => isPluginTrusted(projectTrust, pluginPath);
  const isRegisteredPathTrusted = (pluginPath: string) => isPathPluginTrusted(pathTrust, pluginPath);
  const claudePlugins =
    config.settings?.discoverClaudePlugins === true
      ? await discoverClaudeInstalledPlugins(config.cwd)
      : [];
  const pluginModules = dedupePluginModules([
    ...(await discoverRepoPlugins(config.cwd)),
    ...(await discoverUserPlugins(config.cwd, { isPluginTrusted: isProjectPluginTrusted })),
    ...claudePlugins,
    ...(await loadPluginsFromPaths(config.settings?.pluginPaths ?? [], config.cwd, {
      isPluginTrusted: isRegisteredPathTrusted,
    })),
  ]);
  // Mutable list so trusting a project/path plugin can replace a metadata-only stub
  // with a fully loaded module without restarting the process.
  let livePluginModules = pluginModules;
  const executablePlugins = () => livePluginModules.filter((m) => m.metadataOnly !== true);
  // Command plugins are wired in only when explicitly enabled in settings.
  const pluginConfig = config.settings?.plugins ?? {};
  registerWorkflowPlugins(executablePlugins(), pluginConfig);
  registerCommandPlugins(executablePlugins(), pluginConfig);
  setHiddenCommands(config.settings?.hiddenCommands ?? []);
  // loadConfig already bootstrapped pricing metadata; re-read cache here so a
  // TUI-only entry (tests) still picks up the tool-home cache path.
  await seedPricingMetadataFromCache({
    cachePath: defaultPricingCachePath(),
  });
  let sessionId = config.sessionId;
  let resumeSkipInitialTask = config.skipInitialTask === true;
  let startedAt = Date.now();
  let runTaskTitle = config.task;

  if (config.resumePicker) {
    const picked = await pickSession(config.cwd, { includeCompleted: config.force });
    if (picked === null) return 0;
    sessionId = picked.sessionId;
    resumeSkipInitialTask = true;
    const pickedState = await loadState(config.cwd, sessionId);
    if (pickedState !== null) {
      startedAt = pickedState.startedAt;
      runTaskTitle = pickedState.task;
    } else {
      runTaskTitle = picked.task.length > 0 ? picked.task : runTaskTitle;
    }
    config =
      pickedState !== null
        ? { ...config, sessionId, task: pickedState.task }
        : { ...config, sessionId, task: runTaskTitle };
  }

  let workdir = sessionContextDir(config.cwd, sessionId);
  await initSessionDir(config.cwd, sessionId);

  // A session can still crash during the setup below, before the reactor ever
  // starts (buildAgent, plugin discovery, MCP wiring, etc. all run first). Write
  // a minimal readable record now so a session that dies before its first turn
  // still carries model identity instead of leaving `.agent-state/<id>/` with no
  // run.json at all.
  await saveState(config.cwd, sessionId, {
    status: "running",
    turnsUsed: 0,
    task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    model: `${config.providerName}:${config.model}`,
    mcpServers: [],
  });

  // Crash guard: if anything from setup onward throws all the way out of
  // runTUI instead of reaching the normal finalize block, this still closes
  // out run.json so status and finishedAt never disagree. Declared before the
  // try so every fallible step after the minimal write above is covered.
  // `finalized` is set by the normal finalize path so this never double-writes
  // on a clean exit; it also gates straggler snapshot writes (see
  // persistRunSnapshot) from resurrecting a closed record.
  let finalized = false;
  const finalizeOnCrash = async (err: unknown): Promise<void> => {
    if (finalized) return;
    finalized = true;
    const message = err instanceof Error ? err.message : String(err);
    await saveState(config.cwd, sessionId, {
      status: "failed",
      turnsUsed: 0,
      task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
      startedAt,
      finishedAt: Date.now(),
      error: message,
      model: `${config.providerName}:${config.model}`,
      mcpServers: [],
    }).catch(() => undefined);
  };

  try {
  const emitter = createTUIEventEmitter();
  const hookManager = createLifecycleHookManager({
    hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
    onEvent: (event) => emitter.emit("hook", event),
  });
  let runError: string | undefined;

  const recordRunError = (err: unknown): void => {
    runError = err instanceof Error ? err.message : String(err);
  };

  const activeProviderModel = `${config.providerName}:${config.model}`;
  const sessionApprovals = await loadApprovals(config.cwd, sessionId);
  const [projectApprovals, globalApprovals, providerModelApprovals] = await Promise.all([
    loadProjectApprovals(config.cwd),
    loadGlobalApprovals(),
    loadProviderModelApprovals(),
  ]);
  // Goal governor is created after liveSource (evaluator closure); the gate
  // holds a ref so requestApproval can arm a timeout once a goal is active.
  const goalGovernorRef: { current: ReturnType<typeof createGoalGovernor> | null } = {
    current: null,
  };

  const seededApprovals: Approval[] = [
    ...sessionApprovals,
    ...projectApprovals,
    ...globalApprovals,
    ...providerModelApprovals,
  ];
  const permissionGate = createPermissionGate({
    approvals: seededApprovals,
    cwd: config.cwd,
    rootsProvider: createWorktreeRootsProvider(config.cwd),
    providerName: config.providerName,
    model: config.model,
    requestApproval: createGateRequestApproval({
      emitGate: (event) => emitter.emit("permission.gate", event),
      goalTimeout: () => {
        const snap = goalGovernorRef.current?.get() ?? null;
        return isGoalApprovalTimeoutActive(snap?.status)
          ? {
              timeoutMs: DEFAULT_GOAL_APPROVAL_TIMEOUT_MS,
              timeoutMessage: goalApprovalTimeoutMessage(DEFAULT_GOAL_APPROVAL_TIMEOUT_MS),
            }
          : undefined;
      },
    }),
    persist: (approval: Approval, scope: GrantScope) => {
      // Route each persisted grant to the store its scope selects. Session
      // grants never reach here — the gate keeps those in memory only.
      if (scope === "project") {
        void saveProjectApproval(config.cwd, approval);
      } else if (scope === "global") {
        void saveGlobalApproval(approval);
      } else if (scope === "provider-model") {
        void saveProviderModelApproval(activeProviderModel, approval);
      }
    },
    interactive: true,
    skipPermissions: config.dangerouslySkipPermissions,
    auto: config.auto,
  });


  const permissionsAdmin = createPermissionsAdmin(permissionGate, config.cwd);

  // Track the active subagent provider so a live /agent switch (provider, model,
  // or reasoning effort) reaches subagents spawned afterward. Seeded from config
  // and updated by the App through onSubAgentProviderChange.
  const liveSubAgentProvider: { current: SubAgentProvider } = {
    current: {
      providerName: config.providerName,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.providers.find((p) => p.name === config.providerName)?.bifrostVirtualKey === true
        ? { bifrostVirtualKey: true }
        : {}),
    },
  };
  // Live catalog + runtime settings so task(tier=…) sees mid-session OAuth
  // login and tier edits (config.providers / config.settings are load-time only).
  const liveSubAgentCatalog: { current: typeof config.providers } = {
    current: config.providers,
  };
  const liveSubAgentSettings: { current: typeof config.settings } = {
    current: config.settings,
  };

  // Dedicated child-session records for enter-session inspection. Child events
  // land here only — never in the parent chat transcript.
  const subAgentSessions = createSubAgentSessionStore();

  const webPluginCandidates = collectWebPlugins(executablePlugins());
  // Tool plugins are wired in only when enabled AND consented.
  const toolPluginCandidates = collectToolPlugins(executablePlugins());
  // Web and tool plugin resolution are independent, so resolve them concurrently.
  const [activeWeb, extraToolPlugins] = await Promise.all([
    resolveWebProviderFromPlugins({
      candidates: webPluginCandidates,
      pluginConfig: config.settings?.plugins ?? {},
      webOverride: config.settings?.web,
    }),
    resolveToolPlugins({
      candidates: toolPluginCandidates,
      pluginConfig: config.settings?.plugins ?? {},
    }),
  ]);
  if (activeWeb !== undefined) setActiveWebProviderBrand(webBrand(activeWeb.name));
  const webProvider = activeWeb?.provider;

  // /plugins UI backend: discovered plugin descriptors plus live, persisted
  // config (enabled flag, credentials, web override, extra paths) written to the
  // global settings file. Verify runs a real trial search through the web
  // candidate. The descriptor/candidate lists are mutable so plugins added by
  // path mid-session appear without a restart.
  const toDescriptor = (mod: {
    manifest?: PluginManifest;
    metadataOnly?: boolean;
    origin?: PluginOrigin;
  }): PluginDescriptor | undefined =>
    mod.manifest === undefined
      ? undefined
      : {
          id: mod.manifest.id,
          name: mod.manifest.name,
          ...(mod.manifest.kind !== undefined ? { kind: mod.manifest.kind } : {}),
          ...(mod.manifest.description !== undefined ? { description: mod.manifest.description } : {}),
          credentials: mod.manifest.credentials ?? [],
          ...(mod.metadataOnly === true ? { needsTrust: true } : {}),
          ...(mod.origin === "path" && mod.metadataOnly !== true ? { canRevokeTrust: true } : {}),
        };
  const pluginDescriptors: PluginDescriptor[] = livePluginModules
    .map((m) => toDescriptor(m))
    .filter((d): d is PluginDescriptor => d !== undefined);
  // Attach agent profiles to their descriptors so the /plugins UI can show
  // which sub-agents and tiers a plugin contributes.
  for (const mod of livePluginModules) {
    if (mod.manifest?.kind !== "agent" || mod.agentPlugin === undefined) continue;
    const desc = pluginDescriptors.find((d) => d.id === mod.manifest!.id);
    if (desc === undefined) continue;
    const agents = Array.isArray(mod.agentPlugin.agents) ? mod.agentPlugin.agents : [];
    desc.agentProfiles = agents
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && "id" in a)
      .map((a) => ({
        id: String(a["id"]),
        ...(typeof a["tier"] === "string" ? { tier: a["tier"] } : {}),
        ...(typeof a["description"] === "string" ? { description: a["description"] } : {}),
      }));
  }
  let livePluginConfig: Record<string, PluginConfig> = { ...(config.settings?.plugins ?? {}) };
  let liveWebOverride: string | undefined = config.settings?.web;
  const livePluginPaths: string[] = [...(config.settings?.pluginPaths ?? [])];
  const persistPluginSettings = async (): Promise<void> => {
    const current = await loadSettings(config.globalSettingsPath).catch(() => null);
    const base: Settings = current ?? { providers: {} };
    const next: Settings = { ...base, plugins: livePluginConfig };
    if (livePluginPaths.length > 0) next.pluginPaths = livePluginPaths;
    else delete next.pluginPaths;
    if (liveWebOverride !== undefined) next.web = liveWebOverride;
    else delete next.web;
    await saveGlobalSettings(config.globalSettingsPath, next);
  };
  const pluginsAdmin: PluginsAdmin = {
    list: () => pluginDescriptors,
    getConfig: () => livePluginConfig,
    getWebOverride: () => liveWebOverride,
    saveConfig: async (id, cfg) => {
      livePluginConfig = { ...livePluginConfig, [id]: cfg };
      // Enabling a project/path plugin records trust and full-loads code.
      if (cfg.enabled === true) {
        const stub = livePluginModules.find((m) => m.manifest?.id === id);
        // Trust routing must use the origin stamped at discovery — a fallback
        // here could turn one store's gate into the other's grant.
        if (
          stub?.metadataOnly === true
          && stub.pluginPath !== undefined
          && stub.origin !== undefined
        ) {
          if (stub.origin === "path") {
            pathTrust = await trustPathPlugin(stub.pluginPath);
          } else {
            projectTrust = await trustPlugin(config.cwd, stub.pluginPath);
          }
          const full = await loadPluginEntry(stub.pluginPath, {
            cwd: config.cwd,
            origin: stub.origin,
          });
          if (full !== null) {
            livePluginModules = livePluginModules.map((m) =>
              m.manifest?.id === id ? full : m,
            );
            const di = pluginDescriptors.findIndex((d) => d.id === id);
            const fullDesc = toDescriptor(full);
            if (di >= 0 && fullDesc !== undefined) pluginDescriptors.splice(di, 1, fullDesc);
            // Refresh web/tool candidate lists from the newly loaded module.
            for (const cand of collectWebPlugins([full])) {
              const ci = webPluginCandidates.findIndex((c) => c.id === cand.id);
              if (ci >= 0) webPluginCandidates.splice(ci, 1, cand);
              else webPluginCandidates.push(cand);
            }
            for (const cand of collectToolPlugins([full])) {
              const ci = toolPluginCandidates.findIndex((c) => c.id === cand.id);
              if (ci >= 0) toolPluginCandidates.splice(ci, 1, cand);
              else toolPluginCandidates.push(cand);
            }
            if (full.commandPlugin !== undefined && isEnabledCommandPlugin(full, livePluginConfig)) {
              registerCommandPlugin(full.commandPlugin);
            }
          }
        }
      }
      // Live-wire a command plugin the moment it is enabled (no restart needed);
      // disabling takes effect on the next launch.
      const mod = livePluginModules.find((m) => m.manifest?.id === id);
      if (mod !== undefined && isEnabledCommandPlugin(mod, livePluginConfig)) {
        registerCommandPlugin(mod.commandPlugin!);
      }
      await persistPluginSettings();
    },
    setWebOverride: async (id) => {
      liveWebOverride = id;
      await persistPluginSettings();
    },
    verify: async (id, credentials) => {
      // Agent plugins verify by checking they contribute valid profiles and
      // that each profile's tier resolves to a configured provider.
      const agentMod = livePluginModules.find((m) => m.manifest?.id === id && m.manifest?.kind === "agent");
      if (agentMod !== undefined) {
        const profiles = await resolveAgentPluginProfiles(
          [agentMod],
          { [id]: { enabled: true } },
          (msg) => process.stderr.write(`plugins: ${msg}\n`),
        );
        if (profiles.length === 0) return { ok: false, message: "No valid agent profiles found" };
        // Check tier resolution so the user knows if the provider is configured.
        const unresolved = profiles.filter(
          (p) => p.tier !== undefined && resolveTier(p.tier as ProviderTier, config.settings ?? { providers: {} }) === null,
        );
        const tierHint = unresolved.length > 0
          ? ` (${unresolved.length} unresolved tier${unresolved.length === 1 ? "" : "s"} — set in /model → tiers)`
          : "";
        return { ok: true, message: `loaded — ${profiles.length} profile${profiles.length === 1 ? "" : "s"}${tierHint}` };
      }
      // Tool plugins verify by loading (the factory must construct without
      // error and yield at least one tool).
      const toolCand = toolPluginCandidates.find((c) => c.id === id);
      if (toolCand !== undefined) {
        try {
          const plugin = await toolCand.factory(credentials);
          const count = plugin.tools?.length ?? 0;
          return { ok: true, message: `loaded — ${count} tool${count === 1 ? "" : "s"}` };
        } catch (err) {
          return { ok: false, message: scrubSecrets(err instanceof Error ? err.message : String(err)) };
        }
      }
      const candidate = webPluginCandidates.find((c) => c.id === id);
      if (candidate === undefined) return { ok: false, message: "Nothing to verify for this plugin" };
      try {
        const provider = await candidate.factory(credentials);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const results = await provider.search("corbits connectivity test", controller.signal);
          return { ok: true, message: `connected — ${results.length} results` };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return { ok: false, message: scrubSecrets(err instanceof Error ? err.message : String(err)) };
      }
    },
    addPath: async (rawPath) => {
      const path = rawPath.trim();
      if (path.length === 0) return { ok: false, message: "Enter a path" };
      const abs = isAbsolute(path) ? path : resolvePath(config.cwd, path);
      // Explicit add-by-path is user consent to load that absolute path.
      const mod = await loadPluginEntry(abs, { cwd: config.cwd, origin: "path" });
      if (mod === null) return { ok: false, message: `Could not load a plugin at ${path}` };
      if (mod.manifest === undefined) {
        return { ok: false, message: "Plugin has no manifest (needs id/name/kind)" };
      }
      const descriptor = toDescriptor(mod);
      if (descriptor === undefined) return { ok: false, message: "Invalid plugin manifest" };
      // Persist global path trust only once it resolves to a real plugin, so a
      // bogus path never leaves a dangling entry. Expand marketplaces so each
      // member is trusted (exact-path match on reload).
      const members = await expandPluginPath(abs);
      pathTrust = await trustPathPlugins(members.length > 0 ? members : [abs]);
      // Replace any existing descriptor/candidate with the same id so re-adding
      // refreshes rather than duplicates.
      const existingIdx = pluginDescriptors.findIndex((d) => d.id === descriptor.id);
      if (existingIdx >= 0) pluginDescriptors.splice(existingIdx, 1, descriptor);
      else pluginDescriptors.push(descriptor);
      const existingModIdx = livePluginModules.findIndex((m) => m.manifest?.id === descriptor.id);
      if (existingModIdx >= 0) livePluginModules[existingModIdx] = mod;
      else livePluginModules.push(mod);
      for (const cand of collectWebPlugins([mod])) {
        const ci = webPluginCandidates.findIndex((c) => c.id === cand.id);
        if (ci >= 0) webPluginCandidates.splice(ci, 1, cand);
        else webPluginCandidates.push(cand);
      }
      for (const cand of collectToolPlugins([mod])) {
        const ci = toolPluginCandidates.findIndex((c) => c.id === cand.id);
        if (ci >= 0) toolPluginCandidates.splice(ci, 1, cand);
        else toolPluginCandidates.push(cand);
      }
      // Register slash commands immediately so they show up without a restart.
      // Also persist enabled: true — path-add is consent to use the plugin; without
      // this, restart loads the path but isPluginEnabled stays false and commands vanish.
      livePluginConfig = enablePluginConfig(livePluginConfig, descriptor.id);
      if (mod.commandPlugin !== undefined && isEnabledCommandPlugin(mod, livePluginConfig)) {
        registerCommandPlugin(mod.commandPlugin);
      }
      // Persist the resolved absolute path so it reloads regardless of the cwd
      // the next session starts from.
      if (!livePluginPaths.includes(abs)) livePluginPaths.push(abs);
      await persistPluginSettings();
      return { ok: true, message: `Added ${descriptor.name}`, id: descriptor.id };
    },
    revokeTrust: async (id) => {
      const mod = livePluginModules.find((m) => m.manifest?.id === id);
      if (mod === undefined || mod.origin !== "path" || mod.pluginPath === undefined) {
        return { ok: false, message: "Only path-added plugins carry revocable global trust" };
      }
      pathTrust = await revokePathPlugin(mod.pluginPath);
      // Drop back to the metadata-only stub and disable: the module stays
      // registered in pluginPaths, but its code no longer loads. Anything
      // already imported this session unloads on the next launch.
      const stub = {
        ...(mod.dir !== undefined ? { dir: mod.dir } : {}),
        ...(mod.manifest !== undefined ? { manifest: mod.manifest } : {}),
        origin: mod.origin,
        pluginPath: mod.pluginPath,
        metadataOnly: true,
      };
      livePluginModules = livePluginModules.map((m) => (m.manifest?.id === id ? stub : m));
      const di = pluginDescriptors.findIndex((d) => d.id === id);
      const stubDesc = toDescriptor(stub);
      if (di >= 0 && stubDesc !== undefined) pluginDescriptors.splice(di, 1, stubDesc);
      const wi = webPluginCandidates.findIndex((c) => c.id === id);
      if (wi >= 0) webPluginCandidates.splice(wi, 1);
      const ti = toolPluginCandidates.findIndex((c) => c.id === id);
      if (ti >= 0) toolPluginCandidates.splice(ti, 1);
      livePluginConfig = { ...livePluginConfig, [id]: { ...(livePluginConfig[id] ?? {}), enabled: false } };
      await persistPluginSettings();
      return { ok: true, message: "Trust revoked — code stays unloaded from next launch" };
    },
  };

  const profilesDir = join(config.cwd, ".agents", "agents");
  const pluginAgentProfiles = await resolveAgentPluginProfiles(
    executablePlugins(),
    config.settings?.plugins ?? {},
    (msg) => process.stderr.write(`plugins: ${msg}\n`),
  );
  const initialProfiles = await loadAgentProfiles(profilesDir, pluginAgentProfiles);
  let liveAgentProfiles = initialProfiles;

  // Skill directories from enabled plugins, in addition to project-local
  // `.agents`/`.claude`/`.codex/skills` that discoverSkills/resolveSkillBody check.
  const skillDirs = executablePlugins()
    .filter((m) => m.dir !== undefined && m.manifest?.id !== undefined && pluginConfig[m.manifest.id]?.enabled === true)
    .map((m) => m.dir!);

  // Enabled plugin names, listed in the top-of-scrollback banner alongside skills.
  const activePlugins = executablePlugins()
    .filter((m) => m.manifest?.id !== undefined && pluginConfig[m.manifest.id]?.enabled === true)
    .map((m) => m.manifest!.name ?? m.manifest!.id);

  const shellTimeout = shellTimeoutFromSettings(config.settings);
  // Mutable so Settings → waitForApproval takes effect on the next tool call
  // without rebuilding the toolset.
  const liveToolWatchdog: ToolWatchdogConfig = {
    ...(toolWatchdogFromSettings(config.settings) ?? {}),
  };
  const localSettingsForMode = await loadLocalSettings(localSettingsPath(config.cwd)).catch(() => null);
  let liveSessionMode: SessionMode | undefined = resolveSessionMode(config.settings, localSettingsForMode);
  if (liveSessionMode === undefined) {
    const picked = await promptSessionModeIfUnset(config.globalSettingsPath);
    liveSessionMode = picked ?? "orchestrator";
    if (picked !== undefined) {
      const refreshed = await loadSettings(config.globalSettingsPath).catch(() => null);
      if (refreshed !== null) config = { ...config, settings: refreshed };
    }
  }
  if (liveSessionMode === "orchestrator") {
    configureSubAgentConcurrency(resolveMaxConcurrentSubAgents(config.settings));
  }
  const advertisedBuiltInPrefix = advertisedToolNamesForSessionMode(liveSessionMode);
  // The workflow controller is built below, after the toolset; the holder lets
  // advance_workflow's handler read live workflow-active state without a
  // construction-order cycle.
  const workflowControllerHolder: { instance?: WorkflowController } = {};

  // Assigned before any tool runs; getter wires session blob reads into posix tools.
  let currentAgent!: Agent;

  const toolset = await createAgentToolset({
    cwd: config.cwd,
    permissionGate,
    skillDirs,
    ...(shellTimeout !== undefined ? { shellTimeout } : {}),
    toolWatchdog: liveToolWatchdog,
    getBlobReader: () => currentAgent.blobReader,
    isWorkflowActive: () => workflowControllerHolder.instance?.isActive() === true,
    getGoalGovernor: () => goalGovernorRef.current,
    ...(webProvider !== undefined ? { webProvider } : {}),
    ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
    onOperatorGate: (question, options) =>
      new Promise<OperatorResult>((resolve) => {
        const event: OperatorGateEvent = { question, options, resolve };
        emitter.emit("operator.gate", event);
      }),
    sessionMode: liveSessionMode,
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
    mcpServersSource: config.mcpServersSource ?? "none",
    projectTrust,
    requestMcpTrust: async (server) => {
      // TOFU via operator gate: Trust this local MCP server?
      const result = await new Promise<OperatorResult>((resolve) => {
        const event: OperatorGateEvent = {
          question:
            `Trust local MCP server "${server.name}" for this project?`
            + (server.command !== undefined
              ? `\nCommand: ${server.command}${(server.args ?? []).length > 0 ? ` ${(server.args ?? []).join(" ")}` : ""}`
              : server.url !== undefined
                ? `\nURL: ${server.url}`
                : ""),
          options: ["Trust and connect", "Deny"],
          resolve,
        };
        emitter.emit("operator.gate", event);
      });
      return result.kind === "option" && result.index === 0;
    },
    subAgent: {
      provider: () => liveSubAgentProvider.current,
      sessions: subAgentSessions,
      getWorkdirBase: () => sessionDir(config.cwd, sessionId),
      // Progress only — not the full event stream. Forwarding every sub-agent
      // inference.delta into the parent transcript interleaves worker text with
      // the parent turn; progress keeps the status bar alive and the Agents
      // strip current without that pollution.
      onProgress: (info) => {
        emitter.emit("subagent.progress", info);
      },
      ...(liveSubAgentSettings.current !== undefined
        ? { settings: () => liveSubAgentSettings.current! }
        : {}),
      catalog: () => liveSubAgentCatalog.current,
      profiles: () => liveAgentProfiles,
    },
  });

  // These four loads have no data dependency on one another; they only converge
  // at buildChatSystemPrompt below. Running them concurrently means first paint
  // waits on the slowest, not the sum, of their I/O latencies.
  const [agentExtensions, overrides, environment, skills] = await Promise.all([
    loadAgentContextExtensions(config.cwd),
    loadSystemPromptOverrides(config.cwd),
    gatherEnvironment(config.cwd),
    discoverSkills(config.cwd, skillDirs),
  ]);
  const extensions = [
    ...agentExtensions,
    ...(config.systemPromptExtensions ?? []),
    ...overrides.append,
  ];
  const systemPrompt = buildChatSystemPrompt(
    extensions.length > 0 ? extensions : undefined,
    environment,
    overrides.base,
    skills,
    liveSessionMode,
  );

  const directorHolder: { instance?: ReturnType<typeof createChatDirector> } = {};

  // Owns the workflow lifecycle: slash-command starts, capability overrides,
  // resume, and publishing status to the App via the emitter.
  const workflowController = new WorkflowController({
    cwd: config.cwd,
    emitter,
    getSessionId: () => sessionId,
    getToolDefinitions: () => toolset.dynamicRunner.currentDefinitions(),
    getDirector: () => directorHolder.instance,
  });
  workflowControllerHolder.instance = workflowController;

  // Dynamic tool discovery: the runner registers every tool (built-in + MCP) for
  // dispatch but advertises only the fixed built-in prefix plus whatever the
  // session has activated so far (via tool_search matches, promoted below).
  // The prefix's membership and order never change, so it alone keeps the
  // provider cache prefix stable; activated names append once, in first-
  // activation order, and then hold steady until the next discovery. Strict
  // providers (grok Responses, codex-responses, OpenAI-style) refuse to call a
  // tool that was never declared on the wire, so an MCP tool must be promoted
  // here before the model can actually invoke it — merely being dispatchable in
  // the runner is not enough on those providers.
  const activatedToolNames = createActivatedToolTracker();
  const computeAdvertised = (all: readonly ToolDefinition[]): ToolDefinition[] =>
    advertisedTools(all, activatedToolNames.list(), advertisedBuiltInPrefix);

  // Reload, interrupt, compaction continuation, and proxy deliver share one queue
  // so a rebuild never races an in-flight deliver.
  const sessionOps = createSessionOperationQueue();
  const enqueueAgentDeliver = (deliverToLiveAgent: () => void): void => {
    void sessionOps.enqueue(async () => {
      try {
        deliverToLiveAgent();
      } catch {
        // Agent may be mid-reload or closing; a dropped message is harmless.
      }
    });
  };

  const chatDirectorDef = defineDirector({
    id: `${ID_PREFIX}/chat`,
    configSchema: type({}),
    factory: (_config, _env, agentCtx) => {
      const d = createChatDirector(
        agentCtx.systemPrompt,
        computeAdvertised([...agentCtx.toolDefinitions]),
        undefined,
        (names) => promoteTools(names),
        config.inactivityTimeoutMs ?? 750_000,
        config.totalTimeoutMs,
        undefined,
        undefined,
        () => {
          enqueueAgentDeliver(() => currentAgent.deliver(buildCompactionContinuationMessage()));
        },
      );
      d.setGoalGovernor(goalGovernor);
      directorHolder.instance = d;
      return d;
    },
  });

  const toolsFactory = defineTool({
    id: `${ID_PREFIX}/tui-tools`,
    factory: () => toolset.dynamicRunner,
  });

  const def = defineAgent({
    id: `${ID_PREFIX}/tui-agent`,
    systemPrompt,
    tools: [toolsFactory],
    capabilities: [],
    director: chatDirectorDef.build({}),
    inference: {
      sources: [{ provider: config.providerName, model: config.model }],
    },
  });

  // The agent freezes its tool-dispatch map at construction, so MCP servers that
  // connect after startup are not callable until the agent is rebuilt. buildAgent
  // re-runs tool resolution against the (now-populated) dynamic runner and resumes
  // conversation from the same git-backed store, so a reload is transparent.
  // When the session starts on a Codex profile, seed the agent with a Responses
  // source (account id pulled from the resolved catalog entry, session id from
  // the run) rather than the OpenAI-compatible one.
  const initialCodexProfile = codexProfileFromProviderName(config.providerName);
  const initialXaiProfile = xaiProfileFromProviderName(config.providerName);
  if (initialCodexProfile !== undefined) void refreshCodexInstructions().catch(() => {});
  const initialCodexAccountId = config.providers.find((p) => p.name === config.providerName)?.codexAccountId;
  const buildOpenAICompatibleInitialSource = (): InferenceSource =>
    buildOpenAISource({
      id: config.providerName,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    });
  const buildSessionSources = (): { sources: InferenceSource[]; defaultSource: string } =>
    buildMainSessionSources({
      settings: config.settings,
      catalog: config.providers,
      activeProvider: config.providerName,
      activeModel: config.model,
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      sessionId,
    });

  const initialBundle = buildSessionSources();
  let liveSources = initialBundle.sources;
  let liveDefaultSource = initialBundle.defaultSource;

  // The source the next inference will use, tracked live so the compaction
  // summarizer always summarizes with the current model (model switches and
  // Codex token refreshes update it below).
  let liveSource: InferenceSource =
    liveSources.find((s) => s.id === liveDefaultSource) ?? liveSources[0] ?? buildInitialSourceFallback();

  function buildInitialSourceFallback(): InferenceSource {
    return initialCodexProfile !== undefined
      ? buildCodexSource({
          id: config.providerName,
          apiKey: config.apiKey,
          model: config.model,
          sessionId,
          ...(initialCodexAccountId !== undefined ? { accountId: initialCodexAccountId } : {}),
          ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        })
      : initialXaiProfile !== undefined
        ? buildXaiSource({
            id: config.providerName,
            apiKey: config.apiKey,
            model: config.model,
          })
        : buildOpenAICompatibleInitialSource();
  }

  // Goal governor survives director rebuilds; reattached in the factory below.
  // Evaluator prefers the fast tier when configured, else the live session model.
  // Fail-open if inference fails.
  const goalGovernor = createGoalGovernor({
    evaluate: createGoalEvaluator({
      getSource: () => {
        const settings = config.settings;
        const refs = tierProviderRefs("fast", settings, { fallbackChain: true });
        const head = refs[0];

        if (head !== undefined) {
          const fast = buildInferenceSourceForRef(
            head,
            {
              sessionId,
              catalog: config.providers,
              ...(config.reasoningEffort !== undefined
                ? { reasoningEffort: config.reasoningEffort }
                : {}),
            },
            settings,
          );
          if (fast !== null) return fast;
        }
        return liveSource;
      },
      deps: inferenceDeps,
    }),
    onChange: (snap) => {
      emitter.emit("goal", snap.status === "inactive" || snap.status === "cleared" ? null : snap);
      void saveGoalState(
        config.cwd,
        sessionId,
        snap.status === "inactive" || snap.status === "cleared"
          ? null
          : {
              status: snap.status,
              condition: snap.condition,
              brief: snap.brief,
              criteria: snap.criteria,
              startedAt: snap.startedAt,
              ...(snap.completedAt !== undefined ? { completedAt: snap.completedAt } : {}),
              turnBudget: snap.turnBudget,
              turnsUsed: snap.turnsUsed,
              ...(snap.tokenBudget !== undefined ? { tokenBudget: snap.tokenBudget } : {}),
              mainTokens: snap.mainTokens,
              evalTokens: snap.evalTokens,
              ...(snap.lastReason !== undefined ? { lastReason: snap.lastReason } : {}),
            },
      );
    },
  });
  goalGovernorRef.current = goalGovernor;

  // Resume restores condition as paused so autonomy is never silently re-armed.
  {
    const persistedGoal = await loadGoalState(config.cwd, sessionId);
    if (persistedGoal !== null) {
      goalGovernor.restore(persistedGoal);
    }
  }

  // Compaction summarizer: produces a structured, workflow-aware handoff via a
  // one-shot call on the live model, falling back to the deterministic summary
  // on any failure. The workflow context is read at call time so a compaction
  // mid-/build or mid-/plan preserves which step we are on.
  const compactionSummarize = createModelSummarizer({ getSource: () => liveSource, deps: inferenceDeps });
  const summarizeForCompaction = (turns: Parameters<typeof compactionSummarize>[0]): Promise<string> => {
    const status = workflowController.status();
    const goalSnap = goalGovernor.get();
    const goalActive =
      goalSnap !== null &&
      (goalSnap.status === "active" || goalSnap.status === "paused" || goalSnap.status === "budget_limited");
    return compactionSummarize(turns, {
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
      ...(goalActive
        ? {
            goal: {
              condition: goalSnap.condition,
              status: goalSnap.status,
              brief: goalSnap.brief,
              ...(goalSnap.criteria.length > 0
                ? {
                    criteriaSummary: goalSnap.criteria
                      .map((c) => `[${c.status}] ${c.title}`)
                      .join("; "),
                  }
                : {}),
            },
          }
        : {}),
    });
  };

  // Mutable reference so the compaction summarize callback reads the live mode
  // without requiring an agent rebuild on every settings change.
  let liveCompactionMode = config.settings?.compactionMode ?? "llm";

  const buildAgent = async (): Promise<Agent> => {
    const storage = await createOptimizedContextStore(workdir);
    const sources = liveSources.length > 0 ? liveSources : [liveSource];
    const defaultSource = liveDefaultSource.length > 0 ? liveDefaultSource : liveSource.id;
    return createAgent(def, {
      sources,
      defaultSource,
      storage,
      workdir,
      // contextTransforms ride deps: the published @intx/agent forwards deps
      // into reactor assembly verbatim, and the vendored assembly picks the
      // transforms up from there.
      deps: {
        ...inferenceDeps,
        contextTransforms: [
          createAttachmentRehydrateTransform((key) => storage.readBlob(key)),
        ],
      },
      audit: noopAuditStore(),
      authorize: permissiveAuthorize(),
      directors: createDirectorRegistry({ factories: [chatDirectorDef.factory], defaultId: `${ID_PREFIX}/chat` }),
      compactors: {
        "pruning-compactor": createPruningCompactor({
          keepRecentTurns: 6,
          summaryMaxChars: 2500,
          ...(liveCompactionMode !== "pruning" ? { summarize: summarizeForCompaction } : { stripResultContent: true }),
        }),
      },
    });
  };

  const runSink = createRunSink({
    emitter,
    hookManager,
    onTurnComplete: (ctx) => {
      // provider_id is the canonical provider kind, never ctx.source.sourceId:
      // sourceId is the user-typed label from onboarding/settings, and free
      // text must not leave the process under the no-PII contract.
      getTelemetry().capture("inference_turn", {
        provider_id: ctx.source.provider,
        model_id: ctx.source.model,
        input_tokens: ctx.usage.input,
        output_tokens: ctx.usage.output,
        cache_read_tokens: ctx.usage.cacheRead,
        cache_write_tokens: ctx.usage.cacheWrite,
        thinking_tokens: ctx.usage.thinking,
        duration_ms: ctx.durationMs,
      });
    },
  });

  // MCP servers connected so far, keyed by name so a reconnect after a failure
  // replaces rather than duplicates the entry.
  let connectedMcpServers: ConnectedMcpServer[] = [];

  const writeRunSnapshot = async (
    status: RunState["status"],
    extra?: Pick<RunState, "finishedAt" | "error">,
  ): Promise<void> => {
    await saveState(config.cwd, sessionId, {
      status,
      turnsUsed: runSink.getTurnCount(),
      task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
      startedAt,
      model: `${liveSource.id}:${liveSource.model}`,
      mcpServers: connectedMcpServers,
      ...extra,
    });
  };

  // Progress snapshots are fired unsequenced (model switch, MCP connect, turn
  // completion), so a straggler could otherwise land after the terminal write
  // and resurrect status "running" — atomicWrite is last-rename-wins. Once the
  // run is finalized, drop them; the terminal paths write through
  // writeRunSnapshot directly.
  const persistRunSnapshot = async (
    status: RunState["status"],
    extra?: Pick<RunState, "finishedAt" | "error">,
  ): Promise<void> => {
    if (finalized) return;
    await writeRunSnapshot(status, extra);
  };

  const streamSink = (event: Parameters<typeof runSink.sink>[0]): void => {
    runSink.sink(event);
    if (event.type === "reactor.done") {
      void persistRunSnapshot("running");
    }
  };

  // Tool count before any MCP server connects; a reload is only worthwhile if
  // connecting actually added tools.
  const baseToolCount = toolset.dynamicRunner.currentDefinitions().length;

  currentAgent = await buildAgent();
  await persistRunSnapshot("running");
  void resolveSessionLabel(config.cwd, sessionId, runTaskTitle).then((label) => {
    emitter.emit("session.title", label);
  });
  let streamPromise = consumeStream(currentAgent.stream(), streamSink);

  // Serial operation queue. Rotation (reload, interrupt, newSession), compaction
  // continuation, and proxy deliver enqueue async tasks; they run one at a time.
  // `send` awaits the tail before dispatching so it never races a concurrent rebuild.
  let inFlight = 0;
  let pendingReload = false;
  // When buildAgent() throws after the old agent has been closed, this flag is
  // set and subsequent `send` calls throw immediately rather than dispatching to
  // a closed agent.
  let fatalBuildError: Error | null = null;

  const enqueueOp = sessionOps.enqueue;

  const reloadIfIdle = (): void => {
    if (!pendingReload || inFlight > 0) return;
    pendingReload = false;
    void enqueueOp(async () => {
      const old = currentAgent;
      await old.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
      currentAgent = await buildAgent();
      streamPromise = consumeStream(currentAgent.stream(), streamSink);
      // The rebuild made a fresh director; re-attach the active workflow.
      workflowController.reattach();
    });
  };

  // tool_search (and contextual triggers, e.g. the lsp hint) promote tools into
  // the advertised set. Advertising takes effect on the next infer; a reload is
  // scheduled so a newly connected MCP tool also becomes dispatchable after a
  // rebuild (built-in tools are already dispatchable, so promoting them alone
  // needs no reload, but the reload is a cheap no-op in that case).
  const promoteTools = (names: string[]): void => {
    if (!activatedToolNames.activate(names)) return;
    directorHolder.instance?.updateToolDefinitions(
      computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );
    pendingReload = true;
    reloadIfIdle();
  };
  toolset.setToolPromoter(promoteTools);

  // The active Codex source, tracked whenever a "codex/<profile>" source is
  // selected so its access token can be refreshed before each send. Seeded from
  // config when the session starts on a Codex profile (buildAgent sets that
  // source directly, not through the proxy's setSource).
  let activeCodexSource: { profile: string; source: InferenceSource } | undefined =
    initialCodexProfile !== undefined ? { profile: initialCodexProfile, source: liveSource } : undefined;
  let activeXaiSource: { profile: string; source: InferenceSource } | undefined =
    initialXaiProfile !== undefined ? { profile: initialXaiProfile, source: liveSource } : undefined;

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
    const active = activeCodexSource;
    if (active === undefined) return;
    const { access } = await getValidCodexToken(active.profile);
    const source: InferenceSource =
      access === active.source.apiKey ? active.source : { ...active.source, apiKey: access };
    activeCodexSource = { profile: active.profile, source };
    liveSource = source;
    setAgentSourceUnlessClosed(currentAgent, source);
  };

  const refreshXaiBeforeSend = async (): Promise<void> => {
    const active = activeXaiSource;
    if (active === undefined) return;
    const { access } = await getValidXaiToken(active.profile);
    const source: InferenceSource =
      access === active.source.apiKey ? active.source : { ...active.source, apiKey: access };
    activeXaiSource = { profile: active.profile, source };
    liveSource = source;
    setAgentSourceUnlessClosed(currentAgent, source);
  };

  // Stable handle handed to the App so the underlying agent can be swapped out
  // from under it without a remount; method calls always target the live agent.
  const agentProxy: Agent = {
    send: async (content, opts) => {
      await sessionOps.awaitTail();
      if (fatalBuildError !== null) throw fatalBuildError;
      const trimmed = typeof content === "string" ? content.trim() : "";
      if (trimmed.length > 0 && runTaskTitle.trim().length === 0) {
        runTaskTitle = trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
        emitter.emit("session.title", truncateSessionLabel(runTaskTitle));
        void persistRunSnapshot("running");
      }
      inFlight++;
      try {
        await refreshCodexBeforeSend();
        await refreshXaiBeforeSend();
        return await currentAgent.send(content, opts);
      } finally {
        inFlight--;
        reloadIfIdle();
      }
    },
    stream: () => currentAgent.stream(),
    deliver: (message) => {
      enqueueAgentDeliver(() => currentAgent.deliver(message));
    },
    close: () => currentAgent.close(),
    setSource: (source) => {
      const codexProfile = codexProfileFromProviderName(source.id);
      const xaiProfile = xaiProfileFromProviderName(source.id);
      activeCodexSource = codexProfile !== undefined ? { profile: codexProfile, source } : undefined;
      activeXaiSource = xaiProfile !== undefined ? { profile: xaiProfile, source } : undefined;
      liveSource = source;
      liveSources = [source];
      liveDefaultSource = source.id;
      setAgentSourceUnlessClosed(currentAgent, source);
      void persistRunSnapshot("running");
    },
    setSources: (sources, defaultSource) => {
      currentAgent.setSources(sources, defaultSource);
      liveSources = sources;
      liveDefaultSource = defaultSource;
      const head = sources.find((s) => s.id === defaultSource) ?? sources[0];
      if (head !== undefined) {
        const codexProfile = codexProfileFromProviderName(head.id);
        const xaiProfile = xaiProfileFromProviderName(head.id);
        activeCodexSource = codexProfile !== undefined ? { profile: codexProfile, source: head } : undefined;
        activeXaiSource = xaiProfile !== undefined ? { profile: xaiProfile, source: head } : undefined;
        liveSource = head;
      }
      void persistRunSnapshot("running");
    },
    history: () => currentAgent.history(),
    checkpoints: (limit) => currentAgent.checkpoints(limit),
    readAt: (hash) => currentAgent.readAt(hash),
    get blobReader() {
      return currentAgent.blobReader;
    },
  };

  // A hard stop: closing the agent is the only thing that aborts the reactor
  // mid-inference (the send signal only rejects the send promise). Close it,
  // drain the old stream, and rebuild a fresh agent so the next send works.
  const interrupt = (): void => {
    void enqueueOp(async () => {
      try {
        await currentAgent.close().catch(() => undefined);
        await streamPromise.catch(() => undefined);
        currentAgent = await buildAgent();
        streamPromise = consumeStream(currentAgent.stream(), streamSink);
        workflowController.reattach();
        fatalBuildError = null;
      } catch (err) {
        recordRunError(err);
        fatalBuildError = err instanceof Error ? err : new Error(String(err));
      }
    });
  };

  // /clear and /new start a fresh conversation: mint a new session id and its
  // own state directory, repoint the working tree at it, and rebuild the agent
  // so it resumes from an empty git-backed store. The prior session stays on
  // disk under its own id, resumable later.
  //
  // Sub-agent lifecycle on rotation: App cancels live workers (cancelAll +
  // abort handles → child agent.close) before clearing the session store so
  // /clear does not leave orphaned child reactors burning tokens.
  const newSession = (): void => {
    // The App clears its transcript unconditionally on /clear, so the backend
    // rotation is always enqueued regardless of contention; the queue serialises
    // it behind any in-progress op. Sub-agents nest under the new session
    // automatically because getWorkdirBase reads the live sessionId.
    void enqueueOp(async () => {
      try {
        await persistRunSnapshot("done", { finishedAt: Date.now() });
        sessionId = generateSessionId();
        startedAt = Date.now();
        runTaskTitle = config.task;
        emitter.emit("session.title", runTaskTitle.trim().length > 0 ? truncateSessionLabel(runTaskTitle) : "Untitled session");
        workdir = sessionContextDir(config.cwd, sessionId);
        await initSessionDir(config.cwd, sessionId);
        permissionGate.reset();
        runSink.reset();
        await currentAgent.close().catch(() => undefined);
        await streamPromise.catch(() => undefined);
        currentAgent = await buildAgent();
        streamPromise = consumeStream(currentAgent.stream(), streamSink);
        await persistRunSnapshot("running");
        // A fresh session drops any active workflow and goal.
        workflowController.reset();
        goalGovernor.clear();
        fatalBuildError = null;
      } catch (err) {
        recordRunError(err);
        fatalBuildError = err instanceof Error ? err : new Error(String(err));
      }
    });
  };

  // Ink 7.0.4 has no enterAltScreen render option, so drive the alternate
  // screen buffer by hand: enter before render to hide pre-launch scrollback,
  // and restore it on exit (including abrupt process exit) so history returns.
  // The `onboarded` flag is global user state: read and written against the TRUE
  // global settings file, never config.globalSettingsPath (which is the --config
  // file when one was given). This keeps first-run detection consistent and stops
  // a --config launch from stamping project-config contents into the global file.
  const trueGlobalSettingsPath = globalSettingsPath();
  const globalSettingsForOnboarding = await loadSettings(trueGlobalSettingsPath);
  const globallyOnboarded = globalSettingsForOnboarding?.onboarded === true;

  // Consent by proceeding (see telemetry/first-run.ts): on a first run the
  // singleton is a held no-op and the passive banner below is the
  // disclosure. The first interactively submitted prompt activates telemetry
  // and fires the held cli_start; a user who never acts keeps the hold for
  // this whole launch, and the render stamp means events start normally on
  // the next one. Keyed off the same TRUE global settings file as
  // `onboarded` above.
  const onChangeTelemetryEnabled = createTelemetryToggleHandler(trueGlobalSettingsPath);
  const telemetryFirstRun = telemetryFirstRunPending(globalSettingsForOnboarding);
  const telemetryNotice = telemetryFirstRun ? TELEMETRY_NOTICE : undefined;
  // Tracks the user's intent (persisted opt-in, updated live by the settings
  // toggle) rather than the held instance's state, so the settings tab shows
  // On during the hold and an opt-out before the first action suppresses
  // activation entirely.
  let liveTelemetryIntent = telemetryFirstRun || getTelemetry().enabled;
  if (telemetryFirstRun) {
    void markTelemetryNoticeShown(trueGlobalSettingsPath).catch(() => {
      // Best-effort: worst case the notice shows again next launch.
    });
  }

  const exitAltScreen = enterAltScreen();

  // Strip SGR mouse sequences before Ink's parser broadcasts input to every
  // useInput handler, so they can never leak into a text field as literal text.
  // Scroll-wheel events are re-routed through `mouseEvents` since they no longer
  // arrive via useInput.
  const { stdin: filteredStdin, mouse: mouseEvents } = createFilteredStdin(process.stdin);

  // Turn on SGR mouse reporting so the terminal emits the wheel sequences the
  // filter detects and re-routes to `mouseEvents`.
  const disableMouseReporting = enableMouseReporting();

  // Render first so the App's gate listeners are registered before it sends the
  // initial task. exitOnCtrlC is off so Ctrl+C reaches our keymap (stop the run)
  // instead of Ink killing the process outright.
  const { waitUntilExit } = render(
    <App
      eventEmitter={emitter}
      agent={agentProxy}
      sessionTitle={runTaskTitle.length > 0 ? runTaskTitle : "Untitled session"}
      initialModel={config.model}
      initialProvider={config.providerName}
      {...(config.reasoningEffort !== undefined ? { initialReasoningEffort: config.reasoningEffort } : {})}
      providers={config.providers}
      globalSettingsPath={config.globalSettingsPath}
      globalOnboardingPath={trueGlobalSettingsPath}
      globallyOnboarded={globallyOnboarded}
      {...(telemetryNotice !== undefined ? { telemetryNotice } : {})}
      telemetryEnabled={liveTelemetryIntent}
      onChangeTelemetryEnabled={(enabled) => {
        liveTelemetryIntent = enabled;
        onChangeTelemetryEnabled(enabled);
      }}
      {...(telemetryFirstRun
        ? {
            onFirstUserMessage: () => {
              if (!liveTelemetryIntent) return;
              void activateHeldTelemetry(trueGlobalSettingsPath, () => liveTelemetryIntent);
            },
          }
        : {})}
      {...(config.globalDefaultProvider !== undefined ? { globalDefaultProvider: config.globalDefaultProvider } : {})}
      cwd={config.cwd}
      initialTask={config.task}
      skipInitialTask={resumeSkipInitialTask}
      initialContentBlocks={[]}
      getSessionId={() => sessionId}
      initialHooks={hookManager.getStatuses()}
      onToggleHook={(hookId, enabled) => hookManager.setEnabled(hookId, enabled)}
      onAgentError={recordRunError}
      onInterrupt={interrupt}
      onNewSession={newSession}
      onRenameSession={(name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return "Session name cannot be empty";
        runTaskTitle = trimmed;
        emitter.emit("session.title", truncateSessionLabel(runTaskTitle));
        void renameSession(config.cwd, sessionId, trimmed).then(() => persistRunSnapshot("running"));
        return undefined;
      }}
      permissionsAdmin={permissionsAdmin}
      pluginsAdmin={pluginsAdmin}
      {...(config.profile !== undefined ? { profile: config.profile } : {})}
      initialAuto={config.auto}
      onToggleAuto={(value) => permissionGate.setAuto(value)}
      {...(config.tiers !== undefined ? { initialTiers: config.tiers } : {})}
      {...(config.settings !== undefined ? { initialSettings: config.settings } : {})}
      onChangeCompactionMode={async (mode) => {
        liveCompactionMode = mode;
        const current = await loadSettings(config.globalSettingsPath).catch(() => null);
        const base: Settings = current ?? { providers: {} };
        await saveGlobalSettings(config.globalSettingsPath, { ...base, compactionMode: mode });
      }}
      onChangeMaxConcurrentSubAgents={async (limit) => {
        configureSubAgentConcurrency(limit);
        const base = await loadGlobalSettingsWriteBase(config.globalSettingsPath);
        if (base === null) return;
        await saveGlobalSettings(config.globalSettingsPath, {
          ...base,
          maxConcurrentSubAgents: limit,
        });
      }}
      waitForApproval={resolveWaitForApproval(liveToolWatchdog)}
      onChangeWaitForApproval={async (value) => {
        liveToolWatchdog.waitForApproval = value;
        const base = await loadGlobalSettingsWriteBase(config.globalSettingsPath);
        if (base === null) return;
        await saveGlobalSettings(config.globalSettingsPath, {
          ...base,
          tools: { ...base.tools, waitForApproval: value },
        });
      }}
      initialSessionMode={liveSessionMode}
      {...(config.settings?.sessionMode !== undefined
        ? { initialSavedGlobalSessionMode: config.settings.sessionMode }
        : {})}
      {...(localSettingsForMode?.sessionMode !== undefined
        ? { initialSavedLocalSessionMode: localSettingsForMode.sessionMode }
        : {})}
      onChangeSessionMode={async (mode, scope) => {
        if (scope === "local") {
          const path = localSettingsPath(config.cwd);
          const existing = (await loadLocalSettings(path).catch(() => null)) ?? {};
          const next: LocalSettings = { ...existing, sessionMode: mode };
          await saveLocalSettings(path, next);
        } else {
          const current = await loadSettings(config.globalSettingsPath).catch(() => null);
          const base: Settings = current ?? { providers: {} };
          await saveGlobalSettings(config.globalSettingsPath, { ...base, sessionMode: mode });
        }
      }}
      initialProfiles={initialProfiles}
      profilesDir={profilesDir}
      onAgentProfilesChange={(profiles) => {
        liveAgentProfiles = profiles;
      }}
      onSubAgentProviderChange={(provider) => {
        liveSubAgentProvider.current = provider;
      }}
      onSubAgentRuntimeResolutionChange={({ catalog, settings }) => {
        liveSubAgentCatalog.current = [...catalog];
        liveSubAgentSettings.current = settings;
      }}
      onStartWorkflow={(name) => workflowController.start(name)}

      onToggleCapability={(name) => workflowController.toggleCapability(name)}
      loadedSkills={skills}
      activePlugins={activePlugins}
      initialWorkflowStatus={workflowController.status()}
      mouseEvents={mouseEvents}
      sessionStartedAt={startedAt}
      subAgentSessions={subAgentSessions}
      goalApi={{
        get: () => goalGovernor.get(),
        set: (condition, opts) => goalGovernor.set(condition, opts),
        pause: () => goalGovernor.pause(),
        resume: (opts) => goalGovernor.resume(opts),
        clear: () => goalGovernor.clear(),
      }}
    />,
    {
      exitOnCtrlC: false,
      stdin: filteredStdin,
      // Incremental (line-diff) rendering materially cuts streaming repaint
      // bytes versus Ink's default full-frame redraw.
      incrementalRendering: true,
    },
  );

  // Hydrate a resumed session's transcript after first paint. Reading history and
  // mapping it to content blocks is pure I/O with no bearing on the shell, so the
  // App renders empty immediately and fills in the past turns once they are ready.
  // Only the tail needed to fill RESUME_TRANSCRIPT_BLOCK_LIMIT blocks is read from
  // disk — a long session's full history is not needed just to paint a transcript
  // that itself caps how much it displays.
  void loadRecentTurns(workdir, RESUME_TRANSCRIPT_BLOCK_LIMIT)
    .then((turns) => {
      const blocks = turnsToContentBlocks(turns, { maxBlocks: RESUME_TRANSCRIPT_BLOCK_LIMIT });
      if (blocks.length > 0) emitter.emit("history.hydrate", blocks);
    })
    .catch(() => undefined);

  // Connect MCP servers after the TUI is up so the UI is usable immediately and
  // any OAuth authorization is surfaced as a copyable link rather than a browser
  // pop. Newly discovered tools are advertised to the live director right away;
  // once connection resolves, the agent is reloaded (when idle) so the tools are
  // also dispatchable. Aborted on exit so an unfinished auth wait does not keep
  // the process alive.
  const mcpConnectController = new AbortController();
  void toolset
    .connectMCP(
      {
        onStatus: (status) => {
          emitter.emit("mcp.status", status);
          if (status.state === "connected") {
            connectedMcpServers = [
              ...connectedMcpServers.filter((s) => s.name !== status.name),
              { name: status.name, toolCount: status.tools.length },
            ];
            void persistRunSnapshot("running");
          }
        },
        // MCP tools register for dispatch but stay unadvertised (blind) until
        // tool_search promotes them, so a fresh connection never grows the wire
        // set on its own — only a subsequent discovery does.
        onToolsChanged: (definitions) =>
          directorHolder.instance?.updateToolDefinitions(computeAdvertised(definitions)),
      },
      mcpConnectController.signal,
    )
    .then(async () => {
      if (toolset.dynamicRunner.currentDefinitions().length > baseToolCount) {
        pendingReload = true;
        reloadIfIdle();
      }
      // Now that the capability map reflects connected MCP servers, restore any
      // persisted workflow. New workflows are manual-only slash commands.
      await workflowController.resume();
    })
    .catch((err: unknown) => {
      // Fire-and-forget: an aborted connect on exit is expected and ignored;
      // any other failure is logged rather than raised as an unhandled rejection.
      if (err instanceof Error && err.name === "AbortError") return;
      getLogger([LOG_NAMESPACE_ROOT, "tui", "mcp"]).error("MCP connect failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await waitUntilExit();
  mcpConnectController.abort();
  disableMouseReporting();
  exitAltScreen();

  const finishedAt = Date.now();
  const turnCollector = runSink.getTurnCollector();
  const sinkError = runSink.getRunError();
  const summaryStatus = runSink.getStatus();
  // RunSummary's status ("done" | "failed" | "cancelled") maps directly onto
  // RunState's terminal statuses — no fallback to "running" here, otherwise a
  // finished run (finishedAt set) can be left reading as still in progress.
  const persistedStatus: RunState["status"] = summaryStatus;
  finalized = true;
  await writeRunSnapshot(persistedStatus, {
    finishedAt,
    ...(sinkError !== undefined ? { error: sinkError } : {}),
  });
  const runSummary = createRunSummary({
    task: runTaskTitle.length > 0 ? runTaskTitle : config.task,
    status: summaryStatus,
    startedAt,
    finishedAt,
    turnsUsed: runSink.getTurnCount(),
    tokenUsage: runSink.getTokenUsage(),
    turns: turnCollector?.getTurns() ?? [],
    toolCallCount: runSink.getToolCallCount(),
    ...(sinkError !== undefined ? { error: sinkError } : {}),
  });
  await hookManager.dispatchPostRun(runSummary);
  // exit_reason mirrors status at present — "cancelled" covers both an
  // operator interrupt and Ctrl+C, since the emit site here cannot tell them
  // apart (runSink only distinguishes done/failed/cancelled).
  const exitReason = runSummary.status === "done"
    ? "done"
    : runSummary.status === "failed"
      ? "error"
      : "cancelled";
  getTelemetry().capture("session_end", {
    status: runSummary.status,
    turn_count: runSummary.turnsUsed,
    duration_ms: runSummary.durationMs,
    session_mode: liveSessionMode,
    exit_reason: exitReason,
  });
  // Bound against process.exit dropping the session_end capture for short
  // sessions; flush itself is deadline-capped so exit stays snappy.
  await getTelemetry().flush();

  await sessionOps.awaitTail();
  try {
    await currentAgent.close();
  } catch {
    // ignore
  }
  try {
    await streamPromise;
  } catch {
    // ignore
  }
  await toolset.dispose();

  return resolveExitCode({
    runError,
    sinkError,
    status: runSink.getStatus(),
  });
  } catch (err) {
    await finalizeOnCrash(err);
    throw err;
  }
}
