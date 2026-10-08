// Main-session runtime assembly shared by runTUI and runExec: layered
// assemblers, one per bootstrap block the runners used to hand-wire
// separately. The runners keep only their distinct surface (TUI chrome, exec
// I/O, sub-agent stops). runSubAgent reuses the layer-1 primitives but keeps
// its own tool/director stack.

import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import {
  createDirectorRegistry,
  defineAgent,
  defineDirector,
  defineTool,
  type Agent,
  type AuthorizeFn,
} from "@intx/agent";
import type {
  Compactor,
  ContextStore,
  InferenceSource,
  ToolDefinition,
} from "@intx/types/runtime";
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
import { refreshProviderContextWindows } from "../config/index.js";
import type { SessionMode } from "../config/session-mode.js";
import { readSourceCredentialMaterial } from "../config/source-credentials.js";
import {
  advertisedTools,
  advertisedToolNamesForSessionMode,
  createActivatedToolTracker,
  UNADVERTISED_MOUNTED_BUILTINS,
  type ActivatedToolTracker,
  type ToolAvailability,
} from "../agent/tool-search.js";
import {
  foldFileToolNames,
  nameMatchesAdvertisedListing,
  toolProfileForModel,
  withAuthzParityDefinitions,
} from "../agent/tool-aliases.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { normalizeToolDefinitionsForProvider } from "../agent/tool-schema-normalize.js";
import { resolveModelFamilyPolicy } from "../agent/model-family-policy.js";
import {
  stickyExtraInstructionsFromRecords,
  lastCycleSourceFromRunModel,
} from "../agent/compaction.js";
import { createChatDirector, type ChatDirector } from "../agent/director.js";
import { createDoomLoopCorrectiveNote } from "../agent/doom-loop-note.js";
import type { AgentToolset } from "../agent/tools.js";
import { createAgentWithLiveToolDispatch } from "../agent/live-tool-dispatch.js";
import { createSessionStores } from "./optimized-context-store.js";
import { getActiveRun } from "./active-run.js";
import { createAttachmentRehydrateTransform } from "./attachment-store.js";
import { createAnthropicCachePromptTransform } from "./anthropic-cache-prompt.js";
import {
  applyRecordingPolicyToText,
  createCompactionArchive,
  createPrimaryDeliveryAdmission,
  hashAuthorizedBytes,
  wrapAuthorizeWithEvidenceArchive,
  wrapCompactorWithCompletenessGate,
  type CompactionArchive,
} from "./compaction-archive.js";
import path from "node:path";
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
import { userPluginsRoot } from "../plugins/uninstall.js";
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
import {
  createCycleTextRecorder,
  type CycleTextRecorder,
} from "./stream-journal.js";
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
 * best-effort: onError logs and continues; without onError, a seed failure
 * rejects. Workers pass skipPricingSeed — the parent already boot-seeded.
 */
export async function assembleInferenceBase(
  onPricingError?: (err: unknown) => void,
  opts?: { skipPricingSeed?: boolean },
): Promise<Awaited<ReturnType<typeof createInferenceDependencies>>> {
  const inferenceDeps = await createInferenceDependencies();
  if (opts?.skipPricingSeed === true) return inferenceDeps;
  const seed = seedPricingMetadataFromCache({
    cachePath: defaultPricingCachePath(),
  });
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
 * plugins. Untrusted origins load metadata-only; only the skip channel
 * differs (diagnostics batch vs stderr).
 */
export async function assembleSessionTrust(
  args: SessionTrustArgs,
): Promise<SessionTrust> {
  const projectTrust = await loadProjectTrust(args.cwd);
  const pathTrust = await migratePathTrustFromPluginPaths(
    args.pluginPaths ?? [],
    (p) => expandExistingPluginMembers(p, args.cwd, args.onExpandSkip),
    undefined,
    { onMigrated: reportPathTrustMigration },
  );
  const isProjectPluginTrusted = (pluginPath: string) =>
    isPluginTrusted(projectTrust, pluginPath);
  const isRegisteredPathTrusted = (pluginPath: string) =>
    isPathPluginTrusted(pathTrust, pluginPath);
  // Lazily created so callers without an earlier batch (exec) share one batch.
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
 * ENOENT and other failures map to null; errors report to onError when set.
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
  /**
   * First encounter with an unconfirmed project approvals file: surface what
   * it would grant (exec: stderr, TUI: persist notice). Entries stay gated
   * regardless of delivery.
   */
  onPendingProjectGrants?: ((text: string) => void) | undefined;
  interactive: boolean;
  /**
   * Fired with the deny reason when the gate denies for want of an operator
   * (see PermissionGateOptions.onHeadlessDeny). Exec writes it to stderr;
   * the TUI omits it.
   */
  onHeadlessDeny?: ((reason: string) => void) | undefined;
  skipPermissions: boolean;
  auto?: boolean | undefined;
  /** Route this gate's decisions through the reactor authz seam (main session). */
  reactorGated: boolean;
  onGrant?: PermissionGateOptions["onGrant"] | undefined;
}

export interface SessionGate {
  gate: PermissionGate;
  seededApprovals: Approval[];
}

/**
 * Seed approvals (session → project → global → provider-model) and build the
 * permission gate over roots, persist, and log wiring. Runners differ only
 * in how approval reaches an operator (modal vs stdin) — both arrive as
 * callbacks.
 */
export async function assembleSessionGate(
  args: SessionGateArgs,
): Promise<SessionGate> {
  const seededApprovals = await loadSeededApprovals(
    args.cwd,
    args.sessionId,
    undefined,
    { onPendingProjectGrants: args.onPendingProjectGrants },
  );
  const gate = createPermissionGate({
    approvals: seededApprovals,
    telemetry: args.telemetry,
    cwd: args.cwd,
    rootsProvider: createWorktreeRootsProvider(args.cwd),
    trustedPluginRoots: () => [userPluginsRoot()],
    providerName: args.providerName,
    model: args.model,
    requestApproval: args.requestApproval,
    persist: createApprovalPersist(
      args.cwd,
      args.getActiveProviderModel,
      args.onPersistNotice,
    ),
    approvalLog: createApprovalLog(sessionDir(args.cwd, args.sessionId)),
    interactive: args.interactive,
    onHeadlessDeny: args.onHeadlessDeny,
    skipPermissions: args.skipPermissions,
    auto: args.auto,
    reactorGated: args.reactorGated,
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
 * Build main-session sources and resolve the selected one. Both runners
 * threw the same error on an empty bundle; TUI rebuild paths reuse this.
 */
export function resolveLiveSessionSources(
  config: MainSessionSourceConfig,
  sessionId: string,
): LiveSessionSources {
  const { sources, defaultSource } = buildSessionSourcesFromConfig(
    config,
    sessionId,
  );
  const selected = sources[0];
  if (selected === undefined) {
    throw new Error("Selected inference source was not assembled");
  }
  // Candidates/workers must not steal the primary's bare-model overrides;
  // only the live-session rebuild updates that precedence.
  refreshProviderContextWindows(
    config.settings,
    config.providers,
    config.providerName,
    config.model,
  );
  return { sources, defaultSource, selected };
}

// ---------------------------------------------------------------------------
// 6. Advertised toolset (prefix + activation + family gating)
// ---------------------------------------------------------------------------

export interface AdvertisedToolset {
  activated: ActivatedToolTracker;
  computeAdvertised: (all: readonly ToolDefinition[]) => ToolDefinition[];
  // Whether a name is on the advertised wire set (built-in prefix,
  // project-pinned, or execute-promoted). The dispatch gate keys off this so
  // a registered-but-unadvertised call intercepts instead of failing closed.
  isAdvertised: (name: string) => boolean;
  // Commit activated-but-unadvertised names onto the wire set in activation
  // order; returns whether it grew. Call on promote-on-execute so the next
  // infer declares that schema, and at cache-safe boundaries (session
  // start/resume, rotation) for anything still pending.
  flushPromotions: () => boolean;
  // Fold broke the cache prefix — drop execute-promoted schemas outside the
  // frozen core/pinned prefix. Discovered names stay callable via intercept;
  // returns whether the wire set shrank.
  pruneIdlePromotions: () => boolean;
}

/**
 * Fixed built-in prefix plus session-activated tools, family-gated for the
 * wire. The provider identity is read per call so a live model switch
 * re-gates without rebuilding the agent.
 *
 * Activation and advertisement are split: activating opens the call gate at
 * once; flushPromotions commits names onto the wire (promote-on-execute
 * flushes the one called name, tool_search only the top ranked hits). Fold
 * breaks the cache prefix — pruneIdlePromotions drops the advertised tail
 * back to it.
 *
 * `pinnedTools` (local settings) merge into the prefix — advertised from the
 * first turn and exempt from activation state, so resume needs no
 * tool_search round-trip for the project's hottest integrations.
 */
export function createAdvertisedToolset(args: {
  sessionMode: SessionMode;
  toolAvailability: ToolAvailability;
  getProvider: () => { providerName: string; model: string };
  builtInPrefix?: readonly string[] | undefined;
  pinnedTools?: readonly string[] | undefined;
}): AdvertisedToolset {
  const builtIn =
    args.builtInPrefix ??
    advertisedToolNamesForSessionMode(args.sessionMode, args.toolAvailability);
  const prefix = [
    ...builtIn,
    ...(args.pinnedTools ?? []).filter((name) => !builtIn.includes(name)),
  ];
  const activated = createActivatedToolTracker();
  // Wire-committed activations; clear() resets both so a rotated session
  // restarts at the prefix.
  let wireActivated: string[] = [];
  const wireActivatedSet = new Set<string>();
  const advertised: ActivatedToolTracker = {
    activate: (names) => activated.activate(names),
    has: (name) => activated.has(name),
    list: () => activated.list(),
    clear: () => {
      activated.clear();
      wireActivated = [];
      wireActivatedSet.clear();
    },
  };
  // Family-gate wire schemas after advertising; the primary is always the
  // orchestrator. use_skill is never denied — leaves load brief-named skills
  // by exact name.
  const deniedFor = (provider: {
    providerName: string;
    model: string;
  }): readonly string[] =>
    resolveModelFamilyPolicy({
      providerName: provider.providerName,
      model: provider.model,
      orchestrator: true,
    }).advertisedToolDeny;
  const computeAdvertised = (
    all: readonly ToolDefinition[],
  ): ToolDefinition[] => {
    const provider = args.getProvider();
    const denied = deniedFor(provider);
    const profile = toolProfileForModel(provider);
    const rawGated =
      denied.length === 0
        ? prefix
        : prefix.filter((name) => !denied.includes(name));
    const gatedPrefix = foldFileToolNames(rawGated, profile);
    // The wire carries only the prefix plus wire-committed activations.
    return normalizeToolDefinitionsForProvider(
      advertisedTools(all, wireActivated, gatedPrefix, profile),
      {
        ...provider,
      },
    );
  };
  const isAdvertised = (name: string): boolean => {
    const denied = deniedFor(args.getProvider());
    if (denied.includes(name) || denied.includes(canonicalToolName(name))) {
      return false;
    }
    const effective = foldFileToolNames(
      prefix,
      toolProfileForModel(args.getProvider()),
    );
    return nameMatchesAdvertisedListing(
      name,
      (n) => effective.includes(n) || activated.has(n),
    );
  };
  const flushPromotions = (): boolean => {
    let grew = false;
    for (const name of activated.list()) {
      if (wireActivatedSet.has(name)) continue;
      // Search hides these; flushing would put the schema on the wire until
      // fold. Dispatch stays available via intercept.
      if (UNADVERTISED_MOUNTED_BUILTINS.has(name)) continue;
      wireActivatedSet.add(name);
      wireActivated.push(name);
      grew = true;
    }
    return grew;
  };
  const pruneIdlePromotions = (): boolean => {
    if (wireActivated.length === 0 && activated.list().length === 0) {
      return false;
    }
    activated.clear();
    wireActivated = [];
    wireActivatedSet.clear();
    return true;
  };
  return {
    activated: advertised,
    computeAdvertised,
    isAdvertised,
    flushPromotions,
    pruneIdlePromotions,
  };
}

/**
 * Fold broke the cache prefix: drop idle execute-promoted schemas, refresh
 * the advertised wire, and persist so resume/crash cannot restore them.
 */
export function commitIdlePromotionPrune(args: {
  pruneIdlePromotions: () => boolean;
  refreshAdvertised: () => void;
  persist: () => void;
}): boolean {
  if (!args.pruneIdlePromotions()) return false;
  args.refreshAdvertised();
  args.persist();
  return true;
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
  inactivityTimeoutMs: number;
  totalTimeoutMs?: number | undefined;
  /**
   * Seed for the chat director's idle-with-fleet allowance (replaces the
   * former getLiveFleetCount closure; kept live via the fleet-wake
   * publisher). Omitted in exec; the TUI seeds it — fleet lanes may appear
   * mid-session.
   */
  allowIdleWithFleet?: boolean;
  /**
   * Bound to PermissionGate.clearDenials so a later user turn re-asks a URL
   * declined this turn. Same-turn reactor retries still short-circuit.
   */
  clearDenials?: () => void;
  getProvider: () => { providerName: string; model: string };
  /** Pre-created holder so the workflow controller can close over it first. */
  directorHolder?: { instance?: ChatDirector };
  /**
   * Reactor authorization: the permission gate expressed as the vendored
   * before-tool authz seam's effect vocabulary (see createReactorAuthorize).
   */
  authorize: AuthorizeFn;
  /** Read at each build so /clear and workdir rotation use the live store path. */
  getWorkdir: () => string;
  /** Read at each build so /clear and session rotation stamp the live session id. */
  getSessionId: () => string;
  inferenceDeps: Awaited<ReturnType<typeof createInferenceDependencies>>;
  getSources: () => InferenceSource[];
  getDefaultSource: () => string;
  /**
   * Read at each build so a compaction-mode toggle is visible on rebuild.
   * assemble passes the completeness gate as `wrapPruning` so fold-commit
   * side effects (stub notice, onFolded prune) run only after a fold lands.
   */
  getCompactor: (wrapPruning?: (pruning: Compactor) => Compactor) => Compactor;
  /**
   * Bound to the TUI compaction lifecycle abort signal. Captured at
   * completeness-gate apply start so onBuilt reset() cannot un-abort a fold
   * wrapCompactor already discarded.
   */
  getCompactionAbortSignal?: () => AbortSignal;
  /** Experimental Anthropic prompt shrink. Default off when omitted. */
  anthropicCachePrompt?: () => boolean;
  /**
   * Present when a resumed run record has an Anthropic-protocol cache write
   * and the provider about to be called is the same protocol. Read at each
   * build so an interrupt rebuild of the same session still folds before the
   * next infer. Omitted for a new session.
   */
  getCacheWriteSeed?: () => { at: number; model: string } | undefined;
  /** Assigns the runner's live agent/storage holders; keeps call sites unchanged. */
  onBuilt: (agent: Agent, storage: ContextStore) => void;
  /**
   * Primary-only evidence archive holder; assembleChatAgent writes the live
   * archive here on each build. Workers never pass one.
   */
  evidenceArchiveHolder?: { current?: CompactionArchive };
}

export interface AssembledChatAgent {
  directorHolder: { instance?: ChatDirector };
  /** Builds the agent and reports it through onBuilt; resolves the agent. */
  buildAgent: () => Promise<Agent>;
}

const STICKY_COMPACT_MANIFEST_PAGE = 32;

async function stickyExtraInstructionsFromStore(
  storage: ContextStore,
): Promise<string | undefined> {
  if (typeof storage.readManifestHistory !== "function") return undefined;
  try {
    let limit = STICKY_COMPACT_MANIFEST_PAGE;
    let previousLength = -1;
    for (;;) {
      const records = await storage.readManifestHistory(limit);
      const extra = stickyExtraInstructionsFromRecords(records);
      if (extra !== undefined) return extra;
      if (records.length === previousLength) return undefined;
      previousLength = records.length;
      limit *= 2;
    }
  } catch {
    return undefined;
  }
}

/**
 * Define the chat director + agent and build live instances against the
 * git-backed store. Identical for both runners: the TUI-only deltas
 * (workflow-aware toolset, emitter gates, reload scheduling) arrive as
 * callbacks.
 */
export function assembleChatAgent(wiring: ChatAgentWiring): AssembledChatAgent {
  const directorHolder = wiring.directorHolder ?? {};
  // Newest-commit-first compact records, refreshed each build so resume and
  // /model rebuilds restore sticky /compact instructions. /model rebuilds
  // keep the same store (may miss extras); /clear and /new mint a new
  // workdir, so fromPrev must not follow.
  let stickyFromStore: string | undefined;
  let inheritFromPrev = true;
  let lastWorkdir: string | undefined;
  let lastSessionId: string | undefined;
  const chatDirectorDef = defineDirector({
    id: `${ID_PREFIX}/chat`,
    configSchema: type({}),
    factory: (_cfg, _env, agentCtx) => {
      const fromPrev = inheritFromPrev
        ? directorHolder.instance?.getCompactInstructions()
        : undefined;
      const d = createChatDirector(
        agentCtx.systemPrompt,
        wiring.computeAdvertised([...agentCtx.toolDefinitions]),
        {
          inactivityTimeoutMs: wiring.inactivityTimeoutMs,
          totalTimeoutMs: wiring.totalTimeoutMs,
          provider: { ...wiring.getProvider() },
          allowIdleWithFleet: wiring.allowIdleWithFleet,
        },
      );
      d.restoreCompactInstructions(stickyFromStore);
      d.restoreCompactInstructions(fromPrev);
      if (wiring.clearDenials !== undefined)
        d.setClearDenials(wiring.clearDenials);
      directorHolder.instance = d;
      return d;
    },
  });

  const toolsFactory = defineTool({
    id: wiring.toolsId,
    definitions: [],
    factory: () => withAuthzParityDefinitions(wiring.getDynamicRunner()),
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
    const sessionId = wiring.getSessionId();
    inheritFromPrev =
      lastWorkdir === undefined ||
      (lastWorkdir === workdir && lastSessionId === sessionId);
    // Stamp last* only on success: a failed /clear factory would otherwise
    // make the retry look like the same session and inherit stale extras.
    if (!inheritFromPrev) stickyFromStore = undefined;
    const { storage, audit } = await createSessionStores(workdir);
    // Primary-only: workers never pass evidenceArchiveHolder, so they keep
    // plain storage without admission / authorize recording wraps.
    const archiveHolder = wiring.evidenceArchiveHolder;
    let primaryArchive: CompactionArchive | undefined;
    if (archiveHolder !== undefined) {
      const sessionId = path.basename(path.dirname(workdir));
      primaryArchive = createCompactionArchive({
        sessionId,
        contextDir: workdir,
        writeBlob: (key, bytes, contentType) =>
          storage.writeBlob(key, bytes, contentType),
        readBlob: (key) => storage.readBlob(key),
      });
      archiveHolder.current = primaryArchive;
    }

    const storageForAgent: ContextStore =
      primaryArchive === undefined
        ? storage
        : {
            ...storage,
            async writeBlob(key, bytes, contentType, signal) {
              await storage.writeBlob(key, bytes, contentType, signal);
              if (!key.startsWith("img-")) return;
              await primaryArchive.recordExistingBlobReference({
                kind: "attachment",
                blobKey: key,
                contentHash: hashAuthorizedBytes(bytes),
                provenance: "persistBlobs:aged-image",
              });
            },
            async writeResponse(turn, signal) {
              const content = turn.content.map((block) => {
                if (block.type !== "text") return block;
                const text = applyRecordingPolicyToText(block.text);
                return text === block.text ? block : { ...block, text };
              });
              const admitted = { ...turn, content };
              for (const block of admitted.content) {
                if (block.type === "text" && block.text.length > 0) {
                  await primaryArchive.recordAuthorizedPayload({
                    kind: "assistant_text",
                    payload: block.text,
                    provenance: "writeResponse:post-policy",
                  });
                }
              }
              return storage.writeResponse(admitted, signal);
            },
          };
    stickyFromStore = await stickyExtraInstructionsFromStore(storageForAgent);
    const agent = await createAgentWithLiveToolDispatch(agentDef, {
      sources: wiring.getSources(),
      defaultSource: wiring.getDefaultSource(),
      storage: storageForAgent,
      workdir,
      // Secrets resolve out of the first-party credential cell (see
      // ../config/source-credentials.ts): sources name a credentialId and the
      // vendored harness reads the secret through this resolver at send time.
      readCurrentMaterial: readSourceCredentialMaterial,
      // contextTransforms ride deps: the published @intx/agent forwards deps
      // into reactor assembly verbatim; the vendored assembly picks them up
      // from there.
      deps: {
        ...wiring.inferenceDeps,
        doomLoopPolicy: "fail-run",
        doomLoopCorrectiveNote: createDoomLoopCorrectiveNote(() =>
          wiring
            .computeAdvertised(wiring.getDynamicRunner().currentDefinitions())
            .map((def) => def.name),
        ),
        contextTransforms: [
          createAttachmentRehydrateTransform((key) =>
            storageForAgent.readBlob(key),
          ),
          createAnthropicCachePromptTransform({
            nowMs: () => Date.now(),
            cacheWriteAt: () => getActiveRun()?.lastCacheWriteAt,
            enabled: () => wiring.anthropicCachePrompt?.() === true,
            protocol: () => {
              const sources = wiring.getSources();
              const preferred = wiring.getDefaultSource();
              const match = sources.find((source) => source.id === preferred);
              return (match ?? sources[0])?.provider;
            },
          }),
        ],
      },
      audit,
      sessionId,
      // Gate-backed reactor authorization: ask-tier calls suspend via the
      // vendored approval-suspend primitive instead of parking on a closure;
      // finalize evidence admission after guards resolve, never scrubbing
      // exec args.
      authorize:
        primaryArchive === undefined
          ? wiring.authorize
          : wrapAuthorizeWithEvidenceArchive(
              wiring.authorize,
              () => primaryArchive,
            ),
      directors: createDirectorRegistry({
        factories: [chatDirectorDef.factory],
        defaultId: `${ID_PREFIX}/chat`,
      }),
      compactors: {
        "pruning-compactor": wiring.getCompactor(
          primaryArchive === undefined
            ? undefined
            : (pruning) =>
                wrapCompactorWithCompletenessGate(
                  pruning,
                  primaryArchive,
                  wiring.getCompactionAbortSignal === undefined
                    ? undefined
                    : { getSignal: wiring.getCompactionAbortSignal },
                ),
        ),
      },
    });
    const seed = wiring.getCacheWriteSeed?.();
    const source =
      seed === undefined ? undefined : lastCycleSourceFromRunModel(seed.model);
    if (seed !== undefined && source !== undefined) {
      const loaded = await storage.load();
      directorHolder.instance?.restoreCacheWrite({
        at: seed.at,
        source,
        turns: loaded.turns,
      });
    }
    const admittedAgent =
      primaryArchive === undefined
        ? agent
        : createPrimaryDeliveryAdmission(agent, primaryArchive);
    wiring.onBuilt(admittedAgent, storageForAgent);
    lastWorkdir = workdir;
    lastSessionId = sessionId;
    return admittedAgent;
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
  onTurnBoundarySnapshot: (
    event: Extract<ReactorEmittedEvent, { type: "inference.done" }>,
  ) => void;
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
 * construction — every live value (session id, source, context dir) is read
 * through a getter at event time, so it can assemble before the agent exists
 * (the TUI builds it early, exec late; same call, different position).
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
