import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import {
  defineAgent,
  defineTool,
  createDirectorRegistry,
  defineDirector,
  AgentContextLockError,
  type Agent,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import { getLogger } from "@intx/log";
import {
  createOptimizedContextStore,
  loadRecentTurns,
} from "../session/optimized-context-store.js";
import { type } from "arktype";
import {
  buildCodexSource,
  buildOpenAISource,
  buildXaiSource,
  refreshLiveProviderCatalog,
  type Config,
} from "../config/index.js";
import {
  globalSettingsPath,
  loadLocalSettings,
  loadGlobalSettingsWriteBase,
  listFavoriteModels,
  listRecentModels,
  loadSettings,
  localSettingsPath,
  markTelemetryNoticeShown,
  persistSkipPermissionsDefault,
  pushRecentModel,
  saveGlobalSettings,
  shellTimeoutFromSettings,
  toolWatchdogFromSettings,
  markLastChangelogVersion,
  toggleFavoriteModel,
  setDefaultModel,
  type ModelRef,
  type ResolvedProvider,
  type Settings,
  type LocalSettings,
  type PluginConfig,
} from "../config/settings.js";
import { addProviderSelectorChoices, providerChoices } from "./provider-setup.js";
import { persistConnectedSelection } from "./provider-setup-submit.js";
import { connectProviderInline } from "./provider-connect.js";
import { modelOptionId } from "./model-catalog.js";
import { resolveWaitForApproval, type ToolWatchdogConfig } from "./tool-execution-watchdog.js";
import { attachApprovalBudget, createGateRequestApproval } from "./request-approval.js";
import { codexProfileFromProviderName, isCodexProviderName } from "../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../config/xai-providers.js";
import type { PluginsAdmin, PluginDescriptor } from "../plugins/admin.js";
import type { PluginManifest } from "../plugins/manifest.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import { cycleReasoningEffort, resolveSessionEffort } from "../provider/reasoning-effort.js";
import { getValidCodexToken } from "../auth/codex/session.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import { refreshCodexInstructions } from "../auth/codex/instructions.js";
import {
  expandExistingPluginMembers,
  expandPluginPath,
  expandSkipDiagnosticsHandler,
  loadPluginEntry,
  type PluginOrigin,
} from "../plugins/loader.js";
import {
  createPluginLoadDiagnostics,
  emitPluginWarningLog,
  formatPluginWarningsSummary,
  warningsForPluginEntry,
} from "../plugins/diagnostics.js";
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
import {
  registerCommandPlugins,
  registerWorkflowPlugins,
  isEnabledCommandPlugin,
  enablePluginConfig,
} from "../plugins/register.js";
import {
  getCommand,
  listCommands,
  registerCommandPlugin,
  setHiddenCommands,
  type CommandContext,
  type CommandResult,
} from "./commands/registry.js";
import { registerBuiltInCommands } from "./commands/built-in.js";
import type { PluginModule } from "../plugins/loader.js";
import { createTurnObserver } from "../telemetry/ai-observability.js";
import {
  armFeedbackCapture,
  cancelFeedbackCapture,
  captureFeedback,
  feedbackResultMessage,
  getLastTurnTraceId,
  isFeedbackCapturePending,
  takeFeedbackCapture,
} from "../telemetry/feedback.js";
import { activateHeldTelemetry, telemetryFirstRunPending } from "../telemetry/first-run.js";
import { TELEMETRY_NOTICE } from "../telemetry/index.js";
import { captureSlashCommand } from "../telemetry/product-events.js";
import { getTelemetry, liveTelemetry } from "../telemetry/singleton.js";
import { createTelemetryToggleHandler } from "../telemetry/toggle.js";

import { loadStartupChangelogMarkdown, stampVersionAfterStartup } from "../changelog/index.js";
import { scheduleUpgradeNotice } from "../upgrade/index.js";
import pkg from "../../package.json" with { type: "json" };
import { seedPricingMetadataFromCache } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath } from "../cost/pricing-fetcher.js";
import { getActivePricingCache } from "../cost/cost-visibility.js";
import { createFaremeter, formatCost } from "../cost/faremeter.js";
import {
  buildCostSummary,
  maskContextMeterWhenNoTurns,
  type CostSummary,
} from "../cost/cost-summary.js";
import { contextTokensFromUsage } from "../provider/context-window.js";
import {
  advertisedToolNamesForSessionMode,
  advertisedTools,
  createActivatedToolTracker,
  type ToolAvailability,
} from "../agent/tool-search.js";
import { detectLanguageServerAvailable } from "../agent/lsp-availability.js";
import { normalizeToolDefinitionsForProvider } from "../agent/tool-schema-normalize.js";
import { type SessionMode } from "../config/session-mode.js";
import {
  createFleetWatch,
  createSubAgentSessionStore,
  fleetDigest,
  FLEET_REPORT_SETTLE_MS,
  FLEET_STALL_POLL_MS,
  observeFleet,
  taskToolDefinition,
} from "../subagent/index.js";
import type {
  ContextStore,
  InferenceSource,
  ToolDefinition,
  InboundMessage,
} from "@intx/types/runtime";
import { OPERATOR_ORIGINATED_FLAG } from "../agent/message-provenance.js";
import { createSessionOperationQueue } from "./session-operation-queue.js";
import { setAgentSourceUnlessClosed } from "./agent-source-sync.js";
import { createChatDirector, hydrateTasksFromTurns } from "../agent/director.js";
import { loadAgentProfiles } from "../agent/profiles.js";
import { resolveAgentPluginProfiles } from "../plugins/agent-plugins.js";
import { createPermissionGate } from "../permission/gate.js";
import { createApprovalLog } from "../permission/approval-log.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import { createPermissionsAdmin, type ScopedApproval } from "../permission/admin.js";
import type { GrantScope } from "../permission/types.js";

import { createAgentToolset, type MCPServerState, type OperatorResult } from "../agent/tools.js";
import { createAgentWithLiveToolDispatch } from "../agent/live-tool-dispatch.js";
import {
  collectWebPlugins,
  resolveWebProviderFromPlugins,
  webBrand,
} from "../web/plugin-provider.js";
import { collectToolPlugins, resolveToolPlugins } from "../plugins/tool-plugins.js";
import { scrubSecrets } from "../web/secret-scrub.js";
import { setActiveWebProviderBrand } from "./tool-formatter.js";
import { consumeStream } from "../session/stream-consumer.js";
import { createCycleTextRecorder } from "../session/stream-journal.js";
import { mountRunnerHost } from "./runner-host.js";
import { createRuntimeShutdown } from "./runtime-shutdown.js";
import {
  applyFocus,
  attachClipboardImage,
  setEffortCycleHandler,
  setMentionSuggestionSource,
  setPluginNeedsAttention,
  setPromptModelLabel,
  setPromptRecognitionSource,
  setSentMessageHistory,
  setShellInputSuspended,
  setShellRunState,
  setStatusFlash,
  surfaceSystemNotice,
} from "./shell.js";
import {
  captureAuthFailure,
  classifyAgentSendFailure,
  shouldSettleUiAfterSendFailure,
} from "./session-chrome.js";
import { ingestPathMentions } from "./prompt-attachments.js";
import { listPathSuggestions } from "./components/at-mention/list.js";
import { resolveAtMentions } from "./mention-resolution.js";
import { imageAttachmentFromPath, type PendingImageAttachment } from "./image-attachments.js";
import { appendSentMessage, loadSentMessages } from "../session/sent-messages.js";
import type { OperatorGateEvent } from "./gate-events.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
  type RunSummary,
} from "../session/hooks.js";
import { createRunSink } from "../session/run-sink.js";
import {
  generateSessionId,
  initSessionDir,
  renameSession,
  sessionContextDir,
  sessionDir,
} from "../session/index.js";
import { resolveSessionLabel, truncateSessionLabel } from "../session/session-label.js";
import {
  finalizeRunState,
  loadState,
  saveState,
  type ConnectedMcpServer,
  type RunState,
} from "../session/state.js";
import { setActiveRun, clearActiveRun, type RunStateHandle } from "../session/active-run.js";
import { setActiveDisposeHost, clearActiveDisposeHost } from "../session/active-host.js";
import { openInBrowser } from "../auth/oauth/browser.js";
import { pickSession } from "./pick-session.js";
import { RESUME_TRANSCRIPT_BLOCK_LIMIT, turnsToContentBlocks } from "./turns-to-blocks.js";
import { WorkflowController } from "./workflow-controller.js";
import {
  buildSessionSourcesFromConfig,
  createApprovalPersist,
  createLiveSubAgentSources,
  createSessionPruningCompactor,
  discoverSessionPlugins,
  loadSeededApprovals,
  loadSessionChatPrompt,
  skillDirsFromEnabledPlugins,
} from "../session/runtime-assembly.js";
import { createAttachmentRehydrateTransform } from "../session/attachment-store.js";
import { createModelSummarizer, type SummaryContext } from "../session/summarizer.js";
import { COMMAND_NAME, ID_PREFIX, LOG_NAMESPACE_ROOT } from "../branding.js";
import { deliverAgentMessage } from "./deliver-agent-message.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export { getTUIRunSummaryStatus } from "../session/run-sink.js";

export interface ResolveExitCodeArgs {
  runError: string | undefined;
  sinkError: string | undefined;
  status: RunSummary["status"];
}

export function resolveExitCode(args: ResolveExitCodeArgs): number {
  const { runError, sinkError, status } = args;
  if (runError !== undefined || sinkError !== undefined || status !== "done") {
    return 1;
  }
  return 0;
}

/** One-line transcript block when resume history fails to load. */
export function resumeTranscriptLoadErrorBlock(err: unknown): {
  type: "error";
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  return { type: "error", message: `Could not load prior session transcript: ${message}` };
}

// The agent package releases its workdir lock at the very end of close(),
// after reactor.abort()/sendQueue.drain() and the shutdown-complete race have
// all run. If any of that throws (most likely right when an operator
// interrupts mid-inference, which is exactly when those paths are under
// stress), the lock is never released — and because the agent is already
// marked closed internally, retrying close() is a silent no-op that can
// never release it either. Every rebuild site that reuses the *same* workdir
// (interrupt, reloadIfIdle) must treat that as fatal for the current rebuild
// instead of calling buildAgent() again: a second createAgent() for the same
// workdir is then guaranteed to throw AgentContextLockError for a lock
// nothing will ever free, which is the "agent already open" crash. Session
// rotation (newSession) is the one rebuild site that does NOT route through
// this helper: it always points buildAgent() at a freshly minted workdir
// before rebuilding, so a leaked lock on the old workdir can never be
// re-acquired there — see the comment at its close() call for why.
export async function closeAgentForRebuild(agent: Agent, context: string): Promise<boolean> {
  try {
    await agent.close();
    return true;
  } catch (err) {
    tuiLogger.debug(`agent.close during ${context} teardown failed: {error}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Every rebuild site funnels its failure (a lock left held by a failed
// close, or any other buildAgent failure) through here so it surfaces as a
// plain-language, caught error rather than an unhandled rejection.
export function agentRebuildFailure(err: unknown): Error {
  return err instanceof AgentContextLockError
    ? new Error(
        "Could not start a new agent: the previous one did not shut down cleanly. Restart Corbits to continue.",
      )
    : err instanceof Error
      ? err
      : new Error(String(err));
}

export interface ResumeSeed {
  turnsUsed: number;
  mcpServers: ConnectedMcpServer[];
}

const FRESH_RESUME_SEED: ResumeSeed = { turnsUsed: 0, mcpServers: [] };

/**
 * Fold a resumed session's run.json into a concrete seed once, at the
 * resume boundary, so every downstream reader (the run sink, the
 * connected-servers list, the immediate post-resume saveState) trusts a
 * fully-populated value instead of each repeating its own `?? 0` / `?? []`
 * default. A fresh (non-resumed) run gets the same shape via
 * FRESH_RESUME_SEED, so callers never branch on "was this a resume."
 */
export function resolveResumeSeed(pickedState: RunState | null): ResumeSeed {
  if (pickedState === null) return FRESH_RESUME_SEED;
  return {
    turnsUsed: pickedState.turnsUsed,
    mcpServers: pickedState.mcpServers ?? [],
  };
}

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

export function clearsActiveRun(kind: SnapshotKind): boolean {
  return kind === "run-end";
}

const GRANT_SCOPE_LABEL: Record<GrantScope, string> = {
  session: "This session",
  project: "This project",
  global: "Global",
  "provider-model": "Provider / model",
};

/**
 * Resolve the base for a local-settings read-modify-write.
 * Absent file → empty object; unreadable/invalid → null (caller must skip write).
 */
export async function loadLocalSettingsWriteBase(
  path: string,
  load: (path: string) => Promise<LocalSettings | null> = loadLocalSettings,
): Promise<LocalSettings | null> {
  try {
    return (await load(path)) ?? {};
  } catch {
    return null;
  }
}

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
 * Populate the slash-command registry for a session: built-ins first, then
 * enabled plugin commands and workflows, then the hidden-command filter.
 *
 * Exported so the production wiring is testable — built-in registration used to
 * ride on an import side effect and silently disappeared when its only importer
 * was deleted.
 */
export type SubmissionRoute =
  | { kind: "empty" }
  | { kind: "command"; name: string; args: string }
  | { kind: "prompt"; text: string };

/**
 * Decide what a submitted composer line is. A leading `/` means a slash command
 * — it must never reach the model as a prompt, whether it was typed directly or
 * picked from the palette.
 */
export function routeSubmission(raw: string): SubmissionRoute {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  const body = trimmed.startsWith("/") ? trimmed.slice(1).trim() : trimmed;
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };
  if (body.length === 0) return { kind: "empty" };
  const sep = body.search(/\s/);
  return sep === -1
    ? { kind: "command", name: body, args: "" }
    : { kind: "command", name: body.slice(0, sep), args: body.slice(sep + 1).trim() };
}

export interface SubmitHandlerDeps {
  dispatchCommand: (name: string, args: string) => void;
  sendPrompt: (text: string, attachments?: readonly PendingImageAttachment[]) => void;
  /** Consent-by-proceeding hook: runs only for real prompts, never commands. */
  onPromptSubmitted?: () => void;
  /**
   * When true, the next non-command submit is treated as intentional feedback
   * text (bare `/feedback` multi-turn mode) instead of a model prompt.
   */
  isFeedbackCapturePending?: () => boolean;
  /** Consume the pending feedback arm and handle the text; return operator message. */
  onFeedbackText?: (text: string) => string;
  /** Drop a pending multi-turn /feedback arm (empty Enter cancel). */
  cancelFeedbackCapture?: () => void;
  /** Surface a local system notice (feedback thanks / blocked / cancelled). */
  onSystemNotice?: (text: string) => void;
}

/**
 * Composer submit handler. Slash input is dispatched against the command
 * registry instead of being sent to the model. When feedback capture is armed
 * (bare `/feedback`), the next non-command line is captured as survey text.
 *
 * Returns an outcome so the session bridge can keep local-only submits off the
 * agent busy path and out of the mid-run queue.
 */
export type SubmitOutcome = "agent" | "local" | "empty";

/**
 * Classify a composer line without side effects. Local = slash command or
 * armed multi-turn feedback text; empty = no-op (or cancel-feedback); agent =
 * real model turn.
 */
export function classifySubmission(
  text: string,
  options: {
    hasAttachments?: boolean;
    feedbackPending?: boolean;
    feedbackCaptureEnabled?: boolean;
  } = {},
): SubmitOutcome {
  const route = routeSubmission(text);
  const hasAttachments = options.hasAttachments === true;
  if (route.kind === "empty" && !hasAttachments) return "empty";
  if (route.kind === "command") return "local";
  if (
    route.kind === "prompt" &&
    options.feedbackPending === true &&
    options.feedbackCaptureEnabled === true
  ) {
    return "local";
  }
  return "agent";
}

export function createSubmitHandler(
  deps: SubmitHandlerDeps,
): (text: string, attachments?: readonly PendingImageAttachment[]) => SubmitOutcome {
  return (text, attachments) => {
    const route = routeSubmission(text);
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    const feedbackPending = deps.isFeedbackCapturePending?.() === true;
    const feedbackCaptureEnabled = deps.onFeedbackText !== undefined;
    const outcome = classifySubmission(text, {
      hasAttachments,
      feedbackPending,
      feedbackCaptureEnabled,
    });

    // Empty Enter while /feedback is armed cancels instead of trapping the
    // operator until they type free text or /clear.
    if (outcome === "empty") {
      if (feedbackPending) {
        deps.cancelFeedbackCapture?.();
        deps.onSystemNotice?.("Feedback cancelled.");
      }
      return "empty";
    }
    if (route.kind === "command") {
      // Any other slash command drops a bare-/feedback arm so the next
      // free-text line is not mis-routed as survey text.
      if (feedbackPending && route.name !== "feedback") {
        deps.cancelFeedbackCapture?.();
      }
      deps.dispatchCommand(route.name, route.args);
      return "local";
    }
    // Multi-turn /feedback: next Enter is survey text, not a model prompt.
    if (outcome === "local" && deps.onFeedbackText !== undefined) {
      const notice = deps.onFeedbackText(route.kind === "prompt" ? route.text : text);
      deps.onSystemNotice?.(notice);
      return "local";
    }
    deps.onPromptSubmitted?.();
    deps.sendPrompt(route.kind === "prompt" ? route.text : "", attachments);
    return "agent";
  };
}

/** Text sent alongside an image when the operator attached one without a prompt. */
export const IMAGE_ONLY_PROMPT = "Please inspect the attached image.";

/**
 * Build the inbound message for a genuine operator submit — the real
 * prompt-submit path in the TUI (sendUserPrompt / the "send" command
 * result), with or without attachments. Carries OPERATOR_ORIGINATED_FLAG so
 * director.ts's loop-protection backstop can tell this apart from
 * system-originated sends (compaction continuations, retries, nudges).
 */
export function userInboundMessage(
  text: string,
  attachments: readonly PendingImageAttachment[],
): InboundMessage {
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
    signatureStatus: "missing",
    content: text.length > 0 ? text : IMAGE_ONLY_PROMPT,
    attachments: attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      data: a.data,
    })),
  };
}

/** First-run telemetry disclosure to show before consent-by-proceeding applies. */
export function telemetryStartupNotice(
  globalSettings: Settings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return telemetryFirstRunPending(globalSettings, env) ? TELEMETRY_NOTICE : undefined;
}

export function setUpCommandRegistry(
  settings: Settings | undefined,
  plugins: PluginModule[],
): void {
  const pluginConfig = settings?.plugins ?? {};
  registerBuiltInCommands();
  registerWorkflowPlugins(plugins, pluginConfig);
  registerCommandPlugins(plugins, pluginConfig);
  setHiddenCommands(settings?.hiddenCommands ?? []);
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
  // Declared before the migration call below so a skipped marketplace member
  // (bad pluginPaths entry) collects into the same summary as discovery,
  // rather than defaulting to stderr — `onSkip` on expandExistingPluginMembers
  // is required precisely so this can't be forgotten at a call site.
  const pluginLoadDiag = createPluginLoadDiagnostics();
  // One-shot: seed global path trust from pluginPaths only when the store file
  // does not exist yet (legacy per-cwd grants). Later boots load the store as-is.
  let pathTrust: PathTrustStore = await migratePathTrustFromPluginPaths(
    config.settings?.pluginPaths ?? [],
    (p) => expandExistingPluginMembers(p, config.cwd, expandSkipDiagnosticsHandler(pluginLoadDiag)),
    undefined,
    { onMigrated: reportPathTrustMigration },
  );
  const isProjectPluginTrusted = (pluginPath: string) => isPluginTrusted(projectTrust, pluginPath);
  const isRegisteredPathTrusted = (pluginPath: string) =>
    isPathPluginTrusted(pathTrust, pluginPath);
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
  emitPluginWarningLog(pluginLoadDiag);
  // Fire-and-forget startup diagnostics (this + tool-plugin / profile resolution
  // below) have no result channel back to an operator action. Log-only is fine
  // for the structured logger; the standing `plugin !` mark and `/plugins`
  // surface carry the same warnings to the operator instead of a startup
  // system notice.
  const standingPluginWarnings: string[] = [...pluginLoadDiag.warnings];
  // Host mounts later; attention is painted once the shell exists.
  let paintPluginAttention: ((needs: boolean) => void) | null = null;
  const notePluginWarnings = (warnings: readonly string[]): void => {
    if (warnings.length === 0) return;
    standingPluginWarnings.push(...warnings);
    paintPluginAttention?.(standingPluginWarnings.length > 0);
  };
  // Saved through onboarding's "save anyway" bypass without a passing
  // connection test — warn now instead of a bare adapter error on first send.
  const startupPluginNotices: string[] = [];
  if (config.verified === false) {
    startupPluginNotices.push(
      `We couldn't confirm your "${config.providerName}" key works. If your first message fails with an auth error, double-check the key.`,
    );
  }
  // Mutable list so trusting a project/path plugin can replace a metadata-only stub
  // with a fully loaded module without restarting the process.
  let livePluginModules = pluginModules;
  const executablePlugins = () => livePluginModules.filter((m) => m.metadataOnly !== true);
  // Command plugins are wired in only when explicitly enabled in settings.
  const pluginConfig = config.settings?.plugins ?? {};
  setUpCommandRegistry(config.settings, executablePlugins());
  // loadConfig already bootstrapped pricing metadata; re-read cache here so a
  // TUI-only entry (tests) still picks up the tool-home cache path.
  await seedPricingMetadataFromCache({
    cachePath: defaultPricingCachePath(),
  });
  let sessionId = config.sessionId;
  let resumeSkipInitialTask = config.skipInitialTask === true;
  let startedAt = Date.now();
  let runTaskTitle = config.task;
  // Resolved once at the resume boundary so turnsUsed/mcpServers reads
  // downstream never repeat their own omission-handling default.
  let resumeSeed: ResumeSeed = FRESH_RESUME_SEED;

  if (config.resumePicker) {
    const picked = await pickSession(config.cwd, { includeCompleted: config.force });
    if (picked === null) return 0;
    sessionId = picked.sessionId;
    resumeSkipInitialTask = true;
    const pickedState = await loadState(config.cwd, sessionId);
    resumeSeed = resolveResumeSeed(pickedState);
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
    turnsUsed: resumeSeed.turnsUsed,
    task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    model: `${config.providerName}:${config.model}`,
    mcpServers: resumeSeed.mcpServers,
  });

  // Registered the moment a run starts so the top-level uncaughtException /
  // unhandledRejection handler in index.ts (which cannot see any local state
  // in this function) can finalize run.json for crashes that escape without
  // ever reaching this function's own try/catch — e.g. a throw inside a
  // fire-and-forget `void` call. Cleared wherever `finalized` below flips
  // true, since those paths already write a terminal run.json themselves.
  const activeRunHandle: RunStateHandle = {
    sessionId,
    cwd: config.cwd,
    task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    model: `${config.providerName}:${config.model}`,
  };
  setActiveRun(activeRunHandle);

  // Crash guard: if anything from setup onward throws all the way out of
  // runTUI instead of reaching the normal finalize block, this still closes
  // out run.json so status and finishedAt never disagree. Declared before the
  // try so every fallible step after the minimal write above is covered.
  // `finalized` is set by the normal finalize path so this never double-writes
  // on a clean exit. It also gates persistRunSnapshot (below) from *issuing*
  // a straggler write at all once the run is closed — a different job from
  // saveState's per-session write ordering in state.ts. That ordering only
  // decides which already-issued write lands last; it has no way to know a
  // "running" snapshot fired after finalize is stale and should never be
  // written in the first place. Without this flag such a snapshot would
  // still queue behind the terminal write and legitimately "win" the
  // ordering, resurrecting a closed run.json. Two different constraints
  // (don't issue a stale write vs. order the writes you do issue), each
  // owned by its own layer — not a duplicate check.
  let finalized = false;
  // Bound after the cycle recorder exists (it needs the session workdir); the
  // crash guard is declared first so it covers every fallible step below.
  let flushPartialOnCrash: () => Promise<void> = async () => {};
  // Bound once the host is mounted. Without this the crash path leaves the
  // renderer alive, so the alternate screen, mouse reporting and raw mode are
  // never disabled and the operator's terminal is left wedged.
  let disposeHost: () => void = () => {};
  const finalizeOnCrash = async (err: unknown): Promise<void> => {
    if (finalized) return;
    finalized = true;
    // Clear the active-run handle up front, before the awaits below. This
    // handler isn't the only reader of the handle: index.ts installs its own
    // uncaughtException/unhandledRejection listeners that call getActiveRun()
    // directly and, if it's still set, write a competing "crashed" record via
    // saveCrashState. finalizeRunState (state.ts) also clears the handle
    // before its own saveState await, but only once it's called below — an
    // escaped throw during the flushPartialOnCrash await just above would
    // still reach that listener with the handle live, so it's cleared here
    // too to close that earlier window.
    clearActiveRun();
    clearActiveDisposeHost();
    await flushPartialOnCrash().catch((flushErr: unknown) => {
      // Best-effort only — still attempt saveState below. Log so a flush
      // failure is not invisible when diagnosing a crash exit.
      const flushMessage = flushErr instanceof Error ? flushErr.message : String(flushErr);
      tuiLogger.warn("crash finalize: partial flush failed: {error}", { error: flushMessage });
      process.stderr.write(
        `${COMMAND_NAME}: crash finalize partial flush failed: ${flushMessage}\n`,
      );
    });
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRunState(config.cwd, sessionId, {
      status: "failed",
      turnsUsed: 0,
      task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
      startedAt,
      finishedAt: Date.now(),
      error: message,
      model: `${config.providerName}:${config.model}`,
      mcpServers: [],
    }).catch((saveErr: unknown) => {
      const saveMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
      tuiLogger.warn("crash finalize: saveState failed for session {sessionId}: {error}", {
        sessionId,
        error: saveMessage,
      });
      process.stderr.write(
        `${COMMAND_NAME}: crash finalize saveState failed for ${sessionId}: ${saveMessage}\n`,
      );
    });
  };

  try {
    const emitter = createTUIEventEmitter();
    const initialHookEnabled: Record<string, boolean> = Object.fromEntries(
      Object.entries(config.settings?.hooks ?? {}).map(([id, v]) => [id, v.enabled]),
    );
    const hookManager = createLifecycleHookManager({
      hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
      onEvent: (event) => emitter.emit("hook", event),
      initialEnabled: initialHookEnabled,
    });
    // Cheap static check, not a real parser: a shell hook always receives the
    // lifecycle name as $1, so it can react to either; a TypeScript hook's
    // exports tell us which of postTurn/postRun it actually implements.
    const hookRunsOn = new Map<string, string>();
    for (const status of hookManager.getStatuses()) {
      if (status.type === "shell") {
        hookRunsOn.set(status.id, "runs postTurn and postRun (receives the lifecycle name as $1)");
        continue;
      }
      try {
        const source = await readFile(status.path, "utf8");
        const hasPostTurn = /export\s+(async\s+)?function\s+postTurn\b/.test(source);
        const hasPostRun = /export\s+(async\s+)?function\s+postRun\b/.test(source);
        hookRunsOn.set(
          status.id,
          hasPostTurn && hasPostRun
            ? "runs postTurn and postRun"
            : hasPostTurn
              ? "runs postTurn"
              : hasPostRun
                ? "runs postRun"
                : "no postTurn/postRun export found — see file",
        );
      } catch {
        hookRunsOn.set(status.id, "could not read hook file — see file");
      }
    }
    let liveHookConfig: Record<string, { enabled: boolean }> = {
      ...(config.settings?.hooks ?? {}),
    };
    const persistHookSettings = async (): Promise<void> => {
      const base = await loadGlobalSettingsWriteBase(config.globalSettingsPath);
      if (base === null) {
        tuiLogger.warn("Skipping hook settings write: unreadable global settings at {path}", {
          path: config.globalSettingsPath,
        });
        return;
      }
      const next: Settings = { ...base, hooks: liveHookConfig };
      await saveGlobalSettings(config.globalSettingsPath, next);
    };
    const setHookEnabled = async (id: string, enabled: boolean): Promise<void> => {
      hookManager.setEnabled(id, enabled);
      liveHookConfig = { ...liveHookConfig, [id]: { enabled } };
      await persistHookSettings();
    };
    let runError: string | undefined;

    const recordRunError = (err: unknown): void => {
      runError = err instanceof Error ? err.message : String(err);
    };

    // A send rejected because the operator interrupted is not a failure to
    // report, and it must not settle a UI the interrupt path already settled.
    let sendAborted = false;
    const isCodexAuthError = (err: unknown): boolean =>
      err instanceof Error && err.name === "CodexAuthError";
    const isXaiAuthError = (err: unknown): boolean =>
      err instanceof Error && err.name === "XaiAuthError";

    const activeProviderModel = `${config.providerName}:${config.model}`;

    // Shared by the permission gate and every operator-gate emission site: an
    // unattended auto-continue run must not park on any gate forever, whichever
    // kind it is. No caller arms this today — the goal subsystem was the only
    // source of an auto-deny/auto-cancel deadline and has been removed. The
    // timeout plumbing (gate-events.ts / request-approval.ts, and every
    // OperatorGateEvent/PermissionGateEvent emission site below) stays for a
    // future generalized auto-continue mechanism to re-arm by giving this a
    // real body again.
    const approvalTimeout = (): { timeoutMs: number; timeoutMessage: string } | undefined =>
      undefined;

    const seededApprovals = await loadSeededApprovals(config.cwd, sessionId);
    const permissionGate = createPermissionGate({
      approvals: seededApprovals,
      telemetry: liveTelemetry,
      cwd: config.cwd,
      rootsProvider: createWorktreeRootsProvider(config.cwd),
      providerName: config.providerName,
      model: config.model,
      requestApproval: createGateRequestApproval({
        emitGate: (event) => emitter.emit("permission.gate", event),
        approvalTimeout,
      }),
      persist: createApprovalPersist(config.cwd, activeProviderModel),
      approvalLog: createApprovalLog(sessionDir(config.cwd, sessionId)),
      interactive: true,
      skipPermissions: config.dangerouslySkipPermissions,
      auto: config.auto,
      onGrant: (approval, covers) => emitter.emit("permission.grant", { approval, covers }),
    });

    const permissionsAdmin = createPermissionsAdmin(permissionGate, config.cwd);

    // Track the active subagent provider so a live /agent switch (provider, model,
    // or reasoning effort) reaches subagents spawned afterward. Derives from the
    // live `config` binding on every spawn, so every switch path that reassigns
    // `config` (model picker, /agent, post-connect refresh) is picked up without
    // a separate cache to keep in sync.
    const liveSubAgent = createLiveSubAgentSources(() => config);

    // Dedicated child-session records for enter-session inspection. Child events
    // land here only — never in the parent chat transcript.
    const subAgentSessions = createSubAgentSessionStore();

    const webPluginCandidates = collectWebPlugins(executablePlugins());
    // Tool plugins are wired in only when enabled AND consented.
    const toolPluginCandidates = collectToolPlugins(executablePlugins());
    // Web and tool plugin resolution are independent, so resolve them concurrently.
    const toolPluginDiag = createPluginLoadDiagnostics();
    const [activeWeb, extraToolPlugins] = await Promise.all([
      resolveWebProviderFromPlugins({
        candidates: webPluginCandidates,
        pluginConfig: config.settings?.plugins ?? {},
        webOverride: config.settings?.web,
      }),
      resolveToolPlugins({
        candidates: toolPluginCandidates,
        pluginConfig: config.settings?.plugins ?? {},
        diagnostics: toolPluginDiag,
      }),
    ]);
    if (activeWeb !== undefined) setActiveWebProviderBrand(webBrand(activeWeb.name));
    emitPluginWarningLog(toolPluginDiag);
    standingPluginWarnings.push(...toolPluginDiag.warnings);

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
            ...(mod.manifest.description !== undefined
              ? { description: mod.manifest.description }
              : {}),
            credentials: mod.manifest.credentials ?? [],
            ...(mod.metadataOnly === true ? { needsTrust: true } : {}),
            ...(mod.origin === "path" && mod.metadataOnly !== true ? { canRevokeTrust: true } : {}),
          };
    const pluginDescriptors: PluginDescriptor[] = livePluginModules
      .map((m) => toDescriptor(m))
      .filter((d): d is PluginDescriptor => d !== undefined);
    // Attach agent profiles to their descriptors so the /plugins UI can show
    // which sub-agents a plugin contributes.
    for (const mod of livePluginModules) {
      if (mod.manifest?.kind !== "agent" || mod.agentPlugin === undefined) continue;
      const desc = pluginDescriptors.find((d) => d.id === mod.manifest!.id);
      if (desc === undefined) continue;
      const agents = Array.isArray(mod.agentPlugin.agents) ? mod.agentPlugin.agents : [];
      desc.agentProfiles = agents
        .filter(
          (a): a is Record<string, unknown> => typeof a === "object" && a !== null && "id" in a,
        )
        .map((a) => ({
          id: String(a["id"]),
          ...(typeof a["description"] === "string" ? { description: a["description"] } : {}),
        }));
    }
    let livePluginConfig: Record<string, PluginConfig> = { ...(config.settings?.plugins ?? {}) };
    let liveWebOverride: string | undefined = config.settings?.web;
    const livePluginPaths: string[] = [...(config.settings?.pluginPaths ?? [])];
    const persistPluginSettings = async (): Promise<void> => {
      // Absent file → fresh base; unreadable/invalid → skip write so we never
      // clobber a corrupt settings file by rewriting from a minimal shell.
      const base = await loadGlobalSettingsWriteBase(config.globalSettingsPath);
      if (base === null) {
        tuiLogger.warn("Skipping plugin settings write: unreadable global settings at {path}", {
          path: config.globalSettingsPath,
        });
        return;
      }
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
        // Warnings from the trust-grant load below are collected, not logged:
        // like `addPath`, the caller has a result channel back to the operator
        // (the command surface's `deps.notify`), so fold them into the returned
        // message instead of a log line nobody watches.
        let trustGrantMessage: string | undefined;
        // Enabling a project/path plugin records trust and full-loads code.
        if (cfg.enabled === true) {
          const stub = livePluginModules.find((m) => m.manifest?.id === id);
          // Trust routing must use the origin stamped at discovery — a fallback
          // here could turn one store's gate into the other's grant.
          if (
            stub?.metadataOnly === true &&
            stub.pluginPath !== undefined &&
            stub.origin !== undefined
          ) {
            if (stub.origin === "path") {
              pathTrust = await trustPathPlugin(stub.pluginPath);
            } else {
              projectTrust = await trustPlugin(config.cwd, stub.pluginPath);
            }
            const trustDiag = createPluginLoadDiagnostics();
            const full = await loadPluginEntry(stub.pluginPath, {
              cwd: config.cwd,
              origin: stub.origin,
              diagnostics: trustDiag,
            });
            trustGrantMessage = formatPluginWarningsSummary(trustDiag.warnings);
            notePluginWarnings(trustDiag.warnings);
            if (full !== null) {
              livePluginModules = livePluginModules.map((m) => (m.manifest?.id === id ? full : m));
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
              if (
                full.commandPlugin !== undefined &&
                isEnabledCommandPlugin(full, livePluginConfig)
              ) {
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
        return trustGrantMessage === undefined ? undefined : { message: trustGrantMessage };
      },
      setWebOverride: async (id) => {
        liveWebOverride = id;
        await persistPluginSettings();
      },
      verify: async (id, credentials) => {
        // Agent plugins verify by checking they contribute valid profiles.
        const agentMod = livePluginModules.find(
          (m) => m.manifest?.id === id && m.manifest?.kind === "agent",
        );
        if (agentMod !== undefined) {
          const verifyDiag = createPluginLoadDiagnostics();
          const profiles = await resolveAgentPluginProfiles(
            [agentMod],
            { [id]: { enabled: true } },
            { diagnostics: verifyDiag },
          );
          if (profiles.length === 0) return { ok: false, message: "No valid agent profiles found" };
          // Fold warnings into the message (same pattern as `addPath`) instead of
          // logging them: "loaded — N profiles" must not read identically whether
          // or not a profile's skill ref actually resolved.
          const warnings = formatPluginWarningsSummary(verifyDiag.warnings);
          notePluginWarnings(verifyDiag.warnings);
          const base = `loaded — ${profiles.length} profile${profiles.length === 1 ? "" : "s"}`;
          return { ok: true, message: warnings === undefined ? base : `${base} (${warnings})` };
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
            return {
              ok: false,
              message: scrubSecrets(err instanceof Error ? err.message : String(err)),
            };
          }
        }
        const candidate = webPluginCandidates.find((c) => c.id === id);
        if (candidate === undefined)
          return { ok: false, message: "Nothing to verify for this plugin" };
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
          return {
            ok: false,
            message: scrubSecrets(err instanceof Error ? err.message : String(err)),
          };
        }
      },
      addPath: async (rawPath) => {
        const path = rawPath.trim();
        if (path.length === 0) return { ok: false, message: "Enter a path" };
        const abs = isAbsolute(path) ? path : resolvePath(config.cwd, path);
        // Explicit add-by-path is user consent to load that absolute path.
        const addDiag = createPluginLoadDiagnostics();
        const mod = await loadPluginEntry(abs, {
          cwd: config.cwd,
          origin: "path",
          diagnostics: addDiag,
        });
        // Collected, not emitted: `emitPluginWarningSummary` writes to stderr, and
        // a raw write lands mid-frame and corrupts the rendered transcript. The
        // warnings are folded into the result message below instead.
        if (mod === null) return { ok: false, message: `Could not load a plugin at ${path}` };
        if (mod.manifest === undefined) {
          return { ok: false, message: "Plugin has no manifest (needs id/name/kind)" };
        }
        const descriptor = toDescriptor(mod);
        if (descriptor === undefined) return { ok: false, message: "Invalid plugin manifest" };
        // Persist global path trust only once it resolves to a real plugin, so a
        // bogus path never leaves a dangling entry. Expand marketplaces so each
        // member is trusted (exact-path match on reload). `onSkip` collects into
        // `addDiag` instead of a raw stderr write — same reasoning as
        // `loadPluginEntry` above.
        const members = await expandPluginPath(abs, {
          onSkip: expandSkipDiagnosticsHandler(addDiag),
        });
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
        const warnings = formatPluginWarningsSummary(addDiag.warnings);
        notePluginWarnings(addDiag.warnings);
        return {
          ok: true,
          message:
            warnings === undefined
              ? `Added ${descriptor.name}`
              : `Added ${descriptor.name} (${warnings})`,
          id: descriptor.id,
        };
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
        livePluginConfig = {
          ...livePluginConfig,
          [id]: { ...(livePluginConfig[id] ?? {}), enabled: false },
        };
        await persistPluginSettings();
        return { ok: true, message: "Trust revoked — code stays unloaded from next launch" };
      },
    };

    const profilesDir = join(config.cwd, ".agents", "agents");
    const profileDiag = createPluginLoadDiagnostics();
    const pluginAgentProfiles = await resolveAgentPluginProfiles(
      executablePlugins(),
      config.settings?.plugins ?? {},
      { diagnostics: profileDiag },
    );
    emitPluginWarningLog(profileDiag);
    standingPluginWarnings.push(...profileDiag.warnings);
    const initialProfiles = await loadAgentProfiles(profilesDir, pluginAgentProfiles);
    const liveAgentProfiles = initialProfiles;

    // Skill directories from enabled plugins, in addition to project-local
    // `.agents`/`.claude`/`.codex/skills` that discoverSkills/resolveSkillBody check.
    const skillDirs = skillDirsFromEnabledPlugins(executablePlugins(), pluginConfig);

    const shellTimeout = shellTimeoutFromSettings(config.settings);
    // Mutable so Settings → waitForApproval takes effect on the next tool call
    // without rebuilding the toolset.
    const liveToolWatchdog: ToolWatchdogConfig = {
      ...(toolWatchdogFromSettings(config.settings) ?? {}),
    };
    // CL-5814: orchestrator is the only product path — no first-run mode picker.
    const liveSessionMode: SessionMode = "orchestrator";
    // Local settings still supply shell env; sessionMode is ignored if present.
    const localSettingsForEnv = await loadLocalSettings(localSettingsPath(config.cwd)).catch(
      () => null,
    );
    const toolAvailability: ToolAvailability = {
      languageServerAvailable: detectLanguageServerAvailable(config.cwd),
    };
    const advertisedBuiltInPrefix = advertisedToolNamesForSessionMode(
      liveSessionMode,
      toolAvailability,
    );
    // The workflow controller is built below, after the toolset; the holder lets
    // advance_workflow's handler read live workflow-active state without a
    // construction-order cycle.
    const workflowControllerHolder: { instance?: WorkflowController } = {};

    // Assigned before any tool runs; getter wires session blob reads into posix tools.
    let currentAgent!: Agent;
    // Set alongside currentAgent in buildAgent; getter wires the session's own
    // blob store into the truncation spill path (see result-truncation-plugin.ts).
    let currentStorage: ContextStore | null = null;

    const toolset = await createAgentToolset({
      cwd: config.cwd,
      permissionGate,
      skillDirs,
      telemetry: liveTelemetry,
      isCodex: isCodexProviderName(config.providerName),
      ...(shellTimeout !== undefined ? { shellTimeout } : {}),
      ...(localSettingsForEnv?.env !== undefined ? { shellEnv: localSettingsForEnv.env } : {}),
      toolWatchdog: liveToolWatchdog,
      getBlobReader: () => currentAgent.blobReader,
      getBlobWriter: () => currentStorage?.writeBlob,
      isWorkflowActive: () => workflowControllerHolder.instance?.isActive() === true,
      ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
      onOperatorGate: (question, options) =>
        new Promise<OperatorResult>((resolve) => {
          const { finish, signal } = attachApprovalBudget<OperatorResult>(resolve, {
            tool: "ask_operator",
            kind: "operator",
          });
          const timeout = approvalTimeout();
          const event: OperatorGateEvent = {
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
      ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
      mcpServersSource: config.mcpServersSource ?? "none",
      projectTrust,
      requestMcpTrust: async (server) => {
        // TOFU via operator gate: Trust this local MCP server?
        const result = await new Promise<OperatorResult>((resolve) => {
          const { finish, signal } = attachApprovalBudget<OperatorResult>(resolve, {
            tool: `mcp:${server.name}`,
            kind: "operator",
          });
          const timeout = approvalTimeout();
          const event: OperatorGateEvent = {
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
        getWorkdirBase: () => sessionDir(config.cwd, sessionId),
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
      sessionMode: liveSessionMode,
      toolAvailability,
    });

    const directorHolder: { instance?: ReturnType<typeof createChatDirector> } = {};
    const hostHolder: { instance?: Awaited<ReturnType<typeof mountRunnerHost>> } = {};

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
    // Advertise then family-gate wire schemas (kimi gets a non-recursive present).
    const computeAdvertised = (all: readonly ToolDefinition[]): ToolDefinition[] =>
      normalizeToolDefinitionsForProvider(
        advertisedTools(all, activatedToolNames.list(), advertisedBuiltInPrefix),
        { providerName: config.providerName, model: config.model },
      );

    const initialCodexProfile = codexProfileFromProviderName(config.providerName);
    const initialXaiProfile = xaiProfileFromProviderName(config.providerName);

    // Refresh the pinned Codex instructions without blocking TUI startup. Every
    // deliver below awaits settlement, so the first request never races the
    // refresh: codex-responses-adapter places the instructions at the top of
    // every request body, and an in-memory swap after inference #1 would change
    // the whole prefix and forfeit the provider prompt cache mid-session.
    // Best-effort, same as exec boot: on failure the session runs on
    // cached/bundled instructions.
    const codexInstructionsRefreshed: Promise<void> =
      initialCodexProfile === undefined
        ? Promise.resolve()
        : refreshCodexInstructions().catch((err: unknown) => {
            tuiLogger.warn("Codex instructions refresh failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });

    // Reload, interrupt, compaction continuation, and proxy deliver share one queue
    // so a rebuild never races an in-flight deliver.
    const sessionOps = createSessionOperationQueue();
    const enqueueAgentDeliver = (deliverToLiveAgent: () => void): void => {
      void sessionOps.enqueue(async () => {
        // The shell already popped the queue item and painted it as delivered
        // by the time this runs, so a failed rebuild must be surfaced here —
        // otherwise the message silently never reaches the agent.
        await deliverAgentMessage({
          getFatalBuildError: () => fatalBuildError,
          ready: codexInstructionsRefreshed,
          deliverToLiveAgent,
          onDeliverFailure: systemNotice,
        });
      });
    };

    const chatDirectorDef = defineDirector({
      id: `${ID_PREFIX}/chat`,
      configSchema: type({}),
      factory: (_config, _env, agentCtx) => {
        const d = createChatDirector(
          agentCtx.systemPrompt,
          computeAdvertised([...agentCtx.toolDefinitions]),
          {
            onActivateTools: (names) => promoteTools(names),
            inactivityTimeoutMs: config.inactivityTimeoutMs ?? 750_000,
            totalTimeoutMs: config.totalTimeoutMs,
            onTasksChange: (tasks) => emitter.emit("tasks", tasks),
            requestContinuation: () => {
              enqueueAgentDeliver(() => currentAgent.deliver(buildCompactionContinuationMessage()));
            },
            provider: { providerName: config.providerName, model: config.model },
            // Live id so mid-session `/model` updates xAI bare-429 remapping
            // without rebuilding the agent (aligned with transcript stamp).
            getProviderId: () => config.providerName,
          },
        );
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
    let liveSources = initialBundle.sources;
    let liveDefaultSource = initialBundle.defaultSource;

    // The source the next inference will use, tracked live so the compaction
    // summarizer always summarizes with the current model (model switches and
    // Codex token refreshes update it below).
    let liveSource: InferenceSource =
      liveSources.find((s) => s.id === liveDefaultSource) ??
      liveSources[0] ??
      buildInitialSourceFallback();

    function buildInitialSourceFallback(): InferenceSource {
      return initialCodexProfile !== undefined
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
    }

    // Compaction summarizer: produces a structured, workflow-aware handoff via a
    // one-shot call on the live model, falling back to the deterministic summary
    // on any failure. Workflow state is read at compaction time so a pass
    // mid-/build or mid-/plan still names the active step.
    const compactionSummarize = createModelSummarizer({
      getSource: () => liveSource,
      deps: inferenceDeps,
    });
    const summaryContext = (): SummaryContext | undefined => {
      const status = workflowController.status();
      if (!status.active) return undefined;
      return {
        workflow: {
          ...(status.name !== undefined ? { name: status.name } : {}),
          stepLabel: status.label,
          stepIndex: status.stepIndex,
          total: status.total,
        },
      };
    };

    // Mutable reference so the compaction summarize callback reads the live mode
    // without requiring an agent rebuild on every settings change.
    let liveCompactionMode = config.settings?.compactionMode ?? "llm";

    const buildAgent = async (): Promise<Agent> => {
      const storage = await createOptimizedContextStore(workdir);
      currentStorage = storage;
      const sources = liveSources.length > 0 ? liveSources : [liveSource];
      const defaultSource = liveDefaultSource.length > 0 ? liveDefaultSource : liveSource.id;
      return createAgentWithLiveToolDispatch(def, {
        sources,
        defaultSource,
        storage,
        workdir,
        // contextTransforms ride deps: the published @intx/agent forwards deps
        // into reactor assembly verbatim, and the vendored assembly picks the
        // transforms up from there.
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
            summarize: compactionSummarize,
            summaryContext,
            telemetry: liveTelemetry,
            // Main-session folds only — exec runner and subagents stay silent.
            onFolded: (info) => emitter.emit("compaction", info),
          }),
        },
      });
    };

    const turnObserver = createTurnObserver({
      telemetry: getTelemetry,
      getSessionId: () => sessionId,
      getSource: () => liveSource,
      subagentToolName: taskToolDefinition.name,
    });

    const runSink = createRunSink({
      emitter,
      hookManager,
      initialTurnCount: resumeSeed.turnsUsed,
      onTurnComplete: turnObserver.onTurnComplete,
      onTurnFailed: turnObserver.onTurnFailed,
      // persistRunSnapshot is defined below but not invoked until the stream
      // starts consuming events, well after this closure captures it.
      onTurnBoundarySnapshot: () => {
        void persistRunSnapshot("running");
      },
    });

    // MCP servers connected so far, keyed by name so a reconnect after a failure
    // replaces rather than duplicates the entry.
    let connectedMcpServers: ConnectedMcpServer[] = resumeSeed.mcpServers;
    // Every configured server's latest state, for the /mcp surface. Unlike
    // `connectedMcpServers` (persisted run metadata) this keeps the ones that
    // failed or are still waiting on authorization.
    const mcpStates = new Map<string, MCPServerState>();

    const writeRunSnapshot = async (
      status: RunState["status"],
      extra?: Pick<RunState, "finishedAt" | "error">,
      kind: SnapshotKind = "progress",
    ): Promise<void> => {
      const task = runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)";
      const model = `${liveSource.id}:${liveSource.model}`;
      // Kept in step with every persisted snapshot so the crash handler's copy
      // (activeRunHandle, read by index.ts) never lags what's actually on disk.
      activeRunHandle.task = task;
      activeRunHandle.startedAt = startedAt;
      activeRunHandle.model = model;
      const state: RunState = {
        status,
        turnsUsed: runSink.getTurnCount(),
        task,
        startedAt,
        model,
        mcpServers: connectedMcpServers,
        ...extra,
      };
      if (clearsActiveRun(kind)) {
        await finalizeRunState(config.cwd, sessionId, state);
      } else {
        await saveState(config.cwd, sessionId, state);
      }
    };

    // Progress snapshots are fired unsequenced (model switch, MCP connect, turn
    // completion), so a straggler could otherwise land after the terminal write
    // and resurrect status "running" — atomicWrite is last-rename-wins. Once the
    // run is finalized, drop them; the run-ending path writes through
    // writeRunSnapshot directly.
    //
    // Never a "run-end" write: everything routed here happens while the process
    // is still alive and must stay crash-coverable, including the rotation
    // "done" that closes out a session on /clear or /new.
    const persistRunSnapshot = async (
      status: RunState["status"],
      extra?: Pick<RunState, "finishedAt" | "error">,
      kind: Exclude<SnapshotKind, "run-end"> = "progress",
    ): Promise<void> => {
      if (finalized) return;
      await writeRunSnapshot(status, extra, kind);
    };

    // Cycles persist to the context store only on inference.done; the recorder
    // keeps the in-flight cycle's text so an errored or interrupted turn leaves
    // its partial output in partial.jsonl instead of vanishing.
    const cycleRecorder = createCycleTextRecorder(() => workdir);
    flushPartialOnCrash = () => cycleRecorder.dispose("crashed").then(() => undefined);
    const streamSink = (event: Parameters<typeof runSink.sink>[0]): void => {
      runSink.sink(event);
      cycleRecorder.handleEvent(event);
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
        try {
          const old = currentAgent;
          const closedCleanly = await closeAgentForRebuild(old, "reload");
          await streamPromise.catch((err: unknown) => {
            tuiLogger.debug("stream drain during reload teardown failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          if (!closedCleanly) {
            throw new AgentContextLockError(workdir);
          }
          currentAgent = await buildAgent();
          streamPromise = consumeStream(currentAgent.stream(), streamSink);
          // The rebuild made a fresh director; re-attach the active workflow.
          workflowController.reattach();
        } catch (err) {
          recordRunError(err);
          fatalBuildError = agentRebuildFailure(err);
        }
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
      initialCodexProfile !== undefined
        ? { profile: initialCodexProfile, source: liveSource }
        : undefined;
    let activeXaiSource: { profile: string; source: InferenceSource } | undefined =
      initialXaiProfile !== undefined
        ? { profile: initialXaiProfile, source: liveSource }
        : undefined;

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
    // Host mounts later; stampProvider.fn is wired once the bridge exists.
    const stampProvider: { fn: ((id: string | undefined) => void) | undefined } = {
      fn: undefined,
    };
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
        activeCodexSource =
          codexProfile !== undefined ? { profile: codexProfile, source } : undefined;
        activeXaiSource = xaiProfile !== undefined ? { profile: xaiProfile, source } : undefined;
        liveSource = source;
        liveSources = [source];
        liveDefaultSource = source.id;
        setAgentSourceUnlessClosed(currentAgent, source);
        stampProvider.fn?.(source.id);
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
          activeCodexSource =
            codexProfile !== undefined ? { profile: codexProfile, source: head } : undefined;
          activeXaiSource =
            xaiProfile !== undefined ? { profile: xaiProfile, source: head } : undefined;
          liveSource = head;
          stampProvider.fn?.(head.id);
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

    // Hard stop only (Ctrl+C / doInterrupt). Soft steer (Enter mid-run enqueue)
    // and follow-up (queued drain / deliver) must never call this — those paths
    // leave in-flight workers running. Closing the agent is the only thing that
    // aborts the reactor mid-inference (the send signal only rejects the send
    // promise); that close cascades: operationController.abort → task-tool parent
    // signal → child abort. Do not add cancelAll here — fleet cancelAll is
    // reserved for /clear (newSession) and shutdown.
    // Close it, drain the old stream, and rebuild a fresh agent so the next send
    // works.
    const interrupt = (): void => {
      sendAborted = true;
      void enqueueOp(async () => {
        try {
          // close() tears down stream consumers before the aborted cycle's
          // inference.error is delivered, so the recorder never sees a terminal
          // event for the dead cycle — dispose closes it against stray deltas
          // and salvages the buffer before that teardown, so it is never lost
          // or misattributed to the rebuilt agent's next cycle.
          await cycleRecorder.dispose("interrupted");
          const closedCleanly = await closeAgentForRebuild(currentAgent, "interrupt");
          await streamPromise.catch((err: unknown) => {
            tuiLogger.debug("stream drain during interrupt teardown failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          if (!closedCleanly) {
            throw new AgentContextLockError(workdir);
          }
          currentAgent = await buildAgent();
          cycleRecorder.reset();
          streamPromise = consumeStream(currentAgent.stream(), streamSink);
          workflowController.reattach();
          fatalBuildError = null;
        } catch (err) {
          recordRunError(err);
          fatalBuildError = agentRebuildFailure(err);
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
      cancelFeedbackCapture();
      // Wipe the painted transcript immediately. The product host listens for
      // session.clear; the Ink App used to clear its own stream unconditionally
      // and that path never moved to OpenTUI.
      emitter.emit("session.clear");
      // Cancel live workers before rotation so /clear does not leave orphaned
      // child reactors burning tokens under the old session id.
      subAgentSessions.cancelAll("Session cleared");
      // Backend rotation is always enqueued regardless of contention; the queue
      // serialises it behind any in-progress op. Sub-agents nest under the new
      // session automatically because getWorkdirBase reads the live sessionId.
      void enqueueOp(async () => {
        try {
          // Tear the old agent down and dispose the recorder before workdir is
          // repointed: the pump can deliver stray deltas until the stream
          // settles, and a dead cycle's partial must land in the session that
          // produced it, not the fresh one.
          await cycleRecorder.dispose("rotation");
          // Deliberately not routed through closeAgentForRebuild/
          // agentRebuildFailure (unlike interrupt and reloadIfIdle, CL-5753):
          // rotation mints a fresh sessionId/workdir below before calling
          // buildAgent(), so even a close() that leaks the old workdir's lock
          // (see closeAgentForRebuild's doc comment) can never cause a second
          // acquisition on that same workdir — buildAgent() always targets
          // the new, unlocked directory. The old lock still leaks for the
          // rest of the process, but nothing ever tries to re-acquire it, so
          // there is no crash to guard against here.
          await currentAgent.close().catch((err: unknown) => {
            tuiLogger.debug("agent.close during session-rotation teardown failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          await streamPromise.catch((err: unknown) => {
            tuiLogger.debug("stream drain during session-rotation teardown failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          await persistRunSnapshot("done", { finishedAt: Date.now() }, "session-rotation");
          sessionId = generateSessionId();
          // Repointed, not cleared: the process lives on, so the crash handler
          // must keep finding this handle and close out the *new* session.
          activeRunHandle.sessionId = sessionId;
          startedAt = Date.now();
          runTaskTitle = config.task;
          emitter.emit(
            "session.title",
            runTaskTitle.trim().length > 0
              ? truncateSessionLabel(runTaskTitle)
              : "Untitled session",
          );
          workdir = sessionContextDir(config.cwd, sessionId);
          await initSessionDir(config.cwd, sessionId);
          permissionGate.reset();
          runSink.reset();
          currentAgent = await buildAgent();
          cycleRecorder.reset();
          streamPromise = consumeStream(currentAgent.stream(), streamSink);
          await persistRunSnapshot("running");
          // A fresh session drops any active workflow.
          workflowController.reset();
          fatalBuildError = null;
          // Sink and director are empty now — repaint so the meter stays hidden
          // rather than showing the pre-clear occupancy until the next turn.
          hostHolder.instance?.refreshCostContext();
        } catch (err) {
          recordRunError(err);
          fatalBuildError = err instanceof Error ? err : new Error(String(err));
        }
      });
    };

    // The `onboarded` flag is global user state: read and written against the TRUE
    // global settings file, never config.globalSettingsPath (which is the --config
    // file when one was given). This keeps first-run detection consistent and stops
    // a --config launch from stamping project-config contents into the global file.
    const trueGlobalSettingsPath = globalSettingsPath();
    const globalSettingsForOnboarding = await loadSettings(trueGlobalSettingsPath);

    // Consent by proceeding (see telemetry/first-run.ts): on a first run the
    // singleton is a held no-op and the passive banner below is the
    // disclosure. The first interactively submitted prompt activates telemetry
    // and fires the held cli_start; a user who never acts keeps the hold for
    // this whole launch, and the render stamp means events start normally on
    // the next one. Keyed off the same TRUE global settings file as
    // `onboarded` above.
    const onChangeTelemetryEnabled = createTelemetryToggleHandler(trueGlobalSettingsPath);
    const telemetryFirstRun = telemetryFirstRunPending(globalSettingsForOnboarding);
    const telemetryNotice = telemetryStartupNotice(globalSettingsForOnboarding);
    // Tracks the user's intent (persisted opt-in, updated live by the settings
    // toggle) rather than the held instance's state, so the settings tab shows
    // On during the hold and an opt-out before the first action suppresses
    // activation entirely.
    let liveTelemetryIntent = telemetryFirstRun || getTelemetry().enabled;
    // Off by default: the prompt border's running cost is a distraction most
    // sessions do not want. /cost stays available regardless.
    let liveShowPromptCost = config.settings?.showPromptCost ?? false;
    if (telemetryFirstRun) {
      void markTelemetryNoticeShown(trueGlobalSettingsPath).catch(() => {
        // Best-effort: worst case the notice shows again next launch.
      });
    }

    // Post-upgrade release notes watermark policy (CL-5475):
    // - first_install: stamp quietly so later launches do not dump history.
    // - upgrade: stamp only when notes were actually shown. The former Ink
    //   whats-new banner is gone on the OpenTUI path, so notesShown is false
    //   until a surface is restored — never silently consume upgrade notes.
    // - resume / current: leave the watermark alone.
    const changelogDecision = loadStartupChangelogMarkdown({
      lastChangelogVersion: globalSettingsForOnboarding?.lastChangelogVersion,
      packageVersion: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    });
    const notesShown = false;
    const stampVersion = stampVersionAfterStartup(changelogDecision, notesShown);
    if (stampVersion !== null) {
      void markLastChangelogVersion(trueGlobalSettingsPath, stampVersion).catch(() => {
        // Best-effort watermark.
      });
    }

    // One tail for every RMW of config.globalSettingsPath from this runner so
    // /yolo and /settings toggles cannot stale-RMW each other.
    let persistTail = Promise.resolve();
    const enqueueGlobalPersist = <T>(job: () => Promise<T>): Promise<T> => {
      const run = persistTail.then(job);
      persistTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    // Absent file → fresh base; unreadable/invalid → skip the write rather than
    // clobber a corrupt settings file with a minimal shell.
    const persistGlobalSettings = (
      what: string,
      apply: (base: Settings) => Settings,
    ): Promise<boolean> =>
      enqueueGlobalPersist(async () => {
        const base = await loadGlobalSettingsWriteBase(config.globalSettingsPath);
        if (base === null) {
          tuiLogger.warn("Skipping {what} write: unreadable global settings at {path}", {
            what,
            path: config.globalSettingsPath,
          });
          return false;
        }
        await saveGlobalSettings(config.globalSettingsPath, apply(base));
        return true;
      });

    const commandContext: CommandContext = {
      signalClear: newSession,
      getSkipPermissions: () => permissionGate.getSkipPermissions(),
      setSkipPermissions: (value: boolean) => {
        permissionGate.setSkipPermissions(value);
        config.dangerouslySkipPermissions = value;
        void enqueueGlobalPersist(async () => {
          try {
            const result = await persistSkipPermissionsDefault(config.globalSettingsPath, value);
            if (result === "skipped") {
              systemNotice("Yolo flipped for this session, but the default did not stick.");
            }
          } catch {
            systemNotice("Yolo flipped for this session, but the default did not stick.");
          }
        });
      },
      getCostSummary: (): CostSummary => {
        const usage = runSink.getTokenUsage();
        const lastTurnUsage = runSink.getLastTurnUsage();
        const pricingCache = getActivePricingCache();
        const faremeter = createFaremeter({ modelId: config.model, pricingCache });
        faremeter.addUsage(usage);
        const totalCost = faremeter.getTotalCost();
        // A provider that omits or zeroes usage would otherwise pin the meter at
        // 0% forever; fall back to the director's local estimate (turns plus
        // system-prompt/tool-schema overhead). The governor already decided
        // whether it's estimating when it computed this turn's arming — trust
        // that decision rather than re-deriving it from a second usage read.
        const contextEstimate = directorHolder.instance?.getContextEstimate();
        const isEstimate = contextEstimate !== undefined && contextEstimate.isEstimate;
        const summary = buildCostSummary({
          modelId: config.model,
          baseURL: config.baseURL,
          pricingCache,
          totalCost,
          formattedCost: formatCost(totalCost),
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          contextTokens: isEstimate
            ? contextEstimate.tokens
            : contextTokensFromUsage(lastTurnUsage),
          contextIsEstimate: isEstimate,
        });
        return maskContextMeterWhenNoTurns(summary, runSink.getTurnCount());
      },
      startWorkflow: (name) => workflowController.start(name),
      getFleetStatus: () => fleetDigest(subAgentSessions.list(), Date.now()),
      renameSession: (name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return "Session name cannot be empty";
        runTaskTitle = trimmed;
        emitter.emit("session.title", truncateSessionLabel(runTaskTitle));
        void renameSession(config.cwd, sessionId, trimmed).then(() =>
          persistRunSnapshot("running"),
        );
        return undefined;
      },
      submitFeedback: (text) => {
        // Inline /feedback <text> must drop a prior bare-/feedback arm so the
        // next normal prompt is not stolen as survey text.
        cancelFeedbackCapture();
        const status = captureFeedback(getTelemetry(), text, {
          turnTraceId: getLastTurnTraceId(),
        });
        return feedbackResultMessage(status);
      },
      beginFeedbackCapture: () => {
        armFeedbackCapture();
      },
    };

    // Routed through the shell's notice path rather than straight into the
    // transcript: anything the runner says before the first turn arrives while
    // the landing hero still owns the screen, and a transcript row there wipes
    // the whole composition. Once a session row has ended the landing this is an
    // ordinary system row, so there is no second behaviour to reason about.
    const systemNotice = (text: string): void => {
      surfaceSystemNotice(host.shell, text);
    };

    /** Settle the shell after a rejected send so the run does not look live. */
    const handleSendFailure = (err: unknown): void => {
      const failure = classifyAgentSendFailure(err, sendAborted, isCodexAuthError, isXaiAuthError);
      captureAuthFailure(getTelemetry(), failure);
      if (!shouldSettleUiAfterSendFailure(failure.kind)) return;
      recordRunError(err);
      systemNotice(err instanceof Error ? err.message : String(err));
      setShellRunState(host.shell, "idle");
    };

    // The permissions surface addresses grants by their position in the last
    // listing, so revoke resolves against the same snapshot the operator saw.
    let listedGrants: readonly ScopedApproval[] = [];

    const localSettingsFile = localSettingsPath(config.cwd);

    const applyCommandResult = (result: CommandResult): void => {
      switch (result.type) {
        case "message":
          systemNotice(result.text);
          return;
        case "send":
          // A command the operator typed and submitted at the prompt — same
          // provenance as a plain-text send, just composed by the command
          // handler instead of typed verbatim.
          void agentProxy.send(userInboundMessage(result.text, [])).catch(handleSendFailure);
          return;
        case "workflow":
          systemNotice(workflowController.start(result.name));
          return;
        case "noop":
          return;
        case "overlay":
          if (!host.openSurface(result.overlay)) {
            systemNotice(`No surface for /${result.overlay}.`);
          }
          return;
        case "modal":
          // /model is the only modal reachable from a command; provider login is
          // reached from the picker itself.
          if (result.modal === "agent" && host.openSurface("models")) return;
          systemNotice(`${result.modal} is not available in this renderer yet`);
          return;
        case "view":
          systemNotice(`${result.view} is not available in this renderer yet`);
          return;
        case "paste-image":
          void attachClipboardImage(host.shell);
          return;
      }
    };

    /**
     * Full user-prompt send path: inline image paths become attachments,
     * @mentions are expanded, and the message is recorded for Up/Down recall.
     */
    const sendUserPrompt = async (
      text: string,
      pending: readonly PendingImageAttachment[],
    ): Promise<void> => {
      sendAborted = false;
      if (text.trim().length > 0) {
        void appendSentMessage(config.cwd, sessionId, text).catch((err: unknown) => {
          tuiLogger.debug("sent-message append failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      const ingested = await ingestPathMentions(text, config.cwd, imageAttachmentFromPath);
      const resolved = await resolveAtMentions(ingested.text, config.cwd);
      const attachments = [...pending, ...ingested.attachments];
      await agentProxy.send(userInboundMessage(resolved, attachments));
    };

    const dispatchCommand = (name: string, args: string): void => {
      const command = getCommand(name);
      if (command === undefined) {
        systemNotice(`Unknown command: ${name}`);
        return;
      }
      // Plugins register into the same command registry as the built-ins, so an
      // unrecognised name is plugin-authored and is bucketed rather than sent.
      // Shared emitter so TUI and any headless path report the same event.
      captureSlashCommand(getTelemetry(), command.name);
      applyCommandResult(command.handler(args, commandContext));
    };

    // Mount OpenTUI before the initial task is sent so gate and stream listeners
    // are registered first. Ctrl+C stays with the shell (interrupt the run);
    // OpenTUI owns the alternate screen and mouse reporting itself.
    // Alt+A add-provider selector rows: every first-class provider kind, including
    // Custom (full manual form). No already-connected filtering — OAuth and
    // multi-instance accounts are per-name, so dropping a kind once it has one
    // account would hide the path to a second. Read fresh on each open against
    // the live catalog.
    const computeAddProviderChoices = () =>
      addProviderSelectorChoices(providerChoices(), config.providers);

    const host = await mountRunnerHost({
      // An unnamed session shows nothing rather than a placeholder.
      title: runTaskTitle,
      cwd: process.cwd(),
      eventEmitter: emitter,
      send: createSubmitHandler({
        dispatchCommand: (name, args) => dispatchCommand(name, args),
        sendPrompt: (text, attachments) => {
          void sendUserPrompt(text, attachments ?? []).catch(handleSendFailure);
        },
        onPromptSubmitted: () => {
          if (telemetryFirstRun && liveTelemetryIntent) {
            void activateHeldTelemetry(trueGlobalSettingsPath, () => liveTelemetryIntent);
          }
        },
        isFeedbackCapturePending,
        cancelFeedbackCapture,
        onFeedbackText: (text) => {
          takeFeedbackCapture();
          const status = captureFeedback(getTelemetry(), text, {
            turnTraceId: getLastTurnTraceId(),
          });
          return feedbackResultMessage(status);
        },
        onSystemNotice: systemNotice,
      }),
      classifySubmit: (text, attachments) =>
        classifySubmission(text, {
          hasAttachments: attachments !== undefined && attachments.length > 0,
          feedbackPending: isFeedbackCapturePending(),
          feedbackCaptureEnabled: true,
        }),
      interrupt,
      // Consent by proceeding requires the disclosure to be on screen before the
      // first prompt activates the held telemetry instance: the landing shows it,
      // and the shell re-files it into the transcript when the landing clears.
      ...(telemetryNotice !== undefined ? { telemetryNotice } : {}),
      providers: config.providers,
      recentModels: listRecentModels(config.settings ?? { providers: {} }),
      favoriteModels: listFavoriteModels(config.settings ?? { providers: {} }),
      addProviderChoices: computeAddProviderChoices,
      onConnectProvider: (providerName) => {
        void (async () => {
          let result: Awaited<ReturnType<typeof connectProviderInline>>;
          // The setup surface shares the live session's renderer — a second
          // CliRenderer cannot exist on the same stdin. Shell input stays
          // suspended for the surface's lifetime so its keystrokes (including
          // Ctrl+C to cancel the sign-in) never also reach the shell.
          setShellInputSuspended(host.shell, true);
          try {
            result = await connectProviderInline({
              providerId: providerName,
              settingsPath: trueGlobalSettingsPath,
              localSettingsPath: localSettingsFile,
              existing: config.settings ?? null,
              createRenderer: () => Promise.resolve(host.renderer),
            });
          } catch (err) {
            systemNotice(
              `Connecting ${providerName} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          } finally {
            setShellInputSuspended(host.shell, false);
            // The setup surface focused its own input; hand focus back to
            // whatever shell zone owned it before the surface mounted.
            applyFocus(host.shell);
          }
          if (!result.connected) return;

          const onDisk = await loadSettings(trueGlobalSettingsPath);
          const resolvedForCatalog: ResolvedProvider = {
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            model: config.model,
            providerName: config.providerName,
            ...(config.keyless !== undefined ? { keyless: config.keyless } : {}),
          };
          const providers = await refreshLiveProviderCatalog(onDisk, resolvedForCatalog);
          config = { ...config, providers, ...(onDisk !== null ? { settings: onDisk } : {}) };
          host.refreshModels(
            listRecentModels(config.settings ?? { providers: {} }),
            listFavoriteModels(config.settings ?? { providers: {} }),
            providers,
          );
          // Reopen positioned at the account just connected — the picker's
          // default open (top of list) would otherwise leave the operator to
          // hunt for the row they just authorized.
          const connectedName = result.providerName ?? providerName;
          host.openModels?.(
            result.model !== undefined ? modelOptionId(connectedName, result.model) : undefined,
          );
          systemNotice(`Connected ${connectedName}. Open /model to pick a model.`);
        })().catch((err: unknown) => {
          tuiLogger.debug("provider connect failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      modelLabel: () => {
        const effort = resolveSessionEffort(
          config.model,
          config.reasoningEffort,
          isCodexProviderName(config.providerName),
        );
        return {
          profile: config.providerName,
          model: config.model,
          ...(effort !== undefined ? { effort } : {}),
        };
      },
      activeModel: () => ({ provider: config.providerName, model: config.model }),
      readCostSummary: () => commandContext.getCostSummary?.(),
      showPromptCost: () => liveShowPromptCost,
      onModelSelect: (id) => {
        const sep = id.indexOf(":");
        if (sep <= 0) return;
        const provider = id.slice(0, sep);
        const model = id.slice(sep + 1);
        config = { ...config, providerName: provider, model };
        host.bridge.setInferenceProviderId(provider);
        const bundle = buildSessionSources();
        agentProxy.setSources(bundle.sources, bundle.defaultSource);

        const ref: ModelRef = { provider, model };
        void (async () => {
          const onDisk = (await loadGlobalSettingsWriteBase(trueGlobalSettingsPath)) ?? {
            providers: {},
          };
          const next = pushRecentModel(onDisk, ref);
          await saveGlobalSettings(trueGlobalSettingsPath, next);
          config = { ...config, settings: next };
          host.refreshModels(listRecentModels(next), listFavoriteModels(next));
        })().catch((err: unknown) => {
          tuiLogger.debug("model selection persist failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      onFavoriteToggle: (id) => {
        const sep = id.indexOf(":");
        if (sep <= 0) return;
        const ref: ModelRef = { provider: id.slice(0, sep), model: id.slice(sep + 1) };
        void (async () => {
          const onDisk = (await loadGlobalSettingsWriteBase(trueGlobalSettingsPath)) ?? {
            providers: {},
          };
          const next = toggleFavoriteModel(onDisk, ref);
          await saveGlobalSettings(trueGlobalSettingsPath, next);
          config = { ...config, settings: next };
          host.refreshModels(listRecentModels(next), listFavoriteModels(next));
        })().catch((err: unknown) => {
          tuiLogger.debug("favorite toggle persist failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      onSetDefault: (id) => {
        const sep = id.indexOf(":");
        if (sep <= 0) return;
        const ref: ModelRef = { provider: id.slice(0, sep), model: id.slice(sep + 1) };
        void (async () => {
          const onDisk = (await loadGlobalSettingsWriteBase(trueGlobalSettingsPath)) ?? {
            providers: {},
          };
          const next = setDefaultModel(onDisk, ref);
          await saveGlobalSettings(trueGlobalSettingsPath, next);
          await persistConnectedSelection(localSettingsFile, ref.provider, ref.model);
          config = { ...config, settings: next };
          systemNotice(`Default set to ${ref.model} (${ref.provider})`);
        })().catch((err: unknown) => {
          tuiLogger.debug("set default persist failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      commands: listCommands().map((c) => ({ name: c.name, description: c.description })),
      onCommand: (name) => {
        const route = routeSubmission(name);
        if (route.kind === "empty") return;
        if (route.kind === "command") {
          dispatchCommand(route.name, route.args);
          return;
        }
        const [commandName = "", ...rest] = route.text.split(/\s+/);
        dispatchCommand(commandName, rest.join(" "));
      },
      chrome: () => ({
        tasks: directorHolder.instance?.getTasks() ?? null,
        agents: subAgentSessions.listForStrip().map((s) => ({
          agentId: s.agentId,
          id: s.id,
          description: s.description,
          status: s.status,
          currentToolName: s.currentToolName,
          currentToolPreview: s.currentToolPreview,
          currentToolStartedAt: s.currentToolStartedAt,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
          ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
        })),
      }),
      subscribeChrome: (notify) => {
        const unsubscribeAgents = subAgentSessions.subscribe(notify);
        emitter.on("tasks", notify);
        return () => {
          unsubscribeAgents();
          emitter.off("tasks", notify);
        };
      },
      subAgentSessions: () => subAgentSessions.list(),
      surfaces: {
        permissions: {
          list: async () => {
            listedGrants = await permissionsAdmin.list();
            return listedGrants.map((entry, index) => ({
              id: String(index),
              scopeLabel: GRANT_SCOPE_LABEL[entry.scope],
              tool: entry.tool,
              pattern: entry.pattern,
              ...(entry.providerModel !== undefined ? { providerModel: entry.providerModel } : {}),
            }));
          },
          revoke: async (id) => {
            const entry = listedGrants[Number(id)];
            if (entry !== undefined) await permissionsAdmin.revoke(entry);
          },
        },
        plugins: {
          list: () => {
            const cfg = pluginsAdmin.getConfig();
            return pluginsAdmin.list().map((p) => {
              const mod = livePluginModules.find((m) => m.manifest?.id === p.id);
              const attributed = warningsForPluginEntry(standingPluginWarnings, {
                id: p.id,
                ...(p.agentProfiles !== undefined ? { agentProfiles: p.agentProfiles } : {}),
              });
              return {
                id: p.id,
                name: p.name,
                enabled: cfg[p.id]?.enabled === true,
                credentials: p.credentials,
                credentialValues: cfg[p.id]?.credentials ?? {},
                ...(p.kind !== undefined ? { kind: p.kind } : {}),
                ...(p.description !== undefined ? { description: p.description } : {}),
                ...(p.needsTrust === true ? { needsTrust: true } : {}),
                ...(p.canRevokeTrust === true ? { canRevokeTrust: true } : {}),
                ...(p.agentProfiles !== undefined ? { agentProfiles: p.agentProfiles } : {}),
                ...(p.needsTrust === true && mod?.pluginPath !== undefined
                  ? { originPath: mod.pluginPath }
                  : {}),
                ...(attributed.length > 0 ? { warnings: attributed } : {}),
              };
            });
          },
          setEnabled: async (id, enabled) => {
            const existing = pluginsAdmin.getConfig()[id] ?? {};
            return (await pluginsAdmin.saveConfig(id, { ...existing, enabled })) ?? undefined;
          },
          saveCredentials: async (id, credentials) => {
            const existing = pluginsAdmin.getConfig()[id] ?? {};
            await pluginsAdmin.saveConfig(id, { ...existing, credentials });
          },
          verify: (id, credentials) => pluginsAdmin.verify(id, credentials),
          addPath: (path) => pluginsAdmin.addPath(path),
          webProviders: () => webPluginCandidates.map((c) => ({ id: c.id, name: c.name })),
          currentWebProvider: () => pluginsAdmin.getWebOverride(),
          setWebProvider: (id) => pluginsAdmin.setWebOverride(id),
          loadWarnings: () => standingPluginWarnings,
        },
        mcp: {
          list: () =>
            [...mcpStates.values()].map((status) => ({
              name: status.name,
              state: status.state,
              ...(status.state === "connected" ? { toolCount: status.tools.length } : {}),
              ...(status.state === "needs-auth" ? { authURL: status.url } : {}),
              ...(status.state === "failed" ? { error: status.error } : {}),
            })),
          openAuthURL: (url) => openInBrowser(url),
        },
        hooks: {
          list: () =>
            hookManager.getStatuses().map((status) => ({
              id: status.id,
              name: status.name,
              type: status.type,
              path: status.path,
              enabled: status.enabled,
              runsOn: hookRunsOn.get(status.id) ?? "see file",
            })),
          setEnabled: (id, enabled) => setHookEnabled(id, enabled),
        },
        settings: {
          read: () => ({
            compactionMode: liveCompactionMode,
            waitForApproval: resolveWaitForApproval(liveToolWatchdog),
            telemetryEnabled: liveTelemetryIntent,
            showPromptCost: liveShowPromptCost,
          }),
          setCompactionMode: (mode) => {
            liveCompactionMode = mode;
            void persistGlobalSettings("compaction mode", (base) => ({
              ...base,
              compactionMode: mode,
            }));
          },
          setWaitForApproval: (value) => {
            liveToolWatchdog.waitForApproval = value;
            void persistGlobalSettings("wait-for-approval", (base) => ({
              ...base,
              tools: { ...base.tools, waitForApproval: value },
            }));
          },
          setTelemetryEnabled: (enabled) => {
            // Only flip the live intent when the toggle is accepted. Env kill
            // switches refuse re-enable; leaving the UI on while capture stays
            // off is a silent lie.
            if (!onChangeTelemetryEnabled(enabled)) {
              systemNotice("Telemetry stays off — disabled by DO_NOT_TRACK or CORBITS_TELEMETRY.");
              return;
            }
            liveTelemetryIntent = enabled;
          },
          setShowPromptCost: (value) => {
            liveShowPromptCost = value;
            host.refreshCostContext();
            void persistGlobalSettings("show prompt cost", (base) => ({
              ...base,
              showPromptCost: value,
            }));
          },
          hooksSummary: () => {
            const statuses = hookManager.getStatuses();
            return {
              discovered: statuses.length,
              off: statuses.filter((s) => !s.enabled).length,
            };
          },
          openHooks: () => dispatchCommand("hooks", ""),
        },
      },
    });
    hostHolder.instance = host;

    const shutdownRuntime = createRuntimeShutdown({
      disposeHost: host.dispose,
      cancelWorkers: () => {
        subAgentSessions.cancelAll("Session closed");
      },
      closeAgent: () => currentAgent.close(),
    });
    disposeHost = () => {
      void shutdownRuntime();
    };
    setActiveDisposeHost(disposeHost);

    // Harness inference.error events omit providerId; stamp the live catalog id
    // onto the stream map so transcript copy can identify known-xAI short 429s.
    stampProvider.fn = (id) => host.bridge.setInferenceProviderId(id);
    stampProvider.fn(config.providerName);

    setMentionSuggestionSource(host.shell, (prefix) => listPathSuggestions(prefix, config.cwd));

    // The fleet reports itself. Store changes drive it, so a lane finishing or
    // failing is on screen the moment it happens rather than at the next turn
    // boundary. The settle timer coalesces a parallel burst into one observation;
    // the stall poll re-runs so a lane that goes quiet with no further store
    // event is still announced once. `observeFleet` decides what is worth saying.
    let fleetWatch = createFleetWatch();
    const reportFleet = (): void => {
      const observation = observeFleet(fleetWatch, subAgentSessions.list(), Date.now());
      fleetWatch = observation.watch;
      for (const update of observation.updates) surfaceSystemNotice(host.shell, update);
    };
    let fleetSettle: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeFleetReport = subAgentSessions.subscribe(() => {
      if (fleetSettle !== null) return;
      fleetSettle = setTimeout(() => {
        fleetSettle = null;
        reportFleet();
      }, FLEET_REPORT_SETTLE_MS);
      if (typeof fleetSettle.unref === "function") fleetSettle.unref();
    });
    const fleetStallPoll = setInterval(reportFleet, FLEET_STALL_POLL_MS);
    if (typeof fleetStallPoll.unref === "function") fleetStallPoll.unref();

    // Registered slash-command names only — bare skill/agent words stay unstyled.
    setPromptRecognitionSource(host.shell, () => ({
      commandNames: listCommands().map((command) => command.name),
    }));

    // Shift+Tab: cycle reasoning effort for the live model and rebuild sources so
    // the next inference turn picks up the new providerOptions.reasoning_effort.
    setEffortCycleHandler(host.shell, () => {
      const next = cycleReasoningEffort(
        config.model,
        config.reasoningEffort,
        isCodexProviderName(config.providerName),
      );
      if (next === undefined) {
        setStatusFlash(host.shell, "this model has no reasoning effort levels");
        return;
      }
      config = { ...config, reasoningEffort: next };
      const bundle = buildSessionSources();
      agentProxy.setSources(bundle.sources, bundle.defaultSource);
      setPromptModelLabel(host.shell, {
        profile: config.providerName,
        model: config.model,
        effort: next,
      });
      setStatusFlash(host.shell, `reasoning effort: ${next}`);
    });

    // Recall spans the whole session, including what was sent before a resume.
    void loadSentMessages(config.cwd, sessionId)
      .then((sent) => setSentMessageHistory(host.shell, sent))
      .catch(() => undefined);

    if (!resumeSkipInitialTask && config.task.trim().length > 0) {
      // The operator's initial task, typed as a CLI argument before launch —
      // same provenance as a prompt submit.
      void agentProxy.send(userInboundMessage(config.task.trim(), [])).catch(handleSendFailure);
    }

    // Hydrate a resumed session's transcript after first paint. Reading history and
    // mapping it to content blocks is pure I/O with no bearing on the shell, so the
    // App renders empty immediately and fills in the past turns once they are ready.
    // Only the tail needed to fill RESUME_TRANSCRIPT_BLOCK_LIMIT blocks is read from
    // disk — a long session's full history is not needed just to paint a transcript
    // that itself caps how much it displays.
    void loadRecentTurns(workdir, RESUME_TRANSCRIPT_BLOCK_LIMIT)
      .then((turns) => {
        const blocks = turnsToContentBlocks(turns, { maxBlocks: RESUME_TRANSCRIPT_BLOCK_LIMIT });
        const tasks = hydrateTasksFromTurns(turns);
        // Restored tasks go to the panel only. They are live state, not something
        // that happened in the conversation, so putting them in scrollback as well
        // renders the same list twice on one screen.
        if (tasks.length > 0) directorHolder.instance?.restoreTasks(tasks);
        if (blocks.length > 0) emitter.emit("history.hydrate", blocks);
      })
      .catch((err: unknown) => {
        // Resume still works without painted history, but a silent empty
        // transcript looks like a brand-new session. Log and surface a one-line
        // error block so the operator knows history failed to load.
        const block = resumeTranscriptLoadErrorBlock(err);
        tuiLogger.warn("Failed to load resume transcript from {workdir}: {error}", {
          workdir,
          error: err instanceof Error ? err.message : String(err),
        });
        emitter.emit("history.hydrate", [block]);
      });

    // Connect MCP servers after the TUI is up so the UI is usable immediately and
    // any OAuth authorization is surfaced as a copyable link rather than a browser
    // pop. Each connected server's tools land on the live runner and are
    // dispatchable the same turn (createAgentWithLiveToolDispatch). They stay
    // unadvertised until tool_search promotes them. When every server has
    // settled, reload-if-idle so construction-time maps match, then resume any
    // persisted workflow. Aborted on exit so an unfinished auth wait does not
    // keep the process alive.
    const mcpConnectController = new AbortController();
    void toolset
      .connectMCP(
        {
          interactiveAuth: true,
          onStatus: (status) => {
            mcpStates.set(status.name, status);
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

    // Surface fire-and-forget startup notices now that there is a shell (queued
    // above, before `host` existed). Plugin load warnings are NOT notices — they
    // drive `plugin !` and `/plugins` instead.
    for (const notice of startupPluginNotices) surfaceSystemNotice(host.shell, notice);
    paintPluginAttention = (needs) => setPluginNeedsAttention(host.shell, needs);
    paintPluginAttention(standingPluginWarnings.length > 0);

    // The persisted /yolo default is otherwise silent: nothing on screen would
    // otherwise tell the operator that permission prompts are off for a repo
    // they never ran --dangerously-skip-permissions or /yolo in.
    if (config.skipPermissionsFromSettings) {
      surfaceSystemNotice(
        host.shell,
        "Permission prompts are disabled by your saved default (/yolo off to re-enable).",
      );
    }

    // Soft upgrade check: never blocks startup; offline / rate-limit is a quiet skip.
    // surfaceSystemNotice keeps the landing hero up and flushes into the transcript
    // once a session row ends the landing (same path as MCP startup chatter).
    scheduleUpgradeNotice({
      notify: (text) => surfaceSystemNotice(host.shell, text),
      options: {
        currentVersion: typeof pkg.version === "string" ? pkg.version : "0.0.0",
      },
    });

    await host.waitUntilExit();
    // Stop inference and every worker before persistence, hooks, or telemetry can
    // delay process exit. Closing the terminal is a process-lifetime boundary.
    await shutdownRuntime();
    clearInterval(fleetStallPoll);
    if (fleetSettle !== null) clearTimeout(fleetSettle);
    unsubscribeFleetReport();
    // Quitting mid-stream is an abnormal end for the in-flight cycle: nothing
    // downstream delivers its terminal event once the app is gone.
    await cycleRecorder.dispose("exit");
    mcpConnectController.abort();

    const finishedAt = Date.now();
    const turnCollector = runSink.getTurnCollector();
    const sinkError = runSink.getRunError();
    const summaryStatus = runSink.getStatus();
    // RunSummary's status ("done" | "failed" | "cancelled") maps directly onto
    // RunState's terminal statuses — no fallback to "running" here, otherwise a
    // finished run (finishedAt set) can be left reading as still in progress.
    const persistedStatus: RunState["status"] = summaryStatus;
    finalized = true;
    // The run itself is over here, so this write clears the active-run handle
    // (via finalizeRunState in state.ts) in the same call, rather than pairing
    // the on-disk write with a separate in-memory statement at this call site.
    // The dispose host has no on-disk counterpart to piggyback on, so it still
    // needs its own clear here, mirroring finalizeOnCrash — otherwise a signal
    // arriving after this normal exit would find a handle pointing at a
    // torn-down closure.
    clearActiveDisposeHost();
    await writeRunSnapshot(
      persistedStatus,
      {
        finishedAt,
        ...(sinkError !== undefined ? { error: sinkError } : {}),
      },
      "run-end",
    );
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
    const exitReason =
      runSummary.status === "done"
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
    // PerfTrace OTEL export runs once at process exit in main (flushPerfToOtel).
    await getTelemetry().flush();

    await sessionOps.awaitTail();
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
    // Terminal first: state persistence below can await disk I/O, and every
    // millisecond before this runs is a millisecond the operator is staring at
    // a frozen alternate screen. Kept outside finalizeOnCrash because that
    // short-circuits once the clean path has marked the run finalized, and a
    // throw after that point still has to give the terminal back.
    try {
      disposeHost();
    } catch (disposeErr: unknown) {
      tuiLogger.warn("crash finalize: host dispose failed: {error}", {
        error: disposeErr instanceof Error ? disposeErr.message : String(disposeErr),
      });
    }
    await finalizeOnCrash(err);
    throw err;
  }
}
