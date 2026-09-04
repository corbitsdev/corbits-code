// Main-session runtime assembly shared by runTUI and runExec.
//
// Layered assemblers, one per near-verbatim bootstrap block both entry points
// used to hand-wire separately. The runners keep only their genuinely distinct
// surface (TUI chrome, exec I/O, sub-agent stops) and consume these for the
// rest. A new config-derived runtime dependency is a one-site change: read it
// from `config` inside the assembler that owns the block, instead of touching
// every entry point.
//
// runSubAgent consumes the same layer-1 primitives (inference deps, pricing
// seed, context store, attachment transform, summarizer, cycle recorder,
// compaction continuation) but keeps its own tool/director stack — posix tools
// and SubAgentDirector share nothing with the main-session toolset, so
// unifying further would be abstraction for its own sake.

import type { EventEmitter } from "node:events";
import {
  createDirectorRegistry,
  defineAgent,
  defineDirector,
  defineTool,
  type Agent,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import type { Compactor, ContextStore, InferenceSource, ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import { ID_PREFIX } from "../branding.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import {
  loadLocalSettings,
  resolveLocalSettingsPath,
  type LocalSettings,
} from "../config/settings.js";
import type { SessionMode } from "../config/session-mode.js";
import {
  advertisedTools,
  advertisedToolNamesForSessionMode,
  createActivatedToolTracker,
  type ActivatedToolTracker,
  type ToolAvailability,
} from "../agent/tool-search.js";
import { normalizeToolDefinitionsForProvider } from "../agent/tool-schema-normalize.js";
import { createChatDirector, type ChatDirector } from "../agent/director.js";
import type { Task } from "../agent/tasks.js";
import type { AgentToolset } from "../agent/tools.js";
import { createAgentWithLiveToolDispatch } from "../agent/live-tool-dispatch.js";
import { createOptimizedContextStore } from "./optimized-context-store.js";
import { createAttachmentRehydrateTransform } from "./attachment-store.js";
import {
  loadProjectTrust,
  isPluginTrusted,
  type ProjectTrustStore,
} from "../trust/project-trust.js";
import {
  migratePathTrustFromPluginPaths,
  reportPathTrustMigration,
  isPathPluginTrusted,
  type PathTrustStore,
} from "../trust/path-trust.js";
import {
  expandExistingPluginMembers,
  type ExpandPluginPathSkip,
  type PluginModule,
} from "../plugins/loader.js";
import type { PluginLoadDiagnostics } from "../plugins/diagnostics.js";
import { createPluginLoadDiagnostics } from "../plugins/diagnostics.js";
import {
  createPermissionGate,
  type PermissionGate,
  type PermissionGateOptions,
} from "../permission/gate.js";
import type { Approval, RequestApproval } from "../permission/types.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import { createApprovalLog } from "../permission/approval-log.js";
import { sessionDir } from "./index.js";
import type { Telemetry } from "../telemetry/index.js";
import { createTurnObserver } from "../telemetry/ai-observability.js";
import {
  createLifecycleHookManager,
  discoverLifecycleHooks,
  hookDirectories,
  type LifecycleHookEvent,
  type LifecycleHookManager,
} from "./hooks.js";
import { createRunSink, type RunSink } from "./run-sink.js";
import { createCycleTextRecorder, type CycleTextRecorder } from "./stream-journal.js";
import {
  buildSessionSourcesFromConfig,
  createApprovalPersist,
  discoverSessionPlugins,
  loadSeededApprovals,
  type MainSessionSourceConfig,
} from "./runtime-assembly.js";

// ---------------------------------------------------------------------------
// 1. Inference base: inference deps + pricing seed
// ---------------------------------------------------------------------------

/**
 * Resolve inference dependencies and re-read the pricing cache. The seed is
 * best-effort in long-lived entry points; a one-shot runner passes onError to
 * log and continue instead. Without onError a seed failure rejects, matching
 * the previous TUI boot behavior.
 */
export async function assembleInferenceBase(
  onPricingError?: (err: unknown) => void,
): Promise<Awaited<ReturnType<typeof createInferenceDependencies>>> {
  const inferenceDeps = await createInferenceDependencies();
  const seed = seedPricingMetadataFromCache({ cachePath: defaultPricingCachePath() });
  if (onPricingError === undefined) {
    await seed;
  } else {
    await seed.catch((err: unknown) => {
      onPricingError(err);
    });
  }
  return inferenceDeps;
}

// ---------------------------------------------------------------------------
// 2. Trust + plugin discovery
// ---------------------------------------------------------------------------

export interface SessionTrustArgs {
  cwd: string;
  pluginPaths?: string[] | undefined;
  discoverClaudePlugins?: boolean | undefined;
  /** Reached for every skipped marketplace member during path expansion. */
  onExpandSkip: (skip: ExpandPluginPathSkip) => void;
  /** Reused when the caller must observe the same batch (startup summary). */
  diagnostics?: PluginLoadDiagnostics | undefined;
  telemetry?: Telemetry | undefined;
}

export interface SessionTrust {
  projectTrust: ProjectTrustStore;
  pathTrust: PathTrustStore;
  pluginModules: PluginModule[];
  /** Diagnostics batch the discovery wrote into (created when not provided). */
  diagnostics: PluginLoadDiagnostics;
  isProjectPluginTrusted: (pluginPath: string) => boolean;
  isRegisteredPathTrusted: (pluginPath: string) => boolean;
}

/**
 * Load project trust, run the one-shot path-trust migration, and discover
 * plugins. Untrusted origins load metadata-only, identically for both
 * runners — only the skip channel differs (diagnostics batch vs stderr).
 */
export async function assembleSessionTrust(args: SessionTrustArgs): Promise<SessionTrust> {
  const projectTrust = await loadProjectTrust(args.cwd);
  const pathTrust = await migratePathTrustFromPluginPaths(
    args.pluginPaths ?? [],
    (p) => expandExistingPluginMembers(p, args.cwd, args.onExpandSkip),
    undefined,
    { onMigrated: reportPathTrustMigration },
  );
  const isProjectPluginTrusted = (pluginPath: string) => isPluginTrusted(projectTrust, pluginPath);
  const isRegisteredPathTrusted = (pluginPath: string) =>
    isPathPluginTrusted(pathTrust, pluginPath);
  // Created lazily so callers without an earlier batch (exec) share the same
  // diagnostics object discovery writes into.
  const diagnostics = args.diagnostics ?? createPluginLoadDiagnostics();
  const pluginModules = await discoverSessionPlugins({
    cwd: args.cwd,
    pluginPaths: args.pluginPaths,
    discoverClaudePlugins: args.discoverClaudePlugins,
    isProjectPluginTrusted,
    isRegisteredPathTrusted,
    diagnostics,
    telemetry: args.telemetry,
  });
  return {
    projectTrust,
    pathTrust,
    pluginModules,
    diagnostics,
    isProjectPluginTrusted,
    isRegisteredPathTrusted,
  };
}

// ---------------------------------------------------------------------------
// 3. Local settings (shell env source)
// ---------------------------------------------------------------------------

/**
 * Load repo-local settings for shell env (and exec's session-mode read).
 * ENOENT maps to null; real I/O or schema failures reach onError when set, then
 * always return null — matching origin TUI silent catch.
 */
export async function loadSessionLocalSettings(args: {
  cwd: string;
  globalSettingsPath: string;
  onError?: (err: unknown) => void;
}): Promise<LocalSettings | null> {
  const path = resolveLocalSettingsPath(args.cwd, args.globalSettingsPath);
  if (path === null) return null;
  return loadLocalSettings(path).catch((err: unknown) => {
    args.onError?.(err);
    return null;
  });
}

// ---------------------------------------------------------------------------
// 4. Permission gate
// ---------------------------------------------------------------------------

export interface SessionGateArgs {
  cwd: string;
  sessionId: string;
  providerName?: string | undefined;
  model?: string | undefined;
  telemetry?: Telemetry | undefined;
  requestApproval: RequestApproval;
  /** Read at persist time so a live model switch stores under the pair in use. */
  getActiveProviderModel: () => string;
  onPersistNotice?: ((text: string) => void) | undefined;
  interactive: boolean;
  skipPermissions: boolean;
  auto?: boolean | undefined;
  onGrant?: PermissionGateOptions["onGrant"] | undefined;
}

export interface SessionGate {
  gate: PermissionGate;
  seededApprovals: Approval[];
}

/**
 * Seed approvals (session → project → global → provider-model) and build the
 * permission gate over roots, persist, and log wiring. The runners differ
 * only in how approval reaches an operator (modal vs stdin) and whether
 * grants are re-emitted — both arrive as callbacks.
 */
export async function assembleSessionGate(args: SessionGateArgs): Promise<SessionGate> {
  const seededApprovals = await loadSeededApprovals(args.cwd, args.sessionId);
  const gate = createPermissionGate({
    approvals: seededApprovals,
    telemetry: args.telemetry,
    cwd: args.cwd,
    rootsProvider: createWorktreeRootsProvider(args.cwd),
    providerName: args.providerName,
    model: args.model,
    requestApproval: args.requestApproval,
    persist: createApprovalPersist(args.cwd, args.getActiveProviderModel, args.onPersistNotice),
    approvalLog: createApprovalLog(sessionDir(args.cwd, args.sessionId)),
    interactive: args.interactive,
    skipPermissions: args.skipPermissions,
    auto: args.auto,
    onGrant: args.onGrant,
  });
  return { gate, seededApprovals };
}

// ---------------------------------------------------------------------------
// 5. Live inference sources
// ---------------------------------------------------------------------------

export interface LiveSessionSources {
  sources: InferenceSource[];
  defaultSource: string;
  /** First source — the run fails closed when assembly produced none. */
  selected: InferenceSource;
}

/**
 * Build main-session sources and resolve the selected one. Both runners threw
 * the same error on an empty bundle; the TUI rebuild paths reuse this too.
 */
export function resolveLiveSessionSources(
  config: MainSessionSourceConfig,
  sessionId: string,
): LiveSessionSources {
  const { sources, defaultSource } = buildSessionSourcesFromConfig(config, sessionId);
  const selected = sources[0];
  if (selected === undefined) {
    throw new Error("Selected inference source was not assembled");
  }
  return { sources, defaultSource, selected };
}

// ---------------------------------------------------------------------------
// 6. Advertised toolset (prefix + activation + family gating)
// ---------------------------------------------------------------------------

export interface AdvertisedToolset {
  activated: ActivatedToolTracker;
  computeAdvertised: (all: readonly ToolDefinition[]) => ToolDefinition[];
}

/**
 * Fixed built-in prefix plus session-activated tools, family-gated for the
 * wire. The provider identity is read per call so a live model switch
 * re-gates without rebuilding the agent.
 */
export function createAdvertisedToolset(args: {
  sessionMode: SessionMode;
  toolAvailability: ToolAvailability;
  getProvider: () => { providerName: string; model: string };
  builtInPrefix?: readonly string[] | undefined;
}): AdvertisedToolset {
  const prefix =
    args.builtInPrefix ??
    advertisedToolNamesForSessionMode(args.sessionMode, args.toolAvailability);
  const activated = createActivatedToolTracker();
  // Advertise then family-gate wire schemas (kimi gets a non-recursive present).
  const computeAdvertised = (all: readonly ToolDefinition[]): ToolDefinition[] =>
    normalizeToolDefinitionsForProvider(advertisedTools(all, activated.list(), prefix), {
      ...args.getProvider(),
    });
  return { activated, computeAdvertised };
}

// ---------------------------------------------------------------------------
// 7. Chat agent: director def, agent def, live builder
// ---------------------------------------------------------------------------

export interface ChatAgentWiring {
  toolsId: string;
  agentId: string;
  systemPrompt: string;
  getDynamicRunner: () => AgentToolset["dynamicRunner"];
  computeAdvertised: (all: readonly ToolDefinition[]) => ToolDefinition[];
  activateTools: (names: readonly string[]) => boolean;
  /** Fires after the standard activate + director-update handling. */
  onToolsPromoted?: () => void;
  inactivityTimeoutMs: number;
  totalTimeoutMs?: number | undefined;
  onTasksChange: (tasks: Task[]) => void;
  /** Compaction governor re-entry (the reactor emits no event after compact). */
  requestContinuation: () => void;
  getProvider: () => { providerName: string; model: string };
  getProviderId?: (() => string | undefined) | undefined;
  /** Pre-created holder so the workflow controller can close over it first. */
  directorHolder?: { instance?: ChatDirector };
  /** Read at each build so /clear and workdir rotation use the live store path. */
  getWorkdir: () => string;
  inferenceDeps: Awaited<ReturnType<typeof createInferenceDependencies>>;
  getSources: () => InferenceSource[];
  getDefaultSource: () => string;
  /** Read at each build so a compaction-mode toggle is visible on rebuild. */
  getCompactor: () => Compactor;
  /** Assigns the runner's live agent/storage holders; keeps call sites unchanged. */
  onBuilt: (agent: Agent, storage: ContextStore) => void;
}

export interface AssembledChatAgent {
  directorHolder: { instance?: ChatDirector };
  /** Builds the agent and reports it through onBuilt; resolves the agent. */
  buildAgent: () => Promise<Agent>;
}

/**
 * Define the chat director + agent and build live instances against the
 * git-backed store. Identical for both runners: the TUI-only deltas
 * (workflow-aware toolset, emitter gates, reload scheduling) arrive as
 * callbacks, and the agent freezes tool dispatch per build in both.
 */
export function assembleChatAgent(wiring: ChatAgentWiring): AssembledChatAgent {
  const directorHolder = wiring.directorHolder ?? {};
  const chatDirectorDef = defineDirector({
    id: `${ID_PREFIX}/chat`,
    configSchema: type({}),
    factory: (_cfg, _env, agentCtx) => {
      const d = createChatDirector(
        agentCtx.systemPrompt,
        wiring.computeAdvertised([...agentCtx.toolDefinitions]),
        {
          onActivateTools: (names) => {
            if (!wiring.activateTools(names)) return;
            directorHolder.instance?.updateToolDefinitions(
              wiring.computeAdvertised(wiring.getDynamicRunner().currentDefinitions()),
            );
            wiring.onToolsPromoted?.();
          },
          inactivityTimeoutMs: wiring.inactivityTimeoutMs,
          totalTimeoutMs: wiring.totalTimeoutMs,
          onTasksChange: wiring.onTasksChange,
          requestContinuation: wiring.requestContinuation,
          provider: { ...wiring.getProvider() },
          getProviderId: wiring.getProviderId,
        },
      );
      directorHolder.instance = d;
      return d;
    },
  });

  const toolsFactory = defineTool({
    id: wiring.toolsId,
    factory: () => wiring.getDynamicRunner(),
  });

  const provider = wiring.getProvider();
  const agentDef = defineAgent({
    id: wiring.agentId,
    systemPrompt: wiring.systemPrompt,
    tools: [toolsFactory],
    capabilities: [],
    director: chatDirectorDef.build({}),
    inference: {
      sources: [{ provider: provider.providerName, model: provider.model }],
    },
  });

  const buildAgent = async (): Promise<Agent> => {
    const workdir = wiring.getWorkdir();
    const storage = await createOptimizedContextStore(workdir);
    const agent = await createAgentWithLiveToolDispatch(agentDef, {
      sources: wiring.getSources(),
      defaultSource: wiring.getDefaultSource(),
      storage,
      workdir,
      // contextTransforms ride deps: the published @intx/agent forwards deps
      // into reactor assembly verbatim, and the vendored assembly picks the
      // transforms up from there.
      deps: {
        ...wiring.inferenceDeps,
        contextTransforms: [createAttachmentRehydrateTransform((key) => storage.readBlob(key))],
      },
      audit: noopAuditStore(),
      authorize: permissiveAuthorize(),
      directors: createDirectorRegistry({
        factories: [chatDirectorDef.factory],
        defaultId: `${ID_PREFIX}/chat`,
      }),
      compactors: {
        "pruning-compactor": wiring.getCompactor(),
      },
    });
    wiring.onBuilt(agent, storage);
    return agent;
  };

  return { directorHolder, buildAgent };
}

// ---------------------------------------------------------------------------
// 8. Lifecycle: hooks, turn observer, run sink, cycle recorder
// ---------------------------------------------------------------------------

export interface SessionLifecycleWiring {
  cwd: string;
  emitter: EventEmitter;
  getTelemetry: () => Telemetry;
  getSessionId: () => string;
  getSource: () => InferenceSource;
  initialTurnCount?: number | undefined;
  onTurnBoundarySnapshot: () => void;
  hookEnabled?: Record<string, boolean> | undefined;
  onHookEvent?: ((event: LifecycleHookEvent) => void) | undefined;
  resolveContextDir: () => string;
}

export interface SessionLifecycle {
  hookManager: LifecycleHookManager;
  turnObserver: ReturnType<typeof createTurnObserver>;
  runSink: RunSink;
  cycleRecorder: CycleTextRecorder;
}

/**
 * Hook manager, turn observer, run sink, and in-flight cycle recorder. Pure
 * construction — safe to assemble before the agent exists, since every live
 * value (session id, source, context dir) is read through a getter at event
 * time. That is what lets the TUI build this once, early, while exec builds
 * it late: same call, different position.
 */
export async function assembleSessionLifecycle(
  wiring: SessionLifecycleWiring,
): Promise<SessionLifecycle> {
  const hookManager = createLifecycleHookManager({
    hooks: await discoverLifecycleHooks(hookDirectories(wiring.cwd)),
    initialEnabled: wiring.hookEnabled,
    onEvent: wiring.onHookEvent,
  });
  const turnObserver = createTurnObserver({
    telemetry: wiring.getTelemetry,
    getSessionId: wiring.getSessionId,
    getSource: wiring.getSource,
  });
  const runSink = createRunSink({
    emitter: wiring.emitter,
    hookManager,
    initialTurnCount: wiring.initialTurnCount,
    onTurnStarted: turnObserver.onTurnStarted,
    onTurnSourceObserved: turnObserver.onTurnSourceObserved,
    onTurnComplete: turnObserver.onTurnComplete,
    onTurnFailed: turnObserver.onTurnFailed,
    onTurnBoundarySnapshot: wiring.onTurnBoundarySnapshot,
  });
  const cycleRecorder = createCycleTextRecorder(wiring.resolveContextDir);
  return { hookManager, turnObserver, runSink, cycleRecorder };
}
