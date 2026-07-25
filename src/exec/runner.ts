import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { join } from "node:path";
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
import type { InferenceSource, ToolDefinition } from "@intx/types/runtime";
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
import { createAgentToolset, type OperatorResult } from "../agent/tools.js";
import { discoverSkills } from "../extensions/skills.js";
import { collectWebPlugins, resolveWebProviderFromPlugins } from "../web/plugin-provider.js";
import { collectToolPlugins, resolveToolPlugins } from "../plugins/tool-plugins.js";
import {
  discoverRepoPlugins,
  discoverUserPlugins,
  discoverClaudeInstalledPlugins,
  loadPluginsFromPaths,
  dedupePluginModules,
} from "../plugins/loader.js";
import { isPluginTrusted, loadProjectTrust } from "../trust/project-trust.js";
import { consumeStream } from "../session/stream-consumer.js";
import {
  generateSessionId,
  initSessionDir,
  sessionContextDir,
  sessionDir,
} from "../session/index.js";
import { saveState, type ConnectedMcpServer } from "../session/state.js";
import { createRunSink } from "../session/run-sink.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
} from "../session/hooks.js";
import { createPruningCompactor } from "../session/compactor.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { ID_PREFIX, LOG_NAMESPACE_ROOT } from "../branding.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import { setAgentSourceUnlessClosed } from "../tui/agent-source-sync.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "exec"]);

export type ExecResult = {
  exitCode: number;
  sessionId: string;
  text: string;
  error?: string;
};

/**
 * Product non-TUI agent path (`corbits exec "prompt"`).
 *
 * Boots the same ChatDirector, toolset, permission gate, session mode, and
 * sub-agent surface as the TUI — without Ink. Operator/permission prompts use
 * stdin when a TTY is available; otherwise they deny (fail closed) unless
 * `--dangerously-skip-permissions` / auto grants cover the action.
 */
export async function runExec(config: Config): Promise<ExecResult> {
  const task = config.task.trim();
  if (task.length === 0) {
    stderr.write('Usage: corbits exec "<prompt>"\n');
    return { exitCode: 2, sessionId: config.sessionId, text: "", error: "missing prompt" };
  }

  const sessionId = config.sessionId.length > 0 ? config.sessionId : generateSessionId();
  const startedAt = Date.now();
  const workdir = sessionContextDir(config.cwd, sessionId);
  await initSessionDir(config.cwd, sessionId);

  let connectedMcp: ConnectedMcpServer[] = [];
  let agent: Agent | null = null;
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
    const isTrustedPath = (pluginPath: string) => isPluginTrusted(projectTrust, pluginPath);
    const claudePlugins =
      config.settings?.discoverClaudePlugins === true
        ? await discoverClaudeInstalledPlugins(config.cwd)
        : [];
    const pluginModules = dedupePluginModules([
      ...(await discoverRepoPlugins(config.cwd)),
      ...(await discoverUserPlugins(config.cwd, { isPluginTrusted: isTrustedPath })),
      ...claudePlugins,
      ...(await loadPluginsFromPaths(config.settings?.pluginPaths ?? [], config.cwd, {
        isPluginTrusted: isTrustedPath,
      })),
    ]);
    // Metadata-only (untrusted) modules stay out of executable plugins.
    const executablePlugins = () => pluginModules.filter((m) => m.metadataOnly !== true);
    const pluginConfig = config.settings?.plugins ?? {};

    const webPluginCandidates = collectWebPlugins(executablePlugins());
    const toolPluginCandidates = collectToolPlugins(executablePlugins());
    const [activeWeb, extraToolPlugins] = await Promise.all([
      resolveWebProviderFromPlugins({
        candidates: webPluginCandidates,
        pluginConfig,
        webOverride: config.settings?.web,
      }),
      resolveToolPlugins({
        candidates: toolPluginCandidates,
        pluginConfig,
      }),
    ]);

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

    let currentAgent!: Agent;

    const toolset = await createAgentToolset({
      cwd: config.cwd,
      permissionGate,
      skillDirs,
      ...(shellTimeout !== undefined ? { shellTimeout } : {}),
      ...(toolWatchdog !== undefined ? { toolWatchdog } : {}),
      getBlobReader: () => currentAgent.blobReader,
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
      ...(activeWeb?.provider !== undefined ? { webProvider: activeWeb.provider } : {}),
      ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
    });

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
              computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
            );
          },
          config.inactivityTimeoutMs ?? 750_000,
          config.totalTimeoutMs,
        );
        directorHolder.instance = d;
        return d;
      },
    });

    const toolsFactory = defineTool({
      id: `${ID_PREFIX}/exec-tools`,
      factory: () => toolset.dynamicRunner,
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
        deps: inferenceDeps,
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

    if (toolset.connectMCP !== undefined) {
      await toolset
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
    const sink = (event: ReactorEmittedEvent): void => {
      runSink.sink(event);
      if (event.type === "inference.text.delta") {
        const token = (event.data as { token?: string }).token;
        if (typeof token === "string" && token.length > 0) {
          textChunks.push(token);
          output.write(token);
        }
      }
    };

    const streamPromise = consumeStream(currentAgent.stream(), sink);

    try {
      // Final OAuth refresh immediately before send (token may have aged during MCP).
      if (initialCodexProfile !== undefined) {
        const { access } = await getValidCodexToken(initialCodexProfile);
        if (access !== liveSource.apiKey) {
          liveSource = { ...liveSource, apiKey: access };
          setAgentSourceUnlessClosed(currentAgent, liveSource);
        }
      }
      if (initialXaiProfile !== undefined) {
        const { access } = await getValidXaiToken(initialXaiProfile);
        if (access !== liveSource.apiKey) {
          liveSource = { ...liveSource, apiKey: access };
          setAgentSourceUnlessClosed(currentAgent, liveSource);
        }
      }

      // send() resolves when the reactor finishes the turn.
      await currentAgent.send(task);
      // Drain stream so runSink sees reactor.done / errors before we summarize.
      await streamPromise.catch(() => undefined);
    } finally {
      // Close after drain (or after send failure) so the stream can settle.
      await currentAgent.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
    }

    textOut = textChunks.join("");
    if (textOut.length > 0 && !textOut.endsWith("\n")) output.write("\n");

    const runError = runSink.getRunError();
    const turnCollector = runSink.getTurnCollector();
    turnsUsed = turnCollector.getTurnCount();
    const finishedAt = Date.now();
    const summaryStatus = runSink.getStatus();

    const runSummary = createRunSummary({
      task,
      status: summaryStatus,
      startedAt,
      finishedAt,
      turnsUsed: turnCollector.getTurnCount(),
      tokenUsage: turnCollector.getTokenUsage(),
      turns: turnCollector.getTurns(),
      toolCallCount: turnCollector.getToolCallCount(),
      ...(runError !== undefined ? { error: runError } : {}),
    });
    await hookManager.dispatchPostRun(runSummary).catch(() => undefined);

    if (runError !== undefined || summaryStatus === "failed" || summaryStatus === "cancelled") {
      const message =
        runError
        ?? (summaryStatus === "cancelled" ? "run cancelled before completion" : "run failed");
      stderr.write(`Error: ${message}\n`);
      const persistStatus = summaryStatus === "cancelled" ? "cancelled" : "failed";
      await persist(persistStatus, { error: message });
      return { exitCode: 1, sessionId, text: textOut, error: message };
    }

    await persist("done");
    return { exitCode: 0, sessionId, text: textOut };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("exec failed: {error}", { error: message });
    stderr.write(`Error: ${message}\n`);
    await persist("failed", { error: message });
    return { exitCode: 1, sessionId, text: textOut, error: message };
  } finally {
    if (agent !== null) {
      await agent.close().catch(() => undefined);
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
  }
}
