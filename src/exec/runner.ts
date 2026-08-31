import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { join } from "node:path";
import {
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
  resolveLocalSettingsPath,
  shellTimeoutFromSettings,
  toolWatchdogFromSettings,
} from "../config/settings.js";
import { codexProfileFromProviderName, isCodexProviderName } from "../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../config/xai-providers.js";
import { formatDirectorSystemPrompt } from "../agent/directors/identity.js";
import { DIRECTOR_REGISTRY } from "../agent/directors/registry.js";
import type { DirectorId } from "../agent/directors/types.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import { getValidCodexToken } from "../auth/codex/session.js";
import { refreshCodexInstructions } from "../auth/codex/instructions.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import {
  advertisedToolNamesForSessionMode,
  advertisedTools,
  createActivatedToolTracker,
  type ToolAvailability,
} from "../agent/tool-search.js";
import { detectLanguageServerAvailable } from "../agent/lsp-availability.js";
import { normalizeToolDefinitionsForProvider } from "../agent/tool-schema-normalize.js";
import { resolveSessionMode, type SessionMode } from "../config/session-mode.js";
import { createSubAgentSessionStore, type SubAgentProvider } from "../subagent/index.js";
import type {
  ContextStore,
  InferenceSource,
  ToolDefinition,
  InboundMessage,
} from "@intx/types/runtime";
import { OPERATOR_ORIGINATED_FLAG } from "../agent/message-provenance.js";
import { createChatDirector } from "../agent/director.js";
import { loadAgentProfiles } from "../agent/profiles.js";
import { createPermissionGate } from "../permission/gate.js";
import { createApprovalLog } from "../permission/approval-log.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import type { ApprovalOutcome, PermissionRequest } from "../permission/types.js";
import { createAgentToolset, type AgentToolset, type OperatorResult } from "../agent/tools.js";
import { createAgentWithLiveToolDispatch } from "../agent/live-tool-dispatch.js";
import { liveTelemetry } from "../telemetry/singleton.js";
import { createTurnObserver } from "../telemetry/ai-observability.js";
import { collectToolPlugins, resolveToolPlugins } from "../plugins/tool-plugins.js";
import {
  expandExistingPluginMembers,
  formatExpandSkip,
  type ExpandPluginPathSkip,
} from "../plugins/loader.js";
import { isPluginTrusted, loadProjectTrust } from "../trust/project-trust.js";
import {
  isPathPluginTrusted,
  migratePathTrustFromPluginPaths,
  reportPathTrustMigration,
} from "../trust/path-trust.js";
import { consumeStream } from "../session/stream-consumer.js";
import { createCycleTextRecorder } from "../session/stream-journal.js";
import {
  generateSessionId,
  initSessionDir,
  sessionContextDir,
  sessionDir,
} from "../session/index.js";
import { saveState, type ConnectedMcpServer } from "../session/state.js";
import { createRunSink, resolveExecRunStatus, type RunSink } from "../session/run-sink.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
} from "../session/hooks.js";
import {
  buildSessionSourcesFromConfig,
  buildSubAgentProvider,
  createApprovalPersist,
  createSessionPruningCompactor,
  discoverSessionPlugins,
  loadSeededApprovals,
  loadSessionChatPrompt,
  skillDirsFromEnabledPlugins,
} from "../session/runtime-assembly.js";
import { createPluginLoadDiagnostics, emitPluginWarningSummary } from "../plugins/diagnostics.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { createModelSummarizer } from "../session/summarizer.js";
import { ID_PREFIX, LOG_NAMESPACE_ROOT } from "../branding.js";
import type { ReactorEmittedEvent } from "@intx/inference";
import { setAgentSourceUnlessClosed } from "../tui/agent-source-sync.js";
import { getToolApprovalBudget } from "../tui/tool-execution-watchdog.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "exec"]);

/** Normalize unknown catch values for structured warn/error logs. */
export function formatCaughtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Exec-primary director overlay. Omit / skywalker keep the product default
 * (`loadSessionChatPrompt` + advertised session tools). Any other closed-fleet
 * id uses the package prompt and allowlist. Worker effort/nudge are not applied.
 */
export interface ExecDirectorOverlay {
  /** Package system prompt; omitted on the skywalker default path. */
  systemPrompt?: string;
  /** `pkg.tools.allow` (task stripped when `maySpawn` is false). */
  advertisedAllow?: readonly string[];
  mountTask: boolean;
}

export function resolveExecDirectorOverlay(director: DirectorId | undefined): ExecDirectorOverlay {
  if (director === undefined || director === "skywalker") {
    return { mountTask: true };
  }
  const pkg = DIRECTOR_REGISTRY[director];
  const allow = pkg.tools?.allow;
  const advertisedAllow =
    allow !== undefined && allow.length > 0
      ? pkg.spawn.maySpawn
        ? [...allow]
        : allow.filter((name) => name !== "task")
      : undefined;
  return {
    systemPrompt: formatDirectorSystemPrompt(pkg),
    ...(advertisedAllow !== undefined ? { advertisedAllow } : {}),
    mountTask: pkg.spawn.maySpawn,
  };
}

/** Content-less inbound used after compact so the reactor re-enters (matches TUI). */
export function buildCompactionContinuationMessage(): InboundMessage {
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

/**
 * Build the inbound message for exec's one genuine operator input: the
 * initial task supplied on the command line. Carries
 * OPERATOR_ORIGINATED_FLAG so director.ts's loop-protection backstop can
 * tell this apart from system-originated sends.
 */
function operatorTaskMessage(task: string): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<${crypto.randomUUID()}@local>`,
      interchangeType: "conversation.message",
    },
    flags: [OPERATOR_ORIGINATED_FLAG],
    content: task,
    signatureStatus: "missing",
  };
}

export interface ExecResult {
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
}

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
  let runSink: RunSink | null = null;

  const persist = async (
    status: "running" | "done" | "failed" | "cancelled",
    extra?: { error?: string },
  ): Promise<void> => {
    if (finalized && status === "running") return;
    if (status !== "running") finalized = true;
    await saveState(config.cwd, sessionId, {
      status,
      turnsUsed: runSink?.getTurnCount() ?? turnsUsed,
      task,
      startedAt,
      model: `${config.providerName}:${config.model}`,
      mcpServers: connectedMcp,
      ...(status !== "running" ? { finishedAt: Date.now() } : {}),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
    }).catch((err: unknown) => {
      // Persistence failure must not fail the run, but dropping it silently
      // hides disk/permission problems that leave run.json stale.
      logger.warn("saveState failed for session {sessionId} status={status}: {error}", {
        sessionId,
        status,
        error: formatCaughtError(err),
      });
    });
  };

  await persist("running");

  try {
    const inferenceDeps = await createInferenceDependencies();
    await seedPricingMetadataFromCache({ cachePath: defaultPricingCachePath() }).catch(
      (err: unknown) => {
        // Pricing seed is optional for exec; continue without rates rather than fail the run.
        logger.debug("seedPricingMetadataFromCache failed: {error}", {
          error: formatCaughtError(err),
        });
      },
    );

    const projectTrust = await loadProjectTrust(config.cwd);
    const isProjectPluginTrusted = (pluginPath: string) =>
      isPluginTrusted(projectTrust, pluginPath);
    // One-shot migration only when the path-trust file does not exist yet.
    // Headless exec has no frame to corrupt, so a skipped marketplace member
    // writes straight to stderr here — an explicit choice at this call site,
    // not `expandPluginPath` falling back to it on its own.
    const pathTrust = await migratePathTrustFromPluginPaths(
      config.settings?.pluginPaths ?? [],
      (p) =>
        expandExistingPluginMembers(p, config.cwd, (skip: ExpandPluginPathSkip) => {
          process.stderr.write(`plugins: ${formatExpandSkip(skip)}\n`);
        }),
      undefined,
      { onMigrated: reportPathTrustMigration },
    );
    const isRegisteredPathTrusted = (pluginPath: string) =>
      isPathPluginTrusted(pathTrust, pluginPath);
    const pluginLoadDiag = createPluginLoadDiagnostics();
    const pluginModules = await discoverSessionPlugins({
      cwd: config.cwd,
      ...(config.settings?.pluginPaths !== undefined
        ? { pluginPaths: config.settings.pluginPaths }
        : {}),
      ...(config.settings?.discoverClaudePlugins !== undefined
        ? { discoverClaudePlugins: config.settings.discoverClaudePlugins }
        : {}),
      isProjectPluginTrusted,
      isRegisteredPathTrusted,
      diagnostics: pluginLoadDiag,
      telemetry: liveTelemetry,
    });
    emitPluginWarningSummary(pluginLoadDiag, (line) => logger.warn(line));
    // Metadata-only (untrusted) modules stay out of executable plugins.
    const executablePlugins = () => pluginModules.filter((m) => m.metadataOnly !== true);
    const pluginConfig = config.settings?.plugins ?? {};

    const toolPluginCandidates = collectToolPlugins(executablePlugins());
    const extraToolPlugins = await resolveToolPlugins({
      candidates: toolPluginCandidates,
      pluginConfig,
    });

    const skillDirs = skillDirsFromEnabledPlugins(executablePlugins(), pluginConfig);

    const profilesDir = join(config.cwd, ".agents", "agents");
    const liveAgentProfiles = await loadAgentProfiles(profilesDir);

    // loadLocalSettings maps ENOENT → null; a throw is real I/O or schema failure.
    const localSettingsForModePath = resolveLocalSettingsPath(
      config.cwd,
      config.globalSettingsPath,
    );
    const localSettingsForMode =
      localSettingsForModePath === null
        ? null
        : await loadLocalSettings(localSettingsForModePath).catch((err: unknown) => {
            logger.warn("Failed to load local settings: {error}", {
              error: formatCaughtError(err),
            });
            return null;
          });
    const sessionMode: SessionMode =
      resolveSessionMode(config.settings, localSettingsForMode) ?? "orchestrator";

    const seededApprovals = await loadSeededApprovals(config.cwd, sessionId);

    const interactive = input.isTTY === true && output.isTTY === true;

    if (config.skipPermissionsFromSettings) {
      stderr.write(
        "Warning: permission prompts are disabled by your saved default (/yolo off to re-enable).\n",
      );
    }

    const permissionGate = createPermissionGate({
      approvals: seededApprovals,
      telemetry: liveTelemetry,
      cwd: config.cwd,
      rootsProvider: createWorktreeRootsProvider(config.cwd),
      providerName: config.providerName,
      model: config.model,
      requestApproval: (request: PermissionRequest): Promise<ApprovalOutcome> =>
        promptPermission(request, interactive),
      persist: createApprovalPersist(config.cwd, () => `${config.providerName}:${config.model}`),
      approvalLog: createApprovalLog(sessionDir(config.cwd, sessionId)),
      interactive,
      skipPermissions: config.dangerouslySkipPermissions,
      auto: config.auto,
    });

    const liveSubAgentProvider: { current: SubAgentProvider } = {
      current: buildSubAgentProvider(config),
    };
    const subAgentSessions = createSubAgentSessionStore();
    const shellTimeout = shellTimeoutFromSettings(config.settings);
    const toolWatchdog = toolWatchdogFromSettings(config.settings);
    const toolAvailability: ToolAvailability = {
      languageServerAvailable: detectLanguageServerAvailable(config.cwd),
    };

    let currentAgent: Agent | null = null;
    let currentStorage: ContextStore | null = null;

    const overlay = resolveExecDirectorOverlay(config.director);

    const agentToolset = await createAgentToolset({
      cwd: config.cwd,
      permissionGate,
      skillDirs,
      telemetry: liveTelemetry,
      isCodex: isCodexProviderName(config.providerName),
      ...(shellTimeout !== undefined ? { shellTimeout } : {}),
      ...(toolWatchdog !== undefined ? { toolWatchdog } : {}),
      ...(localSettingsForMode?.env !== undefined ? { shellEnv: localSettingsForMode.env } : {}),
      getBlobWriter: () => currentStorage?.writeBlob,
      getContextDir: () => workdir,
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
      toolAvailability,
      ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
      mcpServersSource: config.mcpServersSource ?? "none",
      projectTrust,
      requestMcpTrust: async (server) => {
        if (!interactive) return false;
        const result = await promptOperator(
          `Trust local MCP server "${server.name}" for this project?` +
            (server.command !== undefined
              ? `\nCommand: ${server.command}`
              : server.url !== undefined
                ? `\nURL: ${server.url}`
                : ""),
          ["Trust and connect", "Deny"],
          true,
        );
        return result.kind === "option" && result.index === 0;
      },
      ...(overlay.mountTask
        ? {
            subAgent: {
              provider: () => liveSubAgentProvider.current,
              sessions: subAgentSessions,
              getWorkdirBase: () => sessionDir(config.cwd, sessionId),
              onProgress: () => undefined,
              ...(config.settings !== undefined ? { settings: () => config.settings! } : {}),
              catalog: () => config.providers,
              profiles: () => liveAgentProfiles,
            },
          }
        : {}),
      ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
    });
    toolset = agentToolset;

    const systemPrompt =
      overlay.systemPrompt ??
      (
        await loadSessionChatPrompt({
          cwd: config.cwd,
          skillDirs,
          ...(config.systemPromptExtensions !== undefined
            ? { systemPromptExtensions: config.systemPromptExtensions }
            : {}),
          sessionMode,
          toolAvailability,
        })
      ).systemPrompt;

    const advertisedBuiltInPrefix =
      overlay.advertisedAllow ?? advertisedToolNamesForSessionMode(sessionMode, toolAvailability);
    const activatedToolNames = createActivatedToolTracker();
    // Advertise then family-gate wire schemas (kimi gets a non-recursive present).
    const computeAdvertised = (all: readonly ToolDefinition[]): ToolDefinition[] =>
      normalizeToolDefinitionsForProvider(
        advertisedTools(all, activatedToolNames.list(), advertisedBuiltInPrefix),
        { providerName: config.providerName, model: config.model },
      );

    const directorHolder: { instance?: ReturnType<typeof createChatDirector> } = {};

    const chatDirectorDef = defineDirector({
      id: `${ID_PREFIX}/chat`,
      configSchema: type({}),
      factory: (_cfg, _env, agentCtx) => {
        const d = createChatDirector(
          agentCtx.systemPrompt,
          computeAdvertised([...agentCtx.toolDefinitions]),
          {
            onActivateTools: (names) => {
              if (!activatedToolNames.activate(names)) return;
              directorHolder.instance?.updateToolDefinitions(
                computeAdvertised(agentToolset.dynamicRunner.currentDefinitions()),
              );
            },
            inactivityTimeoutMs: config.inactivityTimeoutMs ?? 750_000,
            totalTimeoutMs: config.totalTimeoutMs,
            // Exec mode has no live task panel or task stdout output today (unlike
            // the TUI's chrome zone) — debug logging is the closest match to how
            // this mode already surfaces other in-session state changes.
            onTasksChange: (tasks) => {
              logger.debug("tasks updated: {tasks}", {
                tasks: tasks.map((t) => `${t.status}:${t.title}`).join(", "),
              });
            },
            requestContinuation: () => {
              // Compaction governor self-delivers after compact so the loop re-enters.
              currentAgent?.deliver(buildCompactionContinuationMessage());
            },
            provider: { providerName: config.providerName, model: config.model },
          },
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
      buildSessionSourcesFromConfig(config, sessionId);

    const initialBundle = buildSessionSources();
    const liveSources = initialBundle.sources;
    const liveDefaultSource = initialBundle.defaultSource;

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
              sessionId,
              ...(config.reasoningEffort !== undefined
                ? { reasoningEffort: config.reasoningEffort }
                : {}),
            })
          : buildOpenAICompatibleInitialSource();

    let liveSource: InferenceSource =
      liveSources.find((s) => s.id === liveDefaultSource) ??
      liveSources[0] ??
      buildInitialSourceFallback();

    // Refresh pinned Codex instructions before first inference, same as the
    // TUI path. Best-effort: a network failure falls back to the disk cache
    // or bundled copy without failing the run. Exec is one-shot (no long-lived
    // session to catch up later), so this is awaited rather than fire-and-forget.
    if (initialCodexProfile !== undefined) {
      await refreshCodexInstructions().catch((err: unknown) => {
        logger.warn("Codex instructions refresh failed: {error}", {
          error: formatCaughtError(err),
        });
      });
    }

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
      currentStorage = storage;
      const sources = liveSources.length > 0 ? liveSources : [liveSource];
      const defaultSource = liveDefaultSource.length > 0 ? liveDefaultSource : liveSource.id;
      // Prefer liveSource credentials on the active id when OAuth was refreshed.
      const withLiveCreds = sources.map((s) =>
        s.id === liveSource.id ? { ...s, apiKey: liveSource.apiKey } : s,
      );
      return createAgentWithLiveToolDispatch(def, {
        sources: withLiveCreds,
        defaultSource,
        storage,
        workdir,
        // contextTransforms ride deps: the published @intx/agent forwards
        // deps into reactor assembly verbatim, and the vendored assembly
        // picks the transforms up from there.
        deps: {
          ...inferenceDeps,
          contextTransforms: [createAttachmentRehydrateTransform((key) => storage.readBlob(key))],
        },
        audit: noopAuditStore(),
        authorize: permissiveAuthorize(),
        directors: createDirectorRegistry({
          factories: [chatDirectorDef.factory],
          defaultId: `${ID_PREFIX}/chat`,
        }),
        compactors: {
          "pruning-compactor": createSessionPruningCompactor({
            compactionMode: liveCompactionMode,
            summarize: summarizeForCompaction,
            telemetry: liveTelemetry,
          }),
        },
      });
    };

    const emitter = new EventEmitter();
    const hookManager = createLifecycleHookManager({
      hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
    });
    const turnObserver = createTurnObserver({
      telemetry: () => liveTelemetry,
      getSessionId: () => sessionId,
      getSource: () => liveSource,
    });
    const liveSink = createRunSink({
      emitter,
      hookManager,
      ...turnObserver,
      onTurnBoundarySnapshot: () => {
        void persist("running");
      },
    });
    runSink = liveSink;

    currentAgent = await buildAgent();
    agent = currentAgent;
    // Local non-null handle after init (currentAgent stays mutable for compaction deliver).
    const activeAgent = currentAgent;

    if (agentToolset.connectMCP !== undefined) {
      await agentToolset
        .connectMCP({
          interactiveAuth: false,
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
    const cycleRecorder = createCycleTextRecorder(() => workdir);
    const sink = (event: ReactorEmittedEvent): void => {
      liveSink.sink(event);
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
    let sinkStatus: ReturnType<typeof liveSink.getStatus> = "cancelled";
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
      await activeAgent.send(operatorTaskMessage(task));
      sendCompleted = true;
      runError = runSink.getRunError();
      sinkStatus = runSink.getStatus();
    } finally {
      if (sendCompleted && runSink.getRunError() === undefined) {
        // Successful send: the final cycle's inference.done is queued on the
        // stream but may not have reached the sink yet (send resolves on the
        // connector reply). Drain BEFORE disposing so the done event resets
        // the buffer — dispose snapshots at entry and would otherwise write
        // the entire successful reply as a spurious partial. After the drain,
        // dispose is a no-op on success and a real record only if a cycle
        // died without a terminal event.
        await activeAgent.close().catch((err: unknown) => {
          logger.debug("agent.close during successful-send teardown failed: {error}", {
            error: formatCaughtError(err),
          });
        });
        await streamPromise.catch((err: unknown) => {
          logger.debug("stream drain during successful-send teardown failed: {error}", {
            error: formatCaughtError(err),
          });
        });
        await cycleRecorder.dispose("cancelled");
      } else {
        // Failed or aborted send: close() tears down stream consumers before
        // the dead cycle's inference.error is delivered, so dispose (which
        // snapshots the buffer at entry) runs before closing or the text is
        // lost.
        await cycleRecorder.dispose(sendCompleted ? "cancelled" : "send-failed");
        await activeAgent.close().catch((err: unknown) => {
          logger.debug("agent.close during failed-send teardown failed: {error}", {
            error: formatCaughtError(err),
          });
        });
        await streamPromise.catch((err: unknown) => {
          logger.debug("stream drain during failed-send teardown failed: {error}", {
            error: formatCaughtError(err),
          });
        });
      }
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
    await hookManager.dispatchPostRun(runSummary).catch((err: unknown) => {
      // Post-run hooks are best-effort; keep the exec exit path intact but
      // surface the failure so operators can see hook/script problems.
      const message = formatCaughtError(err);
      logger.warn("dispatchPostRun failed: {error}", { error: message });
      stderr.write(`Warning: post-run hook failed: ${message}\n`);
    });

    if (!sendCompleted || runError !== undefined || summaryStatus === "failed") {
      const message =
        runError ??
        (summaryStatus === "cancelled" ? "run cancelled before completion" : "run failed");
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
      turnsUsed: runSink?.getTurnCount() ?? turnsUsed,
      toolCallCount: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      provider: config.providerName,
      model: config.model,
    };
  } finally {
    if (agent !== null) {
      await agent.close().catch((err: unknown) => {
        logger.debug("agent.close during exec finally failed: {error}", {
          error: formatCaughtError(err),
        });
      });
    }
    // Match TUI: always dispose toolset (MCP clients + posix/plugin resources).
    if (toolset !== null) {
      await toolset.dispose().catch((err: unknown) => {
        logger.debug("toolset.dispose during exec finally failed: {error}", {
          error: formatCaughtError(err),
        });
      });
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
