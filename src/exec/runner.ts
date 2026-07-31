import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { isAbsolute, join, resolve } from "node:path";
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
import { createOptimizedContextStore } from "../session/optimized-context-store.js";
import { type } from "arktype";
import {
  buildCodexSource,
  buildOpenAISource,
  buildXaiSource,
  type Config,
} from "../config/index.js";
import {
  loadLocalSettings,
  localSettingsPath,
  resolveMaxConcurrentSubAgents,
  shellTimeoutFromSettings,
  toolWatchdogFromSettings,
} from "../config/settings.js";
import { configureSubAgentConcurrency } from "../subagent/concurrency.js";
import { codexProfileFromProviderName } from "../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../config/xai-providers.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import { getValidCodexToken } from "../auth/codex/session.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import {
  advertisedToolNamesForSessionMode,
  advertisedTools,
  createActivatedToolTracker,
} from "../agent/tool-search.js";
import { resolveSessionMode, type SessionMode } from "../config/session-mode.js";
import { createSubAgentSessionStore, type SubAgentProvider } from "../subagent/index.js";
import type { InferenceSource, ToolDefinition, InboundMessage } from "@intx/types/runtime";
import { createChatDirector } from "../agent/director.js";
import { buildChatSystemPrompt } from "../agent/prompts.js";
import { gatherEnvironment } from "../agent/environment.js";
import { loadAgentContextExtensions, loadSystemPromptOverrides } from "../agent/context-extensions.js";
import { buildMainSessionSources } from "../config/inference-sources.js";
import { loadAgentProfiles } from "../agent/profiles.js";
import { createPermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktrees.js";
import {
  loadApprovals,
  loadProjectApprovals,
  loadGlobalApprovals,
  loadProviderModelApprovals,
  saveProjectApproval,
  saveGlobalApproval,
  saveProviderModelApproval,
} from "../permission/store.js";
import type {
  Approval,
  ApprovalOutcome,
  GrantScope,
  PermissionRequest,
} from "../permission/types.js";
import { createAgentToolset, type AgentToolset, type OperatorResult } from "../agent/tools.js";
import { discoverSkills } from "../extensions/skills.js";
import { collectToolPlugins, resolveToolPlugins } from "../plugins/tool-plugins.js";
import {
  discoverRepoPlugins,
  discoverUserPlugins,
  discoverClaudeInstalledPlugins,
  expandExistingPluginMembers,
  loadPluginsFromPaths,
  dedupePluginModules,
} from "../plugins/loader.js";
import { isPluginTrusted, loadProjectTrust } from "../trust/project-trust.js";
import {
  isPathPluginTrusted,
  migratePathTrustFromPluginPaths,
  reportPathTrustMigration,
} from "../trust/path-trust.js";
import { consumeStream } from "../session/stream-consumer.js";
import { createCycleTextRecorder } from "../session/stream-journal.js";
import { appendCycleText } from "../subagent/repetition.js";
import {
  generateSessionId,
  initSessionDir,
  sessionContextDir,
  sessionDir,
} from "../session/index.js";
import { saveState, type ConnectedMcpServer } from "../session/state.js";
import { createRunSink, resolveExecRunStatus } from "../session/run-sink.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
} from "../session/hooks.js";
import { createPruningCompactor } from "../session/compactor.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { ID_PREFIX, LOG_NAMESPACE_ROOT } from "../branding.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import { setAgentSourceUnlessClosed } from "../tui/agent-source-sync.js";
import { getToolApprovalBudget } from "../tui/tool-execution-watchdog.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "exec"]);

/** Content-less inbound used after compact so the reactor re-enters (matches TUI). */
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

export type ExecResult = {
  exitCode: number;
  sessionId: string;
  text: string;
  error?: string;
  /** Run status after send/close (done | failed | cancelled). */
  status?: "done" | "failed" | "cancelled";
  /** Wall time from runExec start to summary (ms). */
  durationMs?: number;
  turnsUsed?: number;
  toolCallCount?: number;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  };
  /** Provider/model the config resolved for this run. */
  provider?: string;
  model?: string;
};


/**
 * Product non-TUI agent path (`corbits exec "prompt"`).
 *
 * Shares the same ChatDirector, toolset, permission gate, session mode, and
 * sub-agent surface as the TUI — without Ink. Bootstrap is intentionally a
 * forked copy of the TUI path (not a shared factory yet); see
 * docs/ARCHITECTURE.md "Exec Runner" for the intentional deltas.
 *
 * Operator/permission prompts use stdin when a TTY is available; otherwise
 * they deny (fail closed) unless `--dangerously-skip-permissions` / auto
 * grants cover the action.
 */
export async function runExec(config: Config): Promise<ExecResult> {
  const task = config.task.trim();
  if (task.length === 0) {
    stderr.write('Usage: corbits exec "<prompt>"\n');
    return {
      exitCode: 2,
      sessionId: config.sessionId,
      text: "",
      error: "missing prompt",
      status: "failed",
      durationMs: 0,
      turnsUsed: 0,
      toolCallCount: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      provider: config.providerName,
      model: config.model,
    };
  }


  const sessionId = config.sessionId.length > 0 ? config.sessionId : generateSessionId();
  const startedAt = Date.now();
  const workdir = sessionContextDir(config.cwd, sessionId);
  await initSessionDir(config.cwd, sessionId);

  let connectedMcp: ConnectedMcpServer[] = [];
  let agent: Agent | null = null;
  let toolset: AgentToolset | null = null;
  let textOut = "";
  let finalized = false;
  let turnsUsed = 0;

  const persist = async (
    status: "running" | "done" | "failed" | "cancelled",
    extra?: { error?: string },
  ): Promise<void> => {
    if (finalized && status === "running") return;
    if (status !== "running") finalized = true;
    await saveState(config.cwd, sessionId, {
      status,
      turnsUsed,
      task,
      startedAt,
      model: `${config.providerName}:${config.model}`,
      mcpServers: connectedMcp,
      ...(status !== "running" ? { finishedAt: Date.now() } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
    }).catch(() => undefined);
  };



  await persist("running");

  try {
    const inferenceDeps = await createInferenceDependencies();
    await seedPricingMetadataFromCache({ cachePath: defaultPricingCachePath() }).catch(
      () => undefined,
    );

    let projectTrust = await loadProjectTrust(config.cwd);
    const isProjectPluginTrusted = (pluginPath: string) => isPluginTrusted(projectTrust, pluginPath);
    // One-shot migration only when the path-trust file does not exist yet.
    let pathTrust = await migratePathTrustFromPluginPaths(
      config.settings?.pluginPaths ?? [],
      (p) => expandExistingPluginMembers(p, config.cwd),
      undefined,
      { onMigrated: reportPathTrustMigration },
    );
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
    // Metadata-only (untrusted) modules stay out of executable plugins.
    const executablePlugins = () => pluginModules.filter((m) => m.metadataOnly !== true);
    const pluginConfig = config.settings?.plugins ?? {};

    const toolPluginCandidates = collectToolPlugins(executablePlugins());
    const extraToolPlugins = await resolveToolPlugins({
      candidates: toolPluginCandidates,
      pluginConfig,
    });

    const skillDirs = executablePlugins()
      .filter(
        (m) =>
          m.dir !== undefined &&
          m.manifest?.id !== undefined &&
          pluginConfig[m.manifest.id]?.enabled === true,
      )
      .map((m) => m.dir!);

    const profilesDir = join(config.cwd, ".agents", "agents");
    const liveAgentProfiles = await loadAgentProfiles(profilesDir);

    const localSettingsForMode = await loadLocalSettings(localSettingsPath(config.cwd)).catch(
      () => null,
    );
    const sessionMode: SessionMode =
      resolveSessionMode(config.settings, localSettingsForMode) ?? "orchestrator";
    if (sessionMode === "orchestrator") {
      configureSubAgentConcurrency(resolveMaxConcurrentSubAgents(config.settings));
    }

    const activeProviderModel = `${config.providerName}:${config.model}`;
    const sessionApprovals = await loadApprovals(config.cwd, sessionId);
    const [projectApprovals, globalApprovals, providerModelApprovals] = await Promise.all([
      loadProjectApprovals(config.cwd),
      loadGlobalApprovals(),
      loadProviderModelApprovals(),
    ]);
    const seededApprovals: Approval[] = [
      ...sessionApprovals,
      ...projectApprovals,
      ...globalApprovals,
      ...providerModelApprovals,
    ];

    const interactive = input.isTTY === true && output.isTTY === true;

    const permissionGate = createPermissionGate({
      approvals: seededApprovals,
      cwd: config.cwd,
      rootsProvider: createWorktreeRootsProvider(config.cwd),
      providerName: config.providerName,
      model: config.model,
      requestApproval: (request: PermissionRequest): Promise<ApprovalOutcome> =>
        promptPermission(request, interactive),
      persist: (approval: Approval, scope: GrantScope) => {
        if (scope === "project") void saveProjectApproval(config.cwd, approval);
        else if (scope === "global") void saveGlobalApproval(approval);
        else if (scope === "provider-model") {
          void saveProviderModelApproval(activeProviderModel, approval);
        }
      },
      interactive,
      skipPermissions: config.dangerouslySkipPermissions,
      auto: config.auto,
    });

    const liveSubAgentProvider: { current: SubAgentProvider } = {
      current: {
        providerName: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        ...(config.reasoningEffort !== undefined
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
        ...(config.providers.find((p) => p.name === config.providerName)?.bifrostVirtualKey === true
          ? { bifrostVirtualKey: true }
          : {}),
      },
    };
    const subAgentSessions = createSubAgentSessionStore();
    const shellTimeout = shellTimeoutFromSettings(config.settings);
    const toolWatchdog = toolWatchdogFromSettings(config.settings);

    let currentAgent: Agent | null = null;

    const agentToolset = await createAgentToolset({
      cwd: config.cwd,
      permissionGate,
      skillDirs,
      ...(shellTimeout !== undefined ? { shellTimeout } : {}),
      ...(toolWatchdog !== undefined ? { toolWatchdog } : {}),
      ...(localSettingsForMode?.env !== undefined ? { shellEnv: localSettingsForMode.env } : {}),
      getBlobReader: () => {
        if (currentAgent === null) {
          throw new Error("blob reader requested before agent init");
        }
        return currentAgent.blobReader;
      },
      // Exec has no workflow controller — intentional delta vs TUI.
      isWorkflowActive: () => false,
      onOperatorGate: (question, options) => promptOperator(question, options, interactive),
      sessionMode,
      ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
      mcpServersSource: config.mcpServersSource ?? "none",
      projectTrust,
      requestMcpTrust: async (server) => {
        if (!interactive) return false;
        const result = await promptOperator(
          `Trust local MCP server "${server.name}" for this project?`
            + (server.command !== undefined
              ? `\nCommand: ${server.command}`
              : server.url !== undefined
                ? `\nURL: ${server.url}`
                : ""),
          ["Trust and connect", "Deny"],
          true,
        );
        return result.kind === "option" && result.index === 0;
      },
      subAgent: {
        provider: () => liveSubAgentProvider.current,
        sessions: subAgentSessions,
        getWorkdirBase: () => sessionDir(config.cwd, sessionId),
        onProgress: () => undefined,
        ...(config.settings !== undefined ? { settings: () => config.settings! } : {}),
        catalog: () => config.providers,
        profiles: () => liveAgentProfiles,
      },
      ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
    });
    toolset = agentToolset;

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
      sessionMode,
    );

    const advertisedBuiltInPrefix = advertisedToolNamesForSessionMode(sessionMode);
    const activatedToolNames = createActivatedToolTracker();
    const computeAdvertised = (all: readonly ToolDefinition[]): ToolDefinition[] =>
      advertisedTools(all, activatedToolNames.list(), advertisedBuiltInPrefix);

    const directorHolder: { instance?: ReturnType<typeof createChatDirector> } = {};

    const chatDirectorDef = defineDirector({
      id: `${ID_PREFIX}/chat`,
      configSchema: type({}),
      factory: (_cfg, _env, agentCtx) => {
        const d = createChatDirector(
          agentCtx.systemPrompt,
          computeAdvertised([...agentCtx.toolDefinitions]),
          undefined,
          (names) => {
            if (!activatedToolNames.activate(names)) return;
            directorHolder.instance?.updateToolDefinitions(
              computeAdvertised(agentToolset.dynamicRunner.currentDefinitions()),
            );
          },
          config.inactivityTimeoutMs ?? 750_000,
          config.totalTimeoutMs,
          undefined,
          undefined,
          () => {
            // Compaction governor self-delivers after compact so the loop re-enters.
            currentAgent?.deliver(buildCompactionContinuationMessage());
          },
          { providerName: config.providerName, model: config.model },
        );
        directorHolder.instance = d;
        return d;
      },
    });

    const toolsFactory = defineTool({
      id: `${ID_PREFIX}/exec-tools`,
      factory: () => agentToolset.dynamicRunner,
    });

    const def = defineAgent({
      id: `${ID_PREFIX}/exec-agent`,
      systemPrompt,
      tools: [toolsFactory],
      capabilities: [],
      director: chatDirectorDef.build({}),
      inference: {
        sources: [{ provider: config.providerName, model: config.model }],
      },
    });

    const initialCodexProfile = codexProfileFromProviderName(config.providerName);
    const initialXaiProfile = xaiProfileFromProviderName(config.providerName);
    const initialCodexAccountId = config.providers.find(
      (p) => p.name === config.providerName,
    )?.codexAccountId;

    const buildOpenAICompatibleInitialSource = (): InferenceSource =>
      buildOpenAISource({
        id: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        ...(config.reasoningEffort !== undefined
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
      });

    const buildSessionSources = (): { sources: InferenceSource[]; defaultSource: string } =>
      buildMainSessionSources({
        settings: config.settings,
        catalog: config.providers,
        activeProvider: config.providerName,
        activeModel: config.model,
        ...(config.reasoningEffort !== undefined
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
        sessionId,
      });

    const initialBundle = buildSessionSources();
    let liveSources = initialBundle.sources;
    let liveDefaultSource = initialBundle.defaultSource;

    const buildInitialSourceFallback = (): InferenceSource =>
      initialCodexProfile !== undefined
        ? buildCodexSource({
            id: config.providerName,
            apiKey: config.apiKey,
            model: config.model,
            sessionId,
            ...(initialCodexAccountId !== undefined ? { accountId: initialCodexAccountId } : {}),
            ...(config.reasoningEffort !== undefined
              ? { reasoningEffort: config.reasoningEffort }
              : {}),
          })
        : initialXaiProfile !== undefined
          ? buildXaiSource({
              id: config.providerName,
              apiKey: config.apiKey,
              model: config.model,
            })
          : buildOpenAICompatibleInitialSource();

    let liveSource: InferenceSource =
      liveSources.find((s) => s.id === liveDefaultSource) ??
      liveSources[0] ??
      buildInitialSourceFallback();

    // Refresh OAuth tokens before first inference when starting on codex/xai.
    if (initialCodexProfile !== undefined) {
      const { access } = await getValidCodexToken(initialCodexProfile);
      liveSource = { ...liveSource, apiKey: access };
      liveSubAgentProvider.current = {
        ...liveSubAgentProvider.current,
        apiKey: access,
      };
    }
    if (initialXaiProfile !== undefined) {
      const { access } = await getValidXaiToken(initialXaiProfile);
      liveSource = { ...liveSource, apiKey: access };
      liveSubAgentProvider.current = {
        ...liveSubAgentProvider.current,
        apiKey: access,
      };
    }

    const summarizeForCompaction = createModelSummarizer({
      getSource: () => liveSource,
      deps: inferenceDeps,
    });
    const liveCompactionMode = config.settings?.compactionMode ?? "llm";

    const buildAgent = async (): Promise<Agent> => {
      const storage = await createOptimizedContextStore(workdir);
      const sources = liveSources.length > 0 ? liveSources : [liveSource];
      const defaultSource = liveDefaultSource.length > 0 ? liveDefaultSource : liveSource.id;
      // Prefer liveSource credentials on the active id when OAuth was refreshed.
      const withLiveCreds = sources.map((s) =>
        s.id === liveSource.id ? { ...s, apiKey: liveSource.apiKey } : s,
      );
      return createAgent(def, {
        sources: withLiveCreds,
        defaultSource,
        storage,
        workdir,
        // contextTransforms ride deps: the published @intx/agent forwards
        // deps into reactor assembly verbatim, and the vendored assembly
        // picks the transforms up from there.
        deps: {
          ...inferenceDeps,
          contextTransforms: [
            createAttachmentRehydrateTransform((key) => storage.readBlob(key)),
          ],
        },
        audit: noopAuditStore(),
        authorize: permissiveAuthorize(),
        directors: createDirectorRegistry({
          factories: [chatDirectorDef.factory],
          defaultId: `${ID_PREFIX}/chat`,
        }),
        compactors: {
          "pruning-compactor": createPruningCompactor({
            keepRecentTurns: 6,
            summaryMaxChars: 2500,
            ...(liveCompactionMode !== "pruning"
              ? { summarize: summarizeForCompaction }
              : { stripResultContent: true }),
          }),
        },
      });
    };

    const emitter = new EventEmitter();
    const hookManager = createLifecycleHookManager({
      hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
    });
    const runSink = createRunSink({ emitter, hookManager });

    currentAgent = await buildAgent();
    agent = currentAgent;
    // Local non-null handle after init (currentAgent stays mutable for compaction deliver).
    const activeAgent = currentAgent;

    if (agentToolset.connectMCP !== undefined) {
      await agentToolset
        .connectMCP({
          onStatus: (status) => {
            if (status.state === "connected") {
              connectedMcp = [
                ...connectedMcp.filter((s) => s.name !== status.name),
                { name: status.name, toolCount: status.tools.length },
              ];
            }
          },
          onToolsChanged: (definitions) =>
            directorHolder.instance?.updateToolDefinitions(computeAdvertised(definitions)),
        })
        .catch((err: unknown) => {
          logger.warn("MCP connect failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const textChunks: string[] = [];
    // Cycles persist to the context store only on inference.done; the recorder
    // keeps the in-flight cycle's text so an errored or aborted turn leaves
    // its partial output in partial.jsonl instead of vanishing.
    const cycleRecorder = createCycleTextRecorder(() => workdir, appendCycleText);
    const sink = (event: ReactorEmittedEvent): void => {
      runSink.sink(event);
      cycleRecorder.handleEvent(event);
      if (event.type === "inference.text.delta") {
        const token = (event.data as { token?: string }).token;
        if (typeof token === "string" && token.length > 0) {
          textChunks.push(token);
          output.write(token);
        }
      }
    };

    const streamPromise = consumeStream(activeAgent.stream(), sink);

    // send() resolves on connector.reply when the reactor finishes the cycle.
    // Chat sessions never emit reactor.done until close, so runSink status after
    // an intentional post-send close is "cancelled" even on success. Treat a
    // completed send as success unless the sink recorded a real run error.
    // Snapshot sink state BEFORE close: close emits reactor.done which clears
    // sticky inference.error and would hide a real failure.
    let sendCompleted = false;
    let runError: string | undefined;
    let sinkStatus: ReturnType<typeof runSink.getStatus> = "cancelled";
    try {
      // Final OAuth refresh immediately before send (token may have aged during MCP).
      if (initialCodexProfile !== undefined) {
        const { access } = await getValidCodexToken(initialCodexProfile);
        if (access !== liveSource.apiKey) {
          liveSource = { ...liveSource, apiKey: access };
          setAgentSourceUnlessClosed(activeAgent, liveSource);
        }
      }
      if (initialXaiProfile !== undefined) {
        const { access } = await getValidXaiToken(initialXaiProfile);
        if (access !== liveSource.apiKey) {
          liveSource = { ...liveSource, apiKey: access };
          setAgentSourceUnlessClosed(activeAgent, liveSource);
        }
      }

      // Stream stays open for multi-turn chat until close() — close first, then
      // drain, or streamPromise never settles.
      await activeAgent.send(task);
      sendCompleted = true;
      runError = runSink.getRunError();
      sinkStatus = runSink.getStatus();
    } finally {
      await activeAgent.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
    }

    textOut = textChunks.join("");
    if (textOut.length > 0 && !textOut.endsWith("\n")) output.write("\n");

    // Counts always live on runSink; getTurnCollector() is null when no
    // lifecycle hooks are configured (typical exec/eval path) and only
    // exposes retained turn history for post-run hooks.
    const turnCollector = runSink.getTurnCollector();
    turnsUsed = runSink.getTurnCount();
    const finishedAt = Date.now();
    const summaryStatus = resolveExecRunStatus({
      sendCompleted,
      sinkStatus,
      runError,
    });

    const runSummary = createRunSummary({
      task,
      status: summaryStatus,
      startedAt,
      finishedAt,
      turnsUsed: runSink.getTurnCount(),
      tokenUsage: runSink.getTokenUsage(),
      turns: turnCollector?.getTurns() ?? [],
      toolCallCount: runSink.getToolCallCount(),
      ...(runError !== undefined ? { error: runError } : {}),
    });
    await hookManager.dispatchPostRun(runSummary).catch(() => undefined);

    if (!sendCompleted || runError !== undefined || summaryStatus === "failed") {
      const message =
        runError
        ?? (summaryStatus === "cancelled" ? "run cancelled before completion" : "run failed");
      stderr.write(`Error: ${message}\n`);
      const persistStatus = summaryStatus === "cancelled" ? "cancelled" : "failed";
      await persist(persistStatus, { error: message });
      return {
        exitCode: 1,
        sessionId,
        text: textOut,
        error: message,
        status: summaryStatus,
        durationMs: finishedAt - startedAt,
        turnsUsed: runSink.getTurnCount(),
        toolCallCount: runSink.getToolCallCount(),
        tokenUsage: runSink.getTokenUsage(),
        provider: config.providerName,
        model: config.model,
      };
    }

    await persist("done");
    return {
      exitCode: 0,
      sessionId,
      text: textOut,
      status: "done",
      durationMs: finishedAt - startedAt,
      turnsUsed: runSink.getTurnCount(),
      toolCallCount: runSink.getToolCallCount(),
      tokenUsage: runSink.getTokenUsage(),
      provider: config.providerName,
      model: config.model,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("exec failed: {error}", { error: message });
    stderr.write(`Error: ${message}\n`);
    await persist("failed", { error: message });
    return {
      exitCode: 1,
      sessionId,
      text: textOut,
      error: message,
      status: "failed",
      durationMs: Date.now() - startedAt,
      turnsUsed,
      toolCallCount: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      provider: config.providerName,
      model: config.model,
    };
  } finally {
    if (agent !== null) {
      await agent.close().catch(() => undefined);
    }
    // Match TUI: always dispose toolset (MCP clients + posix/plugin resources).
    if (toolset !== null) {
      await toolset.dispose().catch(() => undefined);
    }
  }
}

async function promptOperator(
  question: string,
  options: string[],
  interactive: boolean,
): Promise<OperatorResult> {
  if (!interactive) {
    return { kind: "cancel" };
  }
  stderr.write(`\n${question}\n`);
  options.forEach((opt, i) => stderr.write(`  [${i + 1}] ${opt}\n`));
  stderr.write("Enter number, free text, or empty to cancel: ");
  const rl = createInterface({ input, output: stderr });
  try {
    const line = (await rl.question("")).trim();
    if (line.length === 0) return { kind: "cancel" };
    const n = Number(line);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return { kind: "option", index: n - 1 };
    }
    return { kind: "custom", text: line };
  } finally {
    rl.close();
  }
}

async function promptPermission(
  request: PermissionRequest,
  interactive: boolean,
): Promise<ApprovalOutcome> {
  if (!interactive) return { allow: false };
  // Same freeze-while-deciding contract as the TUI gate: the tool wall-clock
  // budget must not run down while the operator reads the prompt.
  const budget = getToolApprovalBudget();
  if (budget === undefined) {
    // Every exec tool call runs under the watchdog ALS; an absent store means
    // the gate fired outside a tool run or the ALS context was lost.
    logger.warn("permission prompt reached with no tool budget in ALS for {tool}", {
      tool: request.tool,
    });
  }
  const pauseToken = budget?.waitForApproval ? budget.pause() : undefined;
  const summary = `${request.tool}: ${request.subject}`;
  stderr.write(`\nPermission required: ${summary}\n`);
  const scopes = request.scopes;
  scopes.forEach((scope, i) => {
    stderr.write(`  [${i + 1}] ${scope.label}\n`);
  });
  stderr.write(`  [${scopes.length + 1}] Deny\n`);
  const rl = createInterface({ input, output: stderr });
  try {
    const line = (await rl.question("Choice: ")).trim();
    const n = Number(line);
    if (!Number.isInteger(n) || n < 1 || n > scopes.length) {
      return { allow: false };
    }
    const chosen = scopes[n - 1]!;
    return {
      allow: true,
      ...(chosen.pattern !== null ? { persist: chosen } : {}),
    };
  } finally {
    rl.close();
    if (pauseToken !== undefined) budget?.resume(pauseToken);
  }
}
