import { Box, Text, useApp } from "ink";
import type { ContentBlockData } from "./use-stream.js";
import { resolveSessionSpinnerLabel } from "./session-chrome.js";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog, TEXT_GUTTER, resolveViewportExpandIds } from "./components/event-log.js";
import { StatusBar, formatCompletedAgentsLabel } from "./components/status-bar.js";
import { useGitBranch } from "./git-branch.js";
import { formatStatusBarSegments } from "../cost/cost-summary.js";
import { OnboardingAnimation } from "./components/onboarding-animation.js";
import { ChatInput } from "./components/chat-input.js";
import {
  createSentHistoryBrowse,
  sentHistoryOnEdit,
  stepSentHistoryDown,
  stepSentHistoryUp,
  type SentHistoryBrowse,
} from "./sent-message-history.js";
import { TaskView } from "./components/task-view.js";
import { GoalView } from "./components/goal-view.js";
import { hasActiveTasks } from "../agent/tasks.js";
import { AgentsStrip } from "./components/agents-strip.js";
import { SubAgentSessionView } from "./components/subagent-session-view.js";
import { ExitConfirm } from "./components/exit-confirm.js";
import { AgentModal, toAgentProviders, type ProviderFormSubmission } from "./components/agent-modal.js";
import { ModalStack } from "./components/modal-stack.js";
import type { CompactionMode } from "./components/settings-overlay.js";
import type { PluginsAdmin } from "./components/plugins-manager.js";
import type { PermissionsAdmin, ScopedApproval } from "../permission/admin.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import {
  markOnboarded,
  resolveMaxConcurrentSubAgents,
  type Settings,
} from "../config/settings.js";
import { getLogger } from "@intx/log";
import type { SubAgentProvider, SubAgentSessionStore } from "../subagent/index.js";
import { useSpinner } from "./hooks/use-spinner.js";
import { chromeDividerLine } from "./chrome-zones.js";
import { useQuotaRetry } from "./hooks/use-quota-retry.js";
import { useRevolvingVerb } from "./hooks/use-revolving-verb.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useKeymap } from "./hooks/use-keymap.js";
import { useMouseScroll } from "./hooks/use-mouse-scroll.js";
import { useMCPStatus } from "./hooks/use-mcp-status.js";
import { removeAgentProfile, upsertAgentProfile } from "./agent-profiles.js";
import { McpAuthPrompt } from "./components/mcp-auth-prompt.js";
import { writeClipboard } from "./util/clipboard.js";
import { copyTargets, transcriptMarkdown, type CopyTarget } from "./copy.js";
import { useProviderManager } from "./hooks/use-provider-manager.js";
import { fetchCodexUsage, formatCodexUsage } from "../auth/codex/usage.js";
import { fetchXaiUsage, formatXaiUsage } from "../auth/xai/usage.js";
import {
  fetchGoUsage,
  formatGoUsage,
  OPENCODE_GO_PROVIDER_ID,
} from "../../packages/opencode-go/src/index.js";
import { useLayoutGeometry } from "./hooks/use-layout-geometry.js";
import { listCommands } from "./commands/registry.js";
import type { AgentProfile } from "../agent/profiles.js";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import type { LifecycleHookStatus } from "../session/hooks.js";
import type { WorkflowStatus, WorkflowControllerState } from "./workflow-controller.js";
import type { CapabilityName } from "../workflows/types.js";
import { formatAttachmentSummary } from "./image-attachments.js";
import { setConfiguredTiers } from "./commands/built-in.js";
import { useImageAttach } from "./hooks/use-image-attach.js";
import { useAgentsStrip } from "./hooks/use-agents-strip.js";
import { useCommandDispatch } from "./hooks/use-command-dispatch.js";
import { useMessagePipeline } from "./hooks/use-message-pipeline.js";
import { useCommandContext } from "./hooks/use-command-context.js";
import { useTranscriptLayout } from "./hooks/use-transcript-layout.js";
import { enterObserveChrome, leaveObserveChrome } from "./observe-chrome.js";
import { useProviderAuth } from "./hooks/use-provider-auth.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { resolveAtMentions } from "./mention-resolution.js";
import { STALL_TIMEOUT_MS, shouldAbortForStall, applyStallRecovery } from "./stall-watchdog.js";
import { QuotaErrorBanner, GatewayRetryBanner } from "./components/retry-banners.js";
import { OverlayStack } from "./components/overlay-stack.js";
import {
  resolveGoalChrome,
  goalChromeRowCount,
  taskChromeRowCount,
  pluginChromeRowCount,
  extraChromeRowCount,
  settingsNoticeRowCount,
} from "./chrome-geometry.js";
import { progressChromeRowCount } from "./chrome-zones.js";
import {
  InFlightIndicator,
  resolveInlineWorkflowChip,
} from "./components/in-flight-indicator.js";
import type { OutboundUserMessage } from "./message-types.js";

const EMPTY_WORKFLOW_STATUS: WorkflowStatus = {
  active: false,
  name: undefined,
  stepIndex: 0,
  total: 0,
  label: "",
  steps: [],
  capabilities: [],
};

async function writeProfileFile(dir: string, profile: AgentProfile): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${profile.id}.json`, JSON.stringify(profile, null, 2), "utf8");
}

async function deleteProfileFile(dir: string, id: string): Promise<void> {
  try {
    await unlink(`${dir}/${id}.json`);
  } catch (err: unknown) {
    // Missing file is the common case (already deleted / never written).
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    getLogger([LOG_NAMESPACE_ROOT, "tui", "profiles"]).warn(
      "Failed to delete agent profile {id}: {error}",
      { id, error: err instanceof Error ? err.message : String(err) },
    );
  }
}

export type AppProps = {
  eventEmitter: EventEmitter;
  agent: Agent;
  sessionTitle: string;
  initialModel: string;
  initialProvider: string;
  initialReasoningEffort?: ReasoningEffort;
  providers: ProviderCatalogEntry[];
  globalSettingsPath: string;
  globalDefaultProvider?: string;
  cwd: string;
  initialTask?: string;
  skipInitialTask?: boolean;
  initialContentBlocks?: ContentBlockData[];
  getSessionId?: () => string;
  initialHooks?: LifecycleHookStatus[];
  onToggleHook?: (hookId: string, enabled: boolean) => void;
  onAgentError?: (err: unknown) => void;
  onInterrupt?: () => void;
  onNewSession?: () => void;
  onRenameSession?: (name: string) => string | undefined;
  permissionsAdmin?: PermissionsAdmin;
  pluginsAdmin?: PluginsAdmin;
  profile?: string;
  initialAuto?: boolean;
  onToggleAuto?: (value: boolean) => void;
  onSubAgentProviderChange?: (provider: SubAgentProvider) => void;
  // Live catalog + runtime settings for task tier resolution (OAuth / mid-session edits).
  onSubAgentRuntimeResolutionChange?: (args: {
    catalog: readonly import("../config/index.js").ProviderCatalogEntry[];
    settings: Settings;
  }) => void;
  onAgentProfilesChange?: (profiles: AgentProfile[]) => void;
  onStartWorkflow?: (name: string) => string;
  onToggleCapability?: (name: CapabilityName) => void;
  /** Skills loaded for this session — listed in the top-of-scrollback banner. */
  loadedSkills?: readonly { name: string }[];
  /** Active (enabled) plugin names — listed in the top-of-scrollback banner. */
  activePlugins?: readonly string[];
  initialWorkflowStatus?: WorkflowStatus;
  initialProfiles?: AgentProfile[];
  profilesDir?: string;
  // The original settings from disk, used to preserve non-provider fields
  // when the provider catalog is persisted.
  initialSettings?: Settings;
  initialTiers?: Partial<Record<import("../config/settings.js").ProviderTier, import("../config/settings.js").TierConfig>>;
  onChangeCompactionMode?: (mode: CompactionMode) => Promise<void>;
  onChangeMaxConcurrentSubAgents?: (limit: number) => Promise<void>;
  initialSessionMode?: import("../config/session-mode.js").SessionMode;
  initialSavedGlobalSessionMode?: import("../config/session-mode.js").SessionMode;
  initialSavedLocalSessionMode?: import("../config/session-mode.js").SessionMode;
  onChangeSessionMode?: (
    mode: import("../config/session-mode.js").SessionMode,
    scope: "global" | "local",
  ) => Promise<void>;
  // The `onboarded` flag read from the GLOBAL settings file specifically (never
  // a --config/project file). This is global user state: it decides whether the
  // welcome animation plays on first run and is the single source of truth for
  // "first run", independent of which settings file --config pointed resolution at.
  globallyOnboarded?: boolean;
  // The TRUE global settings file path (never a --config/project file). The
  // `onboarded` flag is always written here. Defaults to globalSettingsPath.
  globalOnboardingPath?: string;

  // Emits "scrollUp"/"scrollDown" for mouse-wheel events, which are stripped
  // from stdin before they reach useInput (see createFilteredStdin).
  mouseEvents?: EventEmitter;
  // Inspectable child sessions for the Agents strip and enter-session UI.
  subAgentSessions?: SubAgentSessionStore;
  /** Goal mode operator surface. */
  goalApi?: {
    get: () => import("../agent/goal.js").GoalSnapshot | null;
    set: (
      condition: string,
      opts?: import("../agent/goal.js").GoalSetOpts,
    ) => import("../agent/goal.js").GoalSnapshot;
    pause: () => import("../agent/goal.js").GoalSnapshot | null;
    resume: (
      opts?: import("../agent/goal.js").GoalResumeOpts,
    ) => import("../agent/goal.js").GoalSnapshot | null;
    clear: () => void;
  };
  /** One-line passive notice shown once in the top-of-scrollback banner on
   * the first run telemetry is active. Undefined/empty renders nothing. */
  telemetryNotice?: string;
  /**
   * Fail-open settings diagnostics (unknown keys, invalid JSON, stripped
   * credentials). Shown as a dismissible notice on the main screen.
   */
  settingsDiagnostics?: readonly {
    path: string;
    message: string;
    fix: string;
  }[];
  /** Markdown release notes shown once after upgrade in the session banner. */
  whatsNewMarkdown?: string;
  /** Whether anonymous telemetry is currently enabled, for the settings toggle. */
  telemetryEnabled?: boolean;
  /** Persists the settings Telemetry on|off toggle to global settings. */
  onChangeTelemetryEnabled?: (enabled: boolean) => void;
  /**
   * When true, freeze each tool's wall-clock budget while its permission
   * prompt is open. When false, the budget keeps ticking and a timeout
   * dismisses the prompt. Resolved by the runner from settings.
   */
  waitForApproval: boolean;
  /** Persists the wait-for-approval toggle to global settings (tools.waitForApproval). */
  onChangeWaitForApproval?: (value: boolean) => Promise<void>;
  /** Fired once, on the first interactively submitted prompt of the session.
   * The runner uses this as the affirmative action that activates telemetry
   * held for first-run disclosure; auto-sent initial tasks never count. */
  onFirstUserMessage?: () => void;
};

// Center a selection in a fixed-height window over a copy-target list.
// Returns the visible slice and the absolute index of its first item so
// the caller can mark the selected row without re-scanning the full list.
function windowedCopyTargets(
  items: readonly CopyTarget[],
  selectedIndex: number,
  windowSize = 6,
): { window: readonly CopyTarget[]; start: number } {
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(windowSize / 2), Math.max(0, items.length - windowSize)),
  );
  return { window: items.slice(start, start + windowSize), start };
}

export function App({
  eventEmitter,
  agent,
  sessionTitle,
  initialModel,
  initialProvider,
  initialReasoningEffort,
  providers,
  globalSettingsPath,
  globalDefaultProvider: initialGlobalDefaultProvider,
  cwd,
  initialTask = "",
  skipInitialTask = false,
  initialContentBlocks = [],
  getSessionId,
  initialHooks = [],
  onToggleHook,
  onAgentError,
  onInterrupt,
  onNewSession,
  onRenameSession,
  permissionsAdmin,
  pluginsAdmin,
  profile,
  initialAuto = true,
  onToggleAuto,
  onSubAgentProviderChange,
  onSubAgentRuntimeResolutionChange,
  onAgentProfilesChange,
  onStartWorkflow,
  onToggleCapability,
  loadedSkills,
  activePlugins,
  initialWorkflowStatus,
  initialProfiles = [],
  profilesDir,
  initialSettings,
  initialTiers,
  onChangeCompactionMode,
  onChangeMaxConcurrentSubAgents,
  initialSessionMode = "orchestrator",
  initialSavedGlobalSessionMode,
  initialSavedLocalSessionMode,
  onChangeSessionMode,
  globallyOnboarded = false,
  globalOnboardingPath,
  mouseEvents,
  subAgentSessions,
  goalApi,
  telemetryNotice,
  settingsDiagnostics,
  whatsNewMarkdown,
  telemetryEnabled = false,
  onChangeTelemetryEnabled,
  waitForApproval: waitForApprovalProp,
  onChangeWaitForApproval,
  onFirstUserMessage,
}: AppProps): ReactNode {
  // Tracks the live model so the stream's cost meter prices each turn at the
  // active model's rate even after a mid-session switch. Updated once model is
  // resolved from the provider manager below.
  const modelRef = useRef(initialModel);
  const requestStopRef = useRef<() => void>(() => undefined);
  const onCredentialFailureRef = useRef<() => void>(() => {});
  const state = useAgentStream(
    eventEmitter,
    initialHooks,
    () => modelRef.current,
    () => requestStopRef.current(),
    initialContentBlocks,
    () => onCredentialFailureRef.current(),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const mcpStatus = useMCPStatus(eventEmitter);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  // First run is determined solely by the global `onboarded` flag, never by
  // initialSettings (which may be a --config/project file). The animation still
  // uses this to vary its copy for first-time users, but it now runs on every start.
  const isFirstTime = !globallyOnboarded;
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [sentHistoryBrowse, setSentHistoryBrowse] = useState<SentHistoryBrowse>(() => createSentHistoryBrowse([]));
  const [hookPanelOpen, setHookPanelOpen] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(() => new Set());
  const [verbose, setVerbose] = useState(false);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [taskFullScreenOpen, setTaskFullScreenOpen] = useState(false);
  // Tick so Agents strip / enter-view re-render when the session store mutates.
  const [sessionsTick, setSessionsTick] = useState(0);
  const [agentsNavOpen, setAgentsNavOpen] = useState(false);
  const [agentsNavIndex, setAgentsNavIndex] = useState(0);
  const [enteredSessionId, setEnteredSessionId] = useState<string | null>(null);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [agentModalUsage, setAgentModalUsage] = useState<string | null>(null);
  const [goSubscriptionLabel, setGoSubscriptionLabel] = useState<string | undefined>(undefined);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mount-only seeds from runner props. Runner does not re-render App when these
  // change; Settings updates flow through the local setters + onChange* callbacks
  // that mutate runner-held live values. No prop→state sync effect needed.
  const [liveTelemetryEnabled, setLiveTelemetryEnabled] = useState(telemetryEnabled);
  const [waitForApproval, setWaitForApproval] = useState(waitForApprovalProp);
  const [compactionMode, setCompactionMode] = useState<CompactionMode>(
    initialSettings?.compactionMode ?? "llm",
  );
  const [maxConcurrentSubAgents, setMaxConcurrentSubAgents] = useState(() =>
    resolveMaxConcurrentSubAgents(initialSettings),
  );
  const [sessionMode] = useState(initialSessionMode);
  const [savedGlobalSessionMode, setSavedGlobalSessionMode] = useState(
    initialSavedGlobalSessionMode,
  );
  const [savedLocalSessionMode, setSavedLocalSessionMode] = useState(
    initialSavedLocalSessionMode,
  );
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [permissionEntries, setPermissionEntries] = useState<ScopedApproval[]>([]);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  // Seed from fail-open settings load so unknown/invalid keys never crash
  // startup — the operator sees the problem and fix on the main screen.
  const [settingsNotice, setSettingsNotice] = useState<string | null>(() => {
    if (settingsDiagnostics === undefined || settingsDiagnostics.length === 0) return null;
    return settingsDiagnostics
      .map((d) => `Settings warning: ${d.message}\n  Fix: ${d.fix}`)
      .join("\n");
  });
  // Tracks the live auto-mode flag so SHIFT+TAB can toggle (not only enable).
  // Seeded from config.auto / --no-auto; gate is updated via onToggleAuto.
  const [autoEnabled, setAutoEnabled] = useState(initialAuto);
  const [copyModeIndex, setCopyModeIndex] = useState<number | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>(
    initialWorkflowStatus ?? EMPTY_WORKFLOW_STATUS,
  );
  const [goalSnapshot, setGoalSnapshot] = useState<import("../agent/goal.js").GoalSnapshot | null>(
    () => goalApi?.get() ?? null,
  );
  const pendingQueueRef = useRef<OutboundUserMessage[]>([]);
  const tryDrainQueuedMessageRef = useRef<() => void>(() => {});
  const sendMessageRef = useRef<(message: OutboundUserMessage) => void>(null!);
  const { pendingImages, setPendingImages, handlePasteImage, handlePasteText } =
    useImageAttach({ cwd, setCommandMessage });

  const providerManager = useProviderManager({
    initialProvider,
    initialModel,
    ...(initialReasoningEffort !== undefined ? { initialReasoningEffort } : {}),
    initialCatalog: providers,
    initialGlobalDefaultProvider,
    ...(initialSettings !== undefined ? { initialSettings } : {}),
    cwd,
    globalSettingsPath,
    getSessionId: () => getSessionId?.() ?? "session",
    agent,
    onMessage: setCommandMessage,
    ...(initialTiers !== undefined ? { initialTiers } : {}),
    ...(onSubAgentProviderChange !== undefined ? { onSelectionChange: onSubAgentProviderChange } : {}),
    ...(onSubAgentRuntimeResolutionChange !== undefined
      ? { onRuntimeResolutionChange: onSubAgentRuntimeResolutionChange }
      : {}),
  });
  const {
    provider,
    model,
    reasoningEffort,
    providerCatalog,
    applySelection,
    persistSelection,
    upsertProvider,
    deleteProvider,
    tiers,
    saveTierAssignment,
    cycleTierMode,
    clearTier,
    removeTierLegAt,
    moveTierLegAt,
    registerCodexProvider,
    registerXaiProvider,
    removeCodexProvider,
    removeXaiProvider,
    recentModels,
    favoriteModels,
    recordRecentModel,
    toggleFavorite,
  } = providerManager;
  // Safe to mutate during render: the ref is only read later by the faremeter's
  // pricing resolver at usage-event time, never during this render pass.
  modelRef.current = model;

  // Tier slash commands (/fast etc.) appear in the menu only for tiers the user
  // has actually assigned, so the list tracks live tier state rather than the
  // static PROVIDER_TIERS enum.
  useEffect(() => {
    setConfiguredTiers(tiers);
  }, [tiers]);

  // OpenCode Go subscription usage in the status bar when Go is the active
  // provider. Failures (auth, network, missing endpoint) clear the label so the
  // bar degrades cleanly rather than showing an error string.
  useEffect(() => {
    if (provider !== OPENCODE_GO_PROVIDER_ID) {
      setGoSubscriptionLabel(undefined);
      return;
    }
    const entry = providerCatalog.find((p) => p.name === provider);
    const apiKey = entry?.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      setGoSubscriptionLabel(undefined);
      return;
    }
    const controller = new AbortController();
    void fetchGoUsage(apiKey, { signal: controller.signal }).then((usage) => {
      if (controller.signal.aborted) return;
      if (usage.status === "ok") {
        setGoSubscriptionLabel(formatGoUsage(usage));
      } else {
        setGoSubscriptionLabel(undefined);
      }
    });
    return () => controller.abort();
  }, [provider, providerCatalog]);

  const {
    unauthedProviders,
    setUnauthedProviders,
    loginModal,
    setLoginModal,
    autoLoginProfile,
    setAutoLoginProfile,
    codexProfileNames,
    xaiProfileNames,
    refreshAuthState,
    promptCodexRelogin,
    promptXaiRelogin,
    switchToCodexProfile,
    switchToXaiProfile,
    removeCodexProfileEverywhere,
    removeXaiProfileEverywhere,
  } = useProviderAuth({
    provider,
    providerCatalog,
    registerCodexProvider,
    registerXaiProvider,
    removeCodexProvider,
    removeXaiProvider,
    setCommandMessage,
    onCredentialFailureRef,
  });

  const [profiles, setProfiles] = useState<AgentProfile[]>(initialProfiles);

  const saveProfile = (profile: AgentProfile): { ok: true } | { ok: false; error: string } => {
    if (profilesDir === undefined) return { ok: false, error: "No profiles directory configured" };
    const next = upsertAgentProfile(profiles, profile);
    setProfiles(next);
    onAgentProfilesChange?.(next);
    void writeProfileFile(profilesDir, profile);
    return { ok: true };
  };

  const deleteProfile = (id: string): void => {
    if (profilesDir === undefined) return;
    const next = removeAgentProfile(profiles, id);
    setProfiles(next);
    onAgentProfilesChange?.(next);
    void deleteProfileFile(profilesDir, id);
  };

  const approvalActivationBlocked =
    exitConfirmOpen ||
    helpOpen ||
    hookPanelOpen ||
    agentModalOpen ||
    loginModal !== null ||
    permissionsOpen ||
    settingsOpen ||
    pluginsOpen ||
    copyModeIndex !== null ||
    agentsNavOpen ||
    enteredSessionId !== null;
  const gates = useGates({
    eventEmitter,
    setGatePending: state.setGatePending,
    activationBlocked: approvalActivationBlocked,
  });

  useEffect(() => {
    const onWorkflow = (state: WorkflowControllerState) => {
      setWorkflowStatus(state.current);
    };
    eventEmitter.on("workflow", onWorkflow);
    return () => { eventEmitter.off("workflow", onWorkflow); };
  }, [eventEmitter]);

  useEffect(() => {
    const onGoal = (snap: import("../agent/goal.js").GoalSnapshot | null) => {
      setGoalSnapshot(snap);
    };
    eventEmitter.on("goal", onGoal);
    return () => { eventEmitter.off("goal", onGoal); };
  }, [eventEmitter]);

  const {
    agentSessions,
    browseSessions,
    agentsNavList,
    agentsNavIndexClamped,
    enteredSession,
    activeSubAgents,
    activeSubAgentsRef,
    queuedCount,
    setQueuedCount,
    hasRunningSubAgentSessions,
    steerOnEnter,
    agentsStripVisible,
    agentsStripScrollWindow,
    agentsStripRows,
  } = useAgentsStrip({
    eventEmitter,
    subAgentSessions,
    sessionsTick,
    setSessionsTick,
    state,
    stateRef,
    sendMessageRef,
    pendingQueueRef,
    tryDrainQueuedMessageRef,
    agentsNavOpen,
    agentsNavIndex,
    enteredSessionId,
  });
  const subAgentChromeRows = agentsStripRows;

  const { goalActive, goalPhase, showAcceptance, workPrimary } = resolveGoalChrome({ goalSnapshot });
  // Default-expand Work when entering implementing; Ctrl+T can still collapse.
  // Adjust during render so the panel opens in the same paint as the phase flip.
  const wasWorkPrimary = useRef(false);
if (workPrimary && !wasWorkPrimary.current) {
    setTasksExpanded(true);
  }
  wasWorkPrimary.current = workPrimary;
  // Drop the /goal one-shot once Goal chrome is live so it does not stack on
  // the brief / Work checklist (and blow the reserved chrome rows).
  useEffect(() => {
    if (!goalActive || commandMessage === null) return;
    if (commandMessage.startsWith("Goal set.")) {
      setCommandMessage(null);
    }
  }, [goalActive, commandMessage]);
  const workExpanded = tasksExpanded;
  const goalChromeRows = goalChromeRowCount({
    goalActive,
    showAcceptance,
    criteriaCount: goalSnapshot?.criteria.length ?? 0,
  });
  const taskChromeRows = taskChromeRowCount({
    hasActiveTasks: hasActiveTasks(state.tasks),
    taskCount: state.tasks.length,
    workExpanded,
  });
  const pluginChromeRows = pluginChromeRowCount({ pluginsOpen, pluginsAdmin });
  const progressWorkflow = resolveInlineWorkflowChip(workflowStatus);
  const progressChromeRows = progressChromeRowCount({
    active: state.isProcessing,
    hasWorkflow: progressWorkflow !== undefined,
  });

  const extraChromeRows = extraChromeRowCount({
    mcpNeedsAuthCount: mcpStatus.needsAuth.length,
    commandMessageRows:
      commandMessage === null ? 0 : Math.max(1, commandMessage.split("\n").length),
    // Multi-line banner: 2 rows per diagnostic + Esc hint; 0 when dismissed.
    settingsNoticeRows:
      settingsNotice === null
        ? 0
        : settingsNoticeRowCount(settingsDiagnostics?.length ?? 0),
    goalChromeRows,
    taskChromeRows,
    pluginChromeRows,
    quotaErrorPresent: state.quotaError !== null,
    inferenceRetryPresent: state.inferenceRetry !== null,
    subAgentChromeRows,
    progressChromeRows,
    inputValue,
    columns,
    rows,
  });

  const activePermission = gates.activeApproval?.kind === "permission"
    ? gates.activeApproval.request
    : null;
  const activeOperator = gates.activeApproval?.kind === "operator"
    ? { question: gates.activeApproval.question, options: gates.activeApproval.options }
    : null;
  const layout = useLayoutGeometry({
    columns,
    rows,
    sidebarOpen: false,
    gateContext: {
      pendingPermission: activePermission,
      pendingOperator: activeOperator,
    },
    modalContext: {
      helpOpen,
      hookPanelOpen,
      exitConfirmOpen,
      agentModalOpen,
      permissionsOpen: permissionsOpen || settingsOpen,
      permissionEntryCount: permissionEntries.length,
    },
    hookCount: state.hookCount,
    providerCatalog,
    extraChromeRows,
  });

  const completedAgentsLabel = formatCompletedAgentsLabel(subAgentSessions?.list() ?? []);
  const { leftWidth, visibleRows, effectiveOverlayRows, permissionsOverlayRows } = layout;
  // Text wraps and renders inside the gutter so prose never touches the edges.
  const contentWidth = Math.max(8, leftWidth - TEXT_GUTTER * 2);

  // Cleared when layout width or thinking expand change — those affect all blocks.
  // Verbose no longer invalidates the cache: each block already keys collapsed vs
  // expanded layouts separately, and Ctrl+O only expands a viewport-local subset.
  const {
    eventLogLines,
    scrollMaxOffset,
    scroll,
    enteredScroll,
    activeScroll,
    lastToolId,
    viewportExpandedIds,
    setViewportExpandedIds,
    prefixLineCount,
    incrementalLinesRef,
    baseLinesRef,
  } = useTranscriptLayout({
    state,
    contentWidth,
    thinkingExpanded,
    expandedTools,
    verbose,
    visibleRows,
    loadedSkills,
    activePlugins,
    cwd,
    telemetryNotice,
    whatsNewMarkdown,
    enteredSession,
  });

  // Scanning every block on each render walks the whole transcript on keystrokes
  // and scroll ticks, so the stream state tracks this incrementally instead.
  const latestUserMessageInLog = state.latestUserMessageLogged;
  const headerLatestUserMessage = latestUserMessageInLog ? "" : state.latestUserMessage;

  const modeColor = color("warning");

  // Input is inert while any overlay, modal, or gate is capturing keys, so
  // keystrokes (and Enter) never leak into the prompt underneath.
  const inputActive = !(
    exitConfirmOpen ||
    helpOpen ||
    gates.gateOpen ||
    hookPanelOpen ||
    agentModalOpen ||
    loginModal !== null ||
    permissionsOpen ||
    settingsOpen ||
    pluginsOpen ||
    copyModeIndex !== null ||
    // Agents navigation and the entered child view own Enter and the arrows;
    // leaving the prompt active would submit/interrupt the parent draft or edit
    // it while the operator is only observing.
    agentsNavOpen ||
    enteredSessionId !== null
  );

  const copyModeOpen = copyModeIndex !== null;
  // Frozen at the moment copy mode opens — copyTargets builds an LCS diff for
  // every edit block in history, so recomputing it as stream drains arrive
  // stalls deep chats and shifts the selection out from under the user.
  const copyTargetsRef = useRef<CopyTarget[]>([]);
  const copyTargetList = copyModeOpen ? copyTargetsRef.current : [];

  const [, forceRender] = useState(0);

  const {
    sendMessage,
    requestStop,
    startNewSessionRef,
    prepareOutboundMessage,
    handleSend,
    handleInterrupt,
    sendAbortRef,
    sendCounterRef,
    lastSentMessageRef,
    quotaAutoRetryFiredRef,
  } = useMessagePipeline({
    cwd,
    agent,
    getSessionId,
    exit,
    onFirstUserMessage,
    onInterrupt,
    onNewSession,
    onAgentError,
    skipInitialTask,
    initialTask,
    state,
    stateRef,
    scroll,
    gates,
    subAgentSessions,
    activeSubAgentsRef,
    hasRunningSubAgentSessions,
    pendingQueueRef,
    setQueuedCount,
    pendingImages,
    setPendingImages,
    setCommandMessage,
    setSentHistoryBrowse,
    promptCodexRelogin,
    promptXaiRelogin,
    setExpandedTools,
    setInputValue,
    setEnteredSessionId,
    setAgentsNavOpen,
    setAgentsNavIndex,
    forceRender,
    sendMessageRef,
    requestStopRef,
  });

  const { getCostSummary, commandContext } = useCommandContext({
    provider,
    providerCatalog,
    modelRef,
    state,
    mcpServers: mcpStatus.servers,
    startNewSessionRef,
    onStartWorkflow,
    onRenameSession,
    goalApi,
    sendMessageRef,
  });

  // Watchdog: if the run stays in the awaiting-response gap beyond STALL_TIMEOUT_MS
  // with no new content, abort the in-flight request and surface a message so the
  // user knows they need to retry rather than waiting indefinitely.
  useEffect(() => {
    if (state.status !== "running") return;
    const check = () => {
      if (shouldAbortForStall({
        status: stateRef.current.status,
        awaitingResponse: stateRef.current.awaitingResponse,
        lastActivityAt: stateRef.current.lastActivityAt,
        nowMs: Date.now(),
        stallTimeoutMs: STALL_TIMEOUT_MS,
        isProcessing: stateRef.current.isProcessing,
        streamingType: stateRef.current.streamingType,
      })) {
        applyStallRecovery({
          abortInFlight: (reason) => sendAbortRef.current?.abort(reason),
          setCommandMessage,
        });
      }
    };
    const handle = setInterval(check, 1000);
    return () => clearInterval(handle);
  // `state` is a stable mutable object — only the reactive scalar fields matter here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.awaitingResponse]);

  useQuotaRetry({ state, stateRef, lastSentMessageRef, quotaAutoRetryFiredRef, sendMessageRef });

  // Spin for the full duration of a send cycle (markRunning → connector.reply).
  // The label tracks the live phase so "Thinking…" is reserved for reasoning
  // chunks, not tool execution or response waits.
  const awaitingResponse = state.status === "running" && state.awaitingResponse;
  const spinnerTiming = useSpinner(state.isProcessing, sendCounterRef.current);
  const spinnerLabel = resolveSessionSpinnerLabel({
    isProcessing: state.isProcessing,
    status: state.status,
    awaitingResponse,
    currentToolName: state.currentToolName,
    streamingType: state.streamingType,
  });

  // Persistent status bar segment: refreshes on an interval, never
  // blocks render on the git process.
  const gitBranch = useGitBranch(cwd);
  // Ambient verb shown beside the steer hint while the agent runs.
  const revolvingVerb = useRevolvingVerb(state.isProcessing, sendCounterRef.current);

  useKeymap(
    {
      exitConfirmOpen,
      // The permissions overlay owns input through its own useInput, exactly
      // like the help overlay, so block the global keymap the same way.
      helpOpen: helpOpen || permissionsOpen || settingsOpen || pluginsOpen,
      gateOpen: gates.gateOpen,
      agentModalOpen: agentModalOpen || loginModal !== null,
      hookPanelOpen,
      taskFullScreenOpen,
      hasInput: inputValue.length > 0,
      inputFocused: inputActive,
      copyModeOpen,
      agentsNavOpen,
      enteredSession: enteredSession !== undefined,
      settingsNoticePresent: settingsNotice !== null,
      commandPaletteOpen: inputValue.startsWith("/") && (
        !inputValue.includes(" ") ||
        listCommands().some(
          (c) => c.subcommands !== undefined && inputValue.startsWith(`/${c.name} `),
        )
      ),
      // "stopping" is deliberately excluded: a stop is already in flight, so the
      // next Ctrl+C / double-Esc should escalate to the exit path rather than
      // re-issuing a no-op stop and trapping the user while the run drains.
      isRunning:
        state.status === "running"
        || state.status === "blocked"
        || state.quotaError !== null
        || state.inferenceRetry !== null,
    },
    {
      clearInput: () => setInputValue(""),
      requestExit: () => setExitConfirmOpen(true),
      requestStop,
      toggleHookPanel: () => setHookPanelOpen((open) => !open),
      selectHook: (index) => {
        const hook = state.hooks[index];
        if (hook !== undefined) {
          onToggleHook?.(hook.id, !hook.enabled);
        }
      },
      closeHookPanel: () => setHookPanelOpen(false),
      dismissSettingsNotice: () => setSettingsNotice(null),
      scrollUp: () => activeScroll.scrollUp(visibleRows),
      scrollDown: () => activeScroll.scrollDown(visibleRows),
      scrollToBottom: () => activeScroll.scrollToBottom(),
      toggleVerbose: () => {
        if (verbose) {
          setVerbose(false);
          setViewportExpandedIds(new Set());
          return;
        }
        // Seed from the current (collapsed) layout so the first verbose paint
        // expands the viewport set instead of flashing a collapsed frame.
        const layout = incrementalLinesRef.current ?? baseLinesRef.current;
        if (layout !== undefined) {
          setViewportExpandedIds(resolveViewportExpandIds({
            blocks: layout.blocks,
            blockLineStarts: layout.blockLineStarts,
            lineCount: layout.lines.length,
            prefixLineCount,
            visibleRows,
            scrollOffset: scroll.scrollOffset,
            atBottom: scroll.atBottom,
            previousIds: new Set(),
          }));
        }
        setVerbose(true);
      },
      toggleTaskPanel: () => setTasksExpanded((open) => !open),
      toggleThinking: () => setThinkingExpanded((e) => !e),
      toggleLastTool: () => {
        if (lastToolId !== null) {
          const id = lastToolId;
          setExpandedTools((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }
      },
      toggleTaskSidebar: () => {
        setTaskFullScreenOpen((open) => !open);
      },
      toggleHelp: () => setHelpOpen((open) => !open),
      copyMcpUrl: () => {
        const first = mcpStatus.needsAuth[0];
        if (first !== undefined) {
          writeClipboard(first.url);
          setCommandMessage(`Copied authorization URL for ${first.name}`);
        }
      },
      enterCopyMode: () => {
        // A pending MCP auth URL is the one thing worth copying instantly.
        const first = mcpStatus.needsAuth[0];
        if (first !== undefined) {
          writeClipboard(first.url);
          setCommandMessage(`Copied authorization URL for ${first.name}`);
          return;
        }
        const targets = copyTargets(state.contentBlocks);
        if (targets.length === 0) {
          setCommandMessage("Nothing to copy yet");
          return;
        }
        copyTargetsRef.current = targets;
        setCopyModeIndex(targets.length - 1);
      },
      copyModePrev: () => setCopyModeIndex((i) => (i === null ? null : Math.max(0, i - 1))),
      copyModeNext: () => setCopyModeIndex((i) => (i === null ? null : Math.min(copyTargetList.length - 1, i + 1))),
      copyModeConfirm: () => {
        const target = copyModeIndex === null ? undefined : copyTargetList[copyModeIndex];
        if (target !== undefined) {
          writeClipboard(target.text);
          setCommandMessage(`Copied ${target.label}`);
        }
        setCopyModeIndex(null);
      },
      copyModeCopyAll: () => {
        writeClipboard(transcriptMarkdown(state.contentBlocks));
        setCommandMessage("Copied the conversation as markdown");
        setCopyModeIndex(null);
      },
      copyModeCancel: () => setCopyModeIndex(null),
      cycleMode: () => {
        const next = !autoEnabled;
        setAutoEnabled(next);
        onToggleAuto?.(next);
        setCommandMessage(
          next
            ? "Auto mode on — workspace writes and unconstrained shell run without prompts; installs, recursive rm, worktree changes, sensitive paths, and opaque wrappers still ask. SHIFT+TAB toggles."
            : "Auto mode off — consequential actions ask for approval. SHIFT+TAB toggles.",
        );
      },
      enterAgentsNav: () => {
        if (browseSessions.length === 0) {
          // Live stream can still paint a ghost Agents row after a retry or a
          // missed tool.done; the session store is the source of truth for nav.
          setCommandMessage(
            activeSubAgents.length > 0
              ? "No enterable sub-agent sessions (strip shows live progress only) — stop the run or wait for the task tool to finish"
              : "No sub-agent sessions yet — spawn with task first",
          );
          return;
        }
        // Prefer currently entered, else first running, else top of list.
        const preferred =
          enteredSessionId !== null
            ? browseSessions.findIndex((s) => s.id === enteredSessionId)
            : browseSessions.findIndex((s) => s.status === "running");
        setAgentsNavIndex(preferred >= 0 ? preferred : 0);
        setAgentsNavOpen(true);
      },
      agentsNavPrev: () =>
        setAgentsNavIndex((i) => Math.max(0, Math.min(i, browseSessions.length - 1) - 1)),
      agentsNavNext: () =>
        setAgentsNavIndex((i) => Math.min(Math.max(0, browseSessions.length - 1), i + 1)),
      agentsNavConfirm: () => {
        const pick = browseSessions[agentsNavIndexClamped];
        if (pick === undefined) {
          setAgentsNavOpen(false);
          return;
        }
        const chrome = enterObserveChrome(pick.id, pick.agentId, pick.description);
        setEnteredSessionId(chrome.enteredSessionId);
        setAgentsNavOpen(false);
        setCommandMessage(chrome.commandMessage);
      },
      agentsNavCancel: () => setAgentsNavOpen(false),
      agentsNavKill: () => {
        const targetId =
          enteredSessionId !== null
            ? enteredSessionId
            : browseSessions[agentsNavIndexClamped]?.id;
        if (targetId === undefined || subAgentSessions === undefined) {
          setCommandMessage("No sub-agent to cancel");
          return;
        }
        const target = subAgentSessions.get(targetId);
        if (target === undefined) {
          setCommandMessage("No sub-agent to cancel");
          return;
        }
        if (target.status !== "running") {
          setCommandMessage(
            `Sub-agent already ${target.status}: ${target.agentId}: ${target.description}`,
          );
          return;
        }
        const cancelled = subAgentSessions.cancel(targetId, "Cancelled from Agents strip");
        setCommandMessage(
          cancelled
            ? `Cancelled ${target.agentId}: ${target.description}`
            : `Could not cancel ${target.agentId}: ${target.description}`,
        );
        forceRender((n) => n + 1);
      },
      exitEnteredSession: () => {
        // Clear focus and command toast together so leave-observe never leaves
        // a sticky toast on the parent transcript.
        const chrome = leaveObserveChrome();
        setEnteredSessionId(chrome.enteredSessionId);
        setCommandMessage(chrome.commandMessage);
      },
    },
  );

  useMouseScroll(
    mouseEvents,
    (ticks) => activeScroll.scrollUp(ticks * 3),
    (ticks) => activeScroll.scrollDown(ticks * 3),
  );

  const { handleCommand, refreshPermissions, handleRevokePermission } = useCommandDispatch({
    handleSend,
    setCommandMessage,
    providerCatalog,
    tiers,
    applySelection,
    reasoningEffort,
    setTasksExpanded,
    permissionsAdmin,
    setPermissionEntries,
    setPermissionsOpen,
    setSettingsOpen,
    pluginsAdmin,
    setPluginsOpen,
    setHelpOpen,
    setAgentModalOpen,
    refreshAuthState,
    provider,
    setAgentModalUsage,
    setLoginModal,
    handlePasteImage,
    onStartWorkflow,
    sendMessage,
  });

  const handleOnboardingComplete = () => {
    setOnboardingDone(true);
    if (!isFirstTime) return;

    // `runOnboarding` (src/tui/onboarding.tsx) is the single owner of first-run
    // provider setup. Only prompt for a provider here when none is configured —
    // never re-ask a user who just configured one through runOnboarding.
    if (providers.length === 0) {
      setAgentModalOpen(true);
    }

    // Stamp the `onboarded` flag into the GLOBAL settings file. markOnboarded
    // reads the file fresh — it never spreads `initialSettings`, which carries
    // synthetic OAuth provider entries with short-lived access tokens (see
    // providerCatalogToSettings) that must never be written to settings.json.
    void markOnboarded(globalOnboardingPath ?? globalSettingsPath).catch((err: unknown) => {
      getLogger([LOG_NAMESPACE_ROOT, "tui", "onboarding"]).error(
        "Failed to persist onboarded flag: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    });
  };

  if (!onboardingDone) {
    return (
      <OnboardingAnimation
        onComplete={handleOnboardingComplete}
        rows={rows}
        columns={columns}
        isFirstTime={isFirstTime}
      />
    );
  }

  // Work / Acceptance chrome: order flips by goal phase (implementing = Work on top).
  const workBlock = hasActiveTasks(state.tasks) ? (
    <Box flexDirection="column" marginTop={1} key="work">
      <TaskView
        tasks={state.tasks}
        compact={!workExpanded}
        title={goalActive ? "Work" : "Tasks"}
      />
    </Box>
  ) : null;
  const acceptBlock =
    goalActive && goalSnapshot !== null ? (
      <Box flexDirection="column" marginTop={1} key="accept">
        <GoalView goal={goalSnapshot} compact={!showAcceptance} />
      </Box>
    ) : null;
  const workAcceptBlocks = workPrimary ? (
    <>
      {workBlock}
      {acceptBlock}
    </>
  ) : (
    <>
      {acceptBlock}
      {workBlock}
    </>
  );

  const copyModeSelection = copyModeIndex ?? 0;
  const { window: copyModeWindow, start: copyModeWindowStart } = windowedCopyTargets(
    copyTargetList,
    copyModeSelection,
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexShrink={0} flexDirection="column">
        <Header
          latestUserMessage={headerLatestUserMessage}
          width={columns}
          {...(profile !== undefined ? { profile } : {})}
          {...(enteredSession !== undefined
            ? {
                focusedAgent: {
                  agentId: enteredSession.agentId,
                  description: enteredSession.description,
                  status: enteredSession.status,
                },
              }
            : {})}
          {...(goalSnapshot !== null ? { goal: goalSnapshot } : goalApi !== undefined ? { goal: goalApi.get() } : {})}
        />
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
        {taskFullScreenOpen ? (
          <TaskView
            tasks={state.tasks}
          />
        ) : enteredSession !== undefined ? (
          <Box
            width={leftWidth}
            flexDirection="column"
            overflow="hidden"
            paddingX={TEXT_GUTTER}
          >
            <SubAgentSessionView
              session={enteredSession}
              visibleRows={visibleRows}
              width={contentWidth}
              scrollOffset={enteredScroll.scrollOffset}
            />
          </Box>
        ) : (
          <Box
            width={leftWidth}
            flexDirection="column"
            justifyContent="flex-end"
            overflow="hidden"
            paddingX={TEXT_GUTTER}
          >
            <EventLog
              lines={eventLogLines}
              scrollOffset={scroll.scrollOffset}
              visibleRows={visibleRows}
              width={contentWidth}
            />
          </Box>
        )}
      </Box>
      <Box flexShrink={0} flexDirection="column">
        <ModalStack
          hooks={state.hooks}
          hookPanelOpen={hookPanelOpen}
          helpOpen={helpOpen}
          onCloseHelp={() => setHelpOpen(false)}
          agentModalOpen={agentModalOpen}
          agentProviders={toAgentProviders(providerCatalog)}
          activeProvider={provider}
          activeModel={model}
          activeEffort={reasoningEffort}
          onAgentApply={applySelection}
          onAgentPersistDefault={persistSelection}
          onAgentSaveProvider={upsertProvider}
          onAgentDeleteProvider={deleteProvider}
          onCloseAgentModal={() => setAgentModalOpen(false)}
          agentTiers={tiers}
          onSaveTier={saveTierAssignment}
          onCycleTierMode={cycleTierMode}
          onClearTier={clearTier}
          onRemoveTierLeg={removeTierLegAt}
          onMoveTierLeg={moveTierLegAt}
          agentProfiles={profiles}
          onSaveAgentProfile={saveProfile}
          onDeleteAgentProfile={deleteProfile}
          usage={agentModalUsage ?? undefined}
          onRequestAgentUsage={(kind, profile, baseURL) => {
            setAgentModalUsage(null);
            if (kind === "codex") {
              void fetchCodexUsage(profile).then(
                (u) => { setAgentModalUsage(formatCodexUsage(u)); },
                () => {},
              );
            } else {
              void fetchXaiUsage(profile, baseURL).then(
                (u) => { setAgentModalUsage(formatXaiUsage(u)); },
                () => {},
              );
            }
          }}
          unauthedProviders={unauthedProviders}
          onRequestAgentLogin={(kind, profile) => {
            setAutoLoginProfile(profile);
            setLoginModal(kind);
          }}
          recentModels={recentModels}
          favoriteModels={favoriteModels}
          onToggleFavorite={toggleFavorite}
          onRecordRecent={recordRecentModel}
          activeApproval={gates.activeApproval}
          onApprove={gates.approve}
          onReject={gates.reject}
          onSelectOperator={gates.selectOperator}
          permissionQueueDepth={gates.permissionQueueDepth}
          queuedApprovals={gates.queuedApprovals}
          onResolvePermission={gates.resolvePermission}

          width={columns}
          {...(rows !== undefined ? { terminalRows: rows } : {})}
        />
      </Box>
      <OverlayStack
        permissionsOpen={permissionsOpen}
        permissionEntries={permissionEntries}
        onRevokePermission={handleRevokePermission}
        onClosePermissions={() => setPermissionsOpen(false)}
        permissionsOverlayRows={permissionsOverlayRows}
        settingsOpen={settingsOpen}
        compactionMode={compactionMode}
        onChangeCompactionMode={(mode) => {
          setCompactionMode(mode);
          void onChangeCompactionMode?.(mode);
        }}
        maxConcurrentSubAgents={maxConcurrentSubAgents}
        onChangeMaxConcurrentSubAgents={(limit) => {
          setMaxConcurrentSubAgents(limit);
          void onChangeMaxConcurrentSubAgents?.(limit);
        }}
        sessionMode={sessionMode}
        {...(savedGlobalSessionMode !== undefined ? { savedGlobalSessionMode } : {})}
        {...(savedLocalSessionMode !== undefined ? { savedLocalSessionMode } : {})}
        onChangeSessionMode={(mode, scope) => {
          if (scope === "global") setSavedGlobalSessionMode(mode);
          else setSavedLocalSessionMode(mode);
          void onChangeSessionMode?.(mode, scope);
        }}
        telemetryEnabled={liveTelemetryEnabled}
        onChangeTelemetryEnabled={(enabled) => {
          setLiveTelemetryEnabled(enabled);
          onChangeTelemetryEnabled?.(enabled);
        }}
        waitForApproval={waitForApproval}
        onChangeWaitForApproval={(value) => {
          setWaitForApproval(value);
          void onChangeWaitForApproval?.(value);
        }}
        onCloseSettings={() => setSettingsOpen(false)}
        pluginsOpen={pluginsOpen}
        pluginsAdmin={pluginsAdmin}
        onClosePlugins={() => setPluginsOpen(false)}
        cwd={cwd}
        loginModal={loginModal}
        onCloseLoginModal={() => { setLoginModal(null); setAutoLoginProfile(undefined); }}
        xaiProfileNames={xaiProfileNames}
        codexProfileNames={codexProfileNames}
        activeProvider={provider}
        autoLoginProfile={autoLoginProfile}
        switchToXaiProfile={switchToXaiProfile}
        switchToCodexProfile={switchToCodexProfile}
        removeXaiProfileEverywhere={removeXaiProfileEverywhere}
        removeCodexProfileEverywhere={removeCodexProfileEverywhere}
      />
      {mcpStatus.needsAuth.length > 0 && <McpAuthPrompt servers={mcpStatus.needsAuth} />}
      {settingsNotice !== null && (
        <Box paddingX={1} flexDirection="column">
          <Text color="yellow">{settingsNotice}</Text>
          <Text dimColor>Press Esc to dismiss settings warnings</Text>
        </Box>
      )}
      {commandMessage !== null && (
        <Box paddingX={1} width="100%" overflow="hidden" flexDirection="column">
          {commandMessage.split("\n").map((line, i) => (
            <Text key={i} color="cyan" wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      )}
      {!taskFullScreenOpen && (
        <Box flexShrink={0} flexDirection="column">
          {workAcceptBlocks}
          {agentsStripVisible ? (
            <Box flexDirection="column" marginTop={1}>
              <AgentsStrip
                sessions={agentsNavOpen ? browseSessions : agentSessions}
                selectedId={
                  agentsNavOpen ? (agentsNavList[agentsNavIndexClamped]?.id ?? null) : null
                }
                enteredId={enteredSessionId}
                navActive={agentsNavOpen}
              />
            </Box>
          ) : null}
          <Box paddingX={1}><Text dimColor>{chromeDividerLine(Math.max(8, columns - 2))}</Text></Box>
          <InFlightIndicator
            active={state.isProcessing}
            timingAnchor={spinnerTiming.anchor}
            toolName={state.currentToolName}
            {...(spinnerLabel !== undefined ? { label: spinnerLabel } : {})}
            {...(progressWorkflow !== undefined ? { workflow: progressWorkflow } : {})}
          />
          {state.quotaError !== null && (
            <QuotaErrorBanner retryAt={state.quotaError.retryAt} />
          )}
          {state.inferenceRetry !== null && (
            <GatewayRetryBanner
              attempt={state.inferenceRetry.attempt}
              retryAt={state.inferenceRetry.retryAt}
            />
          )}
          {copyModeOpen && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={color("brand")} paddingX={1}>
              <Text color={color("brand")} bold>Copy — ↑/↓ select · y/⏎ copy · a copy all · esc cancel</Text>
              {copyModeWindow.map((target, i) => {
                const idx = copyModeWindowStart + i;
                const selected = idx === copyModeSelection;
                return (
                  <Text key={target.id} color={selected ? color("text") : color("muted")} dimColor={!selected}>
                    {selected ? "› " : "  "}{target.label}: {target.preview}
                  </Text>
                );
              })}
            </Box>
          )}
          {exitConfirmOpen ? (
            <ExitConfirm inline onConfirm={() => exit()} onCancel={() => setExitConfirmOpen(false)} />
          ) : (
            <ChatInput
              onSubmit={handleSend}
              onCommand={handleCommand}
              onPasteImage={handlePasteImage}
              onPasteText={handlePasteText}
              commandContext={commandContext}
              value={inputValue}
              onChange={setInputValue}
              cwd={cwd}
              active={inputActive}
              queuedCount={queuedCount}
              isProcessing={state.isProcessing}
              steerOnEnter={steerOnEnter}
              onInterrupt={handleInterrupt}
              onSentHistoryPrevious={() => {
                const step = stepSentHistoryUp(sentHistoryBrowse, inputValue);
                if (step === null) return false;
                setSentHistoryBrowse(step.browse);
                setInputValue(step.value);
                return true;
              }}
              onSentHistoryNext={() => {
                const step = stepSentHistoryDown(sentHistoryBrowse, inputValue, inputValue.length);
                if (step === null) return false;
                setSentHistoryBrowse(step.browse);
                setInputValue(step.value);
                return true;
              }}
              onSentHistoryExitBrowse={() => {
                if (sentHistoryBrowse.browseIndex === null) return;
                setSentHistoryBrowse(sentHistoryOnEdit(sentHistoryBrowse));
              }}
              sentHistoryBrowsing={sentHistoryBrowse.browseIndex !== null}
              {...(profile !== undefined ? { profile } : {})}
              model={model}
              rows={rows}
              columns={columns}
              attachmentSummary={formatAttachmentSummary(pendingImages)}
              canSubmitEmpty={pendingImages.length > 0}
              {...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {})}
              {...(revolvingVerb !== undefined ? { verb: revolvingVerb } : {})}
            />
          )}
        <Box marginTop={1}>
          <StatusBar
            {...(completedAgentsLabel !== undefined ? { completedAgentsLabel } : {})}
            mcpCount={mcpStatus.connected.length}
            model={model}
            cwd={cwd}
            gitBranch={gitBranch}
            columns={columns}
            {...(goSubscriptionLabel !== undefined ? { subscriptionLabel: goSubscriptionLabel } : {})}
            {...formatStatusBarSegments(getCostSummary())}
          />
        </Box>
        </Box>
      )}
    </Box>
  );
}
