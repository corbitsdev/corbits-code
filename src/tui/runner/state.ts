/**
 * Shared mutable state for the runner split (CL-6791 phase 4), following the
 * provider-setup `SetupState` pattern: `runTUI` in index.ts threads one state
 * bag plus one const services object through the submit/settings/exit/
 * commands/mcp/session factories so the extracted modules see the same live
 * bindings the old closure did. Lives in its own leaf module because the
 * sibling modules must not import each other (only index composes them), yet
 * need the same contracts.
 */

import type { Agent } from "@intx/agent";
import type { ContextStore, InboundMessage, InferenceSource } from "@intx/types/runtime";
import type { Config } from "../../config/index.js";
import { codexProfileFromProviderName } from "../../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../../config/xai-providers.js";
import type { MCPServerConfig, MCPServerSettingsEntry, Settings } from "../../config/settings.js";
import { globalSettingsPath, resolveLocalSettingsPath } from "../../config/settings.js";
import { resolveLiveSessionSources } from "../../session/assemble-runtime.js";
import type { prepareTUISession } from "../session-start.js";
import type { PersistMCPServerListResult } from "../../mcp/add-server.js";
import type { ProviderFailureAttempt } from "../provider/failure-attempt.js";
import type { ScopedApproval } from "../../permission/admin.js";
import type { ConnectedMcpServer, RunState } from "../../session/state.js";
import type { PendingImageAttachment } from "../image-attachments.js";
import type { SubmitOutcome } from "./submit.js";
import type { mountRunnerHost } from "./host.js";
import { EventEmitter } from "node:events";

export type TUIStart = NonNullable<Awaited<ReturnType<typeof prepareTUISession>>>;

export type RunnerHost = Awaited<ReturnType<typeof mountRunnerHost>>;

/**
 * Why a run.json snapshot is being written. Only "run-end" ends the run
 * itself and so clears the active-run handle that the crash handler in
 * index.ts reads.
 *
 * RunState.status cannot stand in for this. A /clear or /new rotation
 * persists a terminal "done" for the outgoing session while the process
 * keeps running under a fresh session id, so inferring "the run is over"
 * from a non-"running" status disarms crash finalization for everything
 * after the first rotation -- the session that dies then never gets its
 * terminal record and reads as "running" forever.
 */
export type SnapshotKind = "progress" | "session-rotation" | "run-end";

export type SnapshotStatus = RunState["status"];

export type SnapshotExtra = Pick<RunState, "finishedAt" | "error">;

/** The provider/model identity an inference attempt reports failures against. */
export interface InferenceAttemptIdentity {
  providerId: string;
  displayLabel?: string;
}

/**
 * The const bindings of the old runTUI closure: services assembled once (by
 * assembleTUISession) and never reassigned. index.ts builds the state bag
 * first, then threads (state, services) through every runner factory.
 */
export interface RunnerServices {
  emitter: EventEmitter;
  globalSettingsWriter: ReturnType<
    typeof import("../../mcp/add-server.js").createGlobalSettingsWriter
  >;
  localSettingsWriter: ReturnType<
    typeof import("../../mcp/add-server.js").createLocalSettingsWriter
  >;
  hookManager: Awaited<
    ReturnType<typeof import("../../session/assemble-runtime.js").assembleSessionLifecycle>
  >["hookManager"];
  runSink: Awaited<
    ReturnType<typeof import("../../session/assemble-runtime.js").assembleSessionLifecycle>
  >["runSink"];
  cycleRecorder: Awaited<
    ReturnType<typeof import("../../session/assemble-runtime.js").assembleSessionLifecycle>
  >["cycleRecorder"];
  crashGuard: TUIStart["crashGuard"];
  activeRunHandle: TUIStart["activeRunHandle"];
  inferenceDeps: TUIStart["inferenceDeps"];
  permissionGate: Awaited<
    ReturnType<typeof import("../../session/assemble-runtime.js").assembleSessionGate>
  >["gate"];
  permissionsAdmin: ReturnType<typeof import("../../permission/admin.js").createPermissionsAdmin>;
  liveSubAgent: ReturnType<
    typeof import("../../session/runtime-assembly.js").createLiveSubAgentSources
  >;
  subAgentSessions: ReturnType<typeof import("../../subagent/index.js").createSubAgentSessionStore>;
  pluginState: ReturnType<typeof import("../plugins-admin-backend.js").createPluginsAdminState>;
  executablePlugins: () => ReturnType<
    typeof import("../plugins-admin-backend.js").createPluginsAdminState
  >["modules"];
  pluginsAdmin: ReturnType<typeof import("../plugins-admin-backend.js").createPluginsAdmin>;
  skillDirs: ReturnType<
    typeof import("../../session/runtime-assembly.js").skillDirsFromEnabledPlugins
  >;
  liveToolWatchdog: import("../tool-execution-watchdog.js").ToolWatchdogConfig;
  liveSessionMode: import("../../config/session-mode.js").SessionMode;
  toolAvailability: import("../../agent/tool-search.js").ToolAvailability;
  toolset: Awaited<ReturnType<typeof import("../../agent/tools.js").createAgentToolset>>;
  systemPrompt: string;
  directorHolder: {
    instance?: ReturnType<typeof import("../../agent/director.js").createChatDirector>;
  };
  hostHolder: { instance?: RunnerHost };
  workflowControllerHolder: { instance?: import("../workflow-controller.js").WorkflowController };
  workflowController: import("../workflow-controller.js").WorkflowController;
  activatedToolNames: Awaited<
    ReturnType<typeof import("../../session/assemble-runtime.js").createAdvertisedToolset>
  >["activated"];
  computeAdvertised: Awaited<
    ReturnType<typeof import("../../session/assemble-runtime.js").createAdvertisedToolset>
  >["computeAdvertised"];
  buildAgent: ReturnType<
    typeof import("../../session/assemble-runtime.js").assembleChatAgent
  >["buildAgent"];
  sessionCost: ReturnType<typeof import("../../cost/session-cost.js").createSessionCostAccumulator>;
  sessionOps: ReturnType<
    typeof import("../session-operation-queue.js").createSessionOperationQueue
  >;
  deliveryGeneration: ReturnType<typeof import("../queued-delivery.js").createDeliveryGeneration>;
  buildSessionSources: () => import("../../session/assemble-runtime.js").LiveSessionSources;
  providerFailureAttempts: ReturnType<
    typeof import("../provider/failure-attempt.js").createProviderFailureAttemptTracker
  >;
  baseToolCount: number;
  mcpStates: Map<string, import("../../agent/tools.js").MCPServerState>;
  mcpConnectController: AbortController;
}

/**
 * The mutable bindings of the old runTUI closure: every `let` the split
 * modules read or reassign lives here. Late-wired cross-module callbacks
 * (systemNotice, persistRunSnapshot, ...) are optional slots invoked with
 * `?.` — the same idiom the pre-split code used for stampProvider and
 * paintPluginAttention — because they can only fire after index.ts wires
 * them, exactly like the TDZ-safe late reads of the old closure.
 */
export interface RunnerState {
  config: Config;
  sessionId: string;
  startedAt: number;
  runTaskTitle: string;
  workdir: string;
  resumeSkipInitialTask: boolean;
  localSettingsFile: string | null;
  // The TRUE global settings path (never the --config file): telemetry and
  // onboarding state are global user state.
  trueGlobalSettingsPath: string;
  telemetryFirstRun: boolean;
  runError: string | undefined;
  // A send rejected because the operator interrupted is not a failure to
  // report, and it must not settle a UI the interrupt path already settled.
  sendAborted: boolean;
  // Host mounts later; attention is painted once the shell exists.
  paintPluginAttention: ((needs: boolean) => void) | null;
  standingPluginWarnings: string[];
  // Saved through onboarding's "save anyway" bypass without a passing
  // connection test — surfaced once the shell exists, never before.
  startupPluginNotices: string[];
  currentAgent: Agent | undefined;
  // Set alongside currentAgent in buildAgent; getters wire the session's own
  // blob store into the truncation spill path (see result-truncation-plugin.ts).
  currentStorage: ContextStore | null;
  streamPromise: Promise<void> | undefined;
  // Serial-operation contention flags: a rebuild only runs when idle, and a
  // failed build poisons every later send instead of dispatching to a
  // closed agent.
  inFlight: number;
  pendingReload: boolean;
  fatalBuildError: Error | null;
  // The source the next inference will use, tracked live so the compaction
  // summarizer always summarizes with the current model (model switches and
  // Codex token refreshes update it).
  liveSource: InferenceSource;
  liveSources: InferenceSource[];
  liveDefaultSource: string;
  // The active Codex/xAI source, tracked whenever an OAuth profile source is
  // selected so its access token can be refreshed before each send.
  activeCodexSource: { profile: string; source: InferenceSource } | undefined;
  activeXaiSource: { profile: string; source: InferenceSource } | undefined;
  initialCodexProfile: string | undefined;
  initialXaiProfile: string | undefined;
  // MCP servers connected so far, keyed by name so a reconnect after a
  // failure replaces rather than duplicates the entry.
  connectedMcpServers: ConnectedMcpServer[];
  // Every configured server's latest settings entry, for the /mcp surface.
  configuredMcpEntries: MCPServerSettingsEntry[];
  liveHookConfig: Record<string, { enabled: boolean }>;
  // Mutable reference so the compaction summarize callback reads the live
  // mode without requiring an agent rebuild on every settings change.
  liveCompactionMode: NonNullable<Settings["compactionMode"]>;
  // Tracks the user's intent (persisted opt-in, updated live by the settings
  // toggle) rather than the held instance's state, so the settings tab shows
  // On during the first-run hold.
  liveTelemetryIntent: boolean;
  liveShowPromptCost: boolean;
  // The permissions surface addresses grants by their position in the last
  // listing, so revoke resolves against the same snapshot the operator saw.
  listedGrants: readonly ScopedApproval[];
  // Assigned once mountRunnerHost resolves; callbacks defined before the
  // mount read it through here.
  host: RunnerHost | undefined;
  // Stable handle handed to the App so the underlying agent can be swapped
  // out from under it without a remount; stampProvider.fn is wired by index
  // once the bridge exists.
  stampProvider: { fn: ((id: string | undefined) => void) | undefined };
  // Permission-gate persist notices surface through the shell once it exists.
  approvalPersistNotice: { notify?: (text: string) => void };

  // Late-wired cross-module callbacks, in original wiring order.
  enqueueAgentDeliver?: (deliverToLiveAgent: () => void) => void;
  reloadIfIdle?: () => void;
  systemNotice?: (text: string) => void;
  currentAttemptIdentity?: () => InferenceAttemptIdentity;
  handleSendFailure?: (
    err: unknown,
    attempt: InferenceAttemptIdentity,
    providerFailure: ProviderFailureAttempt,
  ) => void;
  sendWithAttemptIdentity?: (message: InboundMessage) => Promise<void>;
  sendUserPrompt?: (text: string, pending: readonly PendingImageAttachment[]) => Promise<void>;
  dispatchCommand?: (name: string, args: string) => void;
  newSession?: () => void;
  interrupt?: () => void;
  agentProxy?: Agent;
  send?: (text: string, attachments?: readonly PendingImageAttachment[]) => SubmitOutcome;
  connectLateMCPServer?: (server: MCPServerConfig) => void;
  applyMcpCatalog?: (result: Extract<PersistMCPServerListResult, { ok: true }>) => void;
  persistRunSnapshot?: (
    status: SnapshotStatus,
    extra?: SnapshotExtra,
    kind?: Exclude<SnapshotKind, "run-end">,
  ) => Promise<void>;
  shutdownRuntime?: () => Promise<void>;
  stopFleetReporting?: () => void;
}

export function recordRunError(state: RunnerState, err: unknown): void {
  state.runError = err instanceof Error ? err.message : String(err);
}

/** The live agent; every rebuild swaps the binding this reads. */
export function liveAgent(state: RunnerState): Agent {
  const agent = state.currentAgent;
  if (agent === undefined) {
    throw new Error("runner: agent accessed before the initial build");
  }
  return agent;
}

export function hostOf(state: RunnerState): RunnerHost {
  const host = state.host;
  if (host === undefined) {
    throw new Error("runner: host accessed before mount");
  }
  return host;
}

/**
 * Seed the state bag from the pre-try startup results. Everything here is
 * available before the session lifecycle assembles; later sections assign
 * the remaining fields in place, mirroring the old closure's `let` order.
 * The initial source bundle is resolved eagerly because it is a pure
 * function of the still-unmutated config and session id — identical inputs
 * to the old closure's first call.
 */
export function createRunnerState(start: TUIStart): RunnerState {
  const config = start.config;
  const initialBundle = resolveLiveSessionSources(config, start.sessionId);
  const state: RunnerState = {
    config,
    sessionId: start.sessionId,
    startedAt: start.startedAt,
    runTaskTitle: start.runTaskTitle,
    workdir: start.workdir,
    resumeSkipInitialTask: start.resumeSkipInitialTask,
    localSettingsFile: resolveLocalSettingsPath(config.cwd, config.globalSettingsPath),
    trueGlobalSettingsPath: globalSettingsPath(),
    telemetryFirstRun: false,
    runError: undefined,
    sendAborted: false,
    paintPluginAttention: null,
    standingPluginWarnings: [...start.pluginLoadDiag.warnings],
    startupPluginNotices: [],
    currentAgent: undefined,
    currentStorage: null,
    streamPromise: undefined,
    inFlight: 0,
    pendingReload: false,
    fatalBuildError: null,
    liveSource: initialBundle.selected,
    liveSources: initialBundle.sources,
    liveDefaultSource: initialBundle.defaultSource,
    activeCodexSource: undefined,
    activeXaiSource: undefined,
    initialCodexProfile: codexProfileFromProviderName(config.providerName),
    initialXaiProfile: xaiProfileFromProviderName(config.providerName),
    connectedMcpServers: start.resumeSeed.mcpServers,
    configuredMcpEntries: [...config.mcpServerEntries],
    liveHookConfig: { ...(config.settings?.hooks ?? {}) },
    liveCompactionMode: config.settings?.compactionMode ?? "llm",
    liveTelemetryIntent: false,
    liveShowPromptCost: config.settings?.showPromptCost ?? false,
    listedGrants: [],
    host: undefined,
    stampProvider: { fn: undefined },
    approvalPersistNotice: {},
  };
  // Saved through onboarding's "save anyway" bypass without a passing
  // connection test — warn now instead of a bare adapter error on first send.
  if (config.verified === false) {
    state.startupPluginNotices.push(
      `We couldn't confirm your "${config.providerName}" key works. If your first message fails with an auth error, double-check the key.`,
    );
  }
  return state;
}
