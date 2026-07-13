import { Box, Text, useApp } from "ink";
import type { AgentStatus, ContentBlockData } from "./use-stream.js";
import {
  classifyAgentSendFailure,
  resolveSessionSpinnerLabel,
  shouldSettleUiAfterSendFailure,
} from "./session-chrome.js";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import type { InboundMessage } from "@intx/types/runtime";
import { useState, useMemo, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import {
  EventLog,
  buildLinesIncremental,
  buildResourceBanner,
  clearMarkdownLineCache,
  DEFAULT_MAX_RENDERED_LOG_LINES,
  maxLineOffset,
  TEXT_GUTTER,
  resolveViewportExpandIds,
  type IncrementalLinesState,
  type RenderableBlock,
} from "./components/event-log.js";
import type { StyledLine } from "./view/index.js";
import { StatusBar } from "./components/status-bar.js";
import { OnboardingAnimation } from "./components/onboarding-animation.js";
import { ChatInput } from "./components/chat-input.js";
import {
  createSentHistoryBrowse,
  resetSentHistoryBrowse,
  sentHistoryOnEdit,
  stepSentHistoryDown,
  stepSentHistoryUp,
  type SentHistoryBrowse,
} from "./sent-message-history.js";
import { appendSentMessage, loadSentMessages } from "../session/sent-messages.js";
import { TaskView } from "./components/task-view.js";
import { hasActiveTasks } from "../agent/tasks.js";
import {
  activeStripSessions,
  AgentsStrip,
  agentsStripRowCount,
  DEFAULT_STRIP_MAX_VISIBLE,
} from "./components/agents-strip.js";
import {
  SubAgentSessionView,
  subAgentScrollWindow,
  subAgentTranscriptWidth,
  renderTranscriptLines,
} from "./components/subagent-session-view.js";
import { ExitConfirm } from "./components/exit-confirm.js";
import { AgentModal, toAgentProviders, type ProviderFormSubmission } from "./components/agent-modal.js";
import { ModalStack } from "./components/modal-stack.js";
import { PermissionsManager } from "./components/permissions-manager.js";
import { SettingsOverlay, type CompactionMode } from "./components/settings-overlay.js";
import { PluginsManager, type PluginsAdmin } from "./components/plugins-manager.js";
import type { PermissionsAdmin, ScopedApproval } from "../permission/admin.js";
import { InFlightIndicator } from "./components/in-flight-indicator.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import {
  markOnboarded,
  resolveMaxConcurrentSubAgents,
  tierDefinitionAt,
  type Settings,
} from "../config/settings.js";
import { getLogger } from "@intx/log";
import type { SubAgentProvider, SubAgentSessionStore } from "../subagent/index.js";
import { useSpinner } from "./hooks/use-spinner.js";
import { extraPromptChromeRows } from "./prompt-layout.js";
import { chromeDividerLine } from "./chrome-zones.js";
import { useSessionClock } from "./hooks/use-session-clock.js";
import { useRevolvingVerb } from "./hooks/use-revolving-verb.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useScroll } from "./hooks/use-scroll.js";
import { useKeymap } from "./hooks/use-keymap.js";
import { useMouseScroll } from "./hooks/use-mouse-scroll.js";
import { useMCPStatus } from "./hooks/use-mcp-status.js";
import { removeAgentProfile, upsertAgentProfile } from "./agent-profiles.js";
import { McpAuthPrompt } from "./components/mcp-auth-prompt.js";
import { CodexLoginModal } from "./components/codex-login-modal.js";
import { LoginProviderPicker } from "./components/login-provider-picker.js";
import { writeClipboard } from "./util/clipboard.js";
import { copyTargets, transcriptMarkdown, type CopyTarget } from "./copy.js";
import { useProviderManager } from "./hooks/use-provider-manager.js";
import { startCodexLogin } from "../auth/codex/login.js";
import { getValidCodexToken, CodexAuthError } from "../auth/codex/session.js";
import { refreshCodexInstructions } from "../auth/codex/instructions.js";
import { removeCodexProfile } from "../auth/codex/store.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js";
import { startXaiLogin } from "../auth/xai/login.js";
import { getValidXaiToken, XaiAuthError } from "../auth/xai/session.js";
import { removeXaiProfile } from "../auth/xai/store.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../auth/xai/constants.js";
import { codexProviderName, codexProfileFromProviderName } from "../config/codex-providers.js";
import { xaiProviderName, xaiProfileFromProviderName } from "../config/xai-providers.js";
import { fetchCodexUsage, fetchCodexModels, formatCodexUsage } from "../auth/codex/usage.js";
import { fetchXaiUsage, formatXaiUsage } from "../auth/xai/usage.js";
import { useLayoutGeometry } from "./hooks/use-layout-geometry.js";
import type { CommandResult } from "./commands/registry.js";
import { listCommands } from "./commands/registry.js";
import type { AgentProfile } from "../agent/profiles.js";
import { writeFile, mkdir, unlink, readFile, opendir, realpath, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { LifecycleHookStatus } from "../session/hooks.js";
import type { WorkflowStatus, WorkflowControllerState } from "./workflow-controller.js";
import type { CapabilityName } from "../workflows/types.js";
import { workflowKickoffUserMessage } from "../workflows/kickoff.js";
import { isSensitivePath } from "../plugins/secret-guard-plugin.js";
import {
  extractPastedImagePaths,
  findImagePathMentions,
  formatAttachmentSummary,
  imageAttachmentFromPath,
  readClipboardImage,
  type PendingImageAttachment,
} from "./image-attachments.js";
import { setConfiguredTiers } from "./commands/built-in.js";

const MAX_MENTION_FILE_BYTES = 200_000;
const MAX_MENTION_TOTAL_BYTES = 400_000;
const MAX_MENTION_COUNT = 5;
const MAX_DIRECTORY_SUMMARY_ENTRIES = 200;
const MAX_DIRECTORY_NAMES = 20;
type OutboundUserMessage = {
  text: string;
  attachments: PendingImageAttachment[];
};

async function resolveMentionPath(cwd: string, path: string): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  if (path === "~" || path.startsWith("~/")) {
    return { ok: false, reason: "home-relative paths are not supported" };
  }

  try {
    return { ok: true, abs: await realpath(isAbsolute(path) ? path : resolve(cwd, path)) };
  } catch {
    return { ok: false, reason: "not found" };
  }
}

async function summarizeDir(abs: string): Promise<string> {
  let scanned = 0;
  let files = 0;
  let dirs = 0;
  const dirNames: string[] = [];
  const directory = await opendir(abs).catch(() => null);
  if (directory === null) return "unreadable directory";

  for await (const entry of directory) {
    if (scanned >= MAX_DIRECTORY_SUMMARY_ENTRIES) break;
    scanned++;
    if (entry.isFile()) files++;
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      dirs++;
      if (dirNames.length < MAX_DIRECTORY_NAMES) dirNames.push(`${entry.name}/`);
    }
  }

  const dirList = dirNames.join(", ");
  const parts: string[] = [];
  if (files > 0) parts.push(`${files}${scanned >= MAX_DIRECTORY_SUMMARY_ENTRIES ? "+" : ""} file${files === 1 ? "" : "s"}`);
  if (dirs > 0) parts.push(`${dirs}${scanned >= MAX_DIRECTORY_SUMMARY_ENTRIES ? "+" : ""} subdirector${dirs === 1 ? "y" : "ies"}${dirList ? ` (${dirList})` : ""}`);
  return parts.length > 0 ? parts.join(", ") : "empty directory";
}

export async function resolveAtMentions(message: string, cwd: string): Promise<string> {
  const pattern = /@("([^"]+)"|(\S+))/g;
  const mentions: Array<{ full: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(message)) !== null) {
    const path = m[2] ?? m[3] ?? "";
    if (path.length > 0) mentions.push({ full: m[0], path });
  }
  if (mentions.length === 0) return message;

  const replacements: Array<{ full: string; replacement: string }> = [];
  let totalBytes = 0;

  for (const [index, { full, path }] of mentions.entries()) {
    if (index >= MAX_MENTION_COUNT) {
      replacements.push({ full, replacement: `${full} (blocked: too many @mentions; max ${MAX_MENTION_COUNT})` });
      continue;
    }
    if (isSensitivePath(path)) {
      replacements.push({ full, replacement: `${full} (blocked: sensitive path)` });
      continue;
    }
    const resolved = await resolveMentionPath(cwd, path);
    if (!resolved.ok) {
      replacements.push({ full, replacement: `${full} (blocked: ${resolved.reason})` });
      continue;
    }
    if (isSensitivePath(resolved.abs)) {
      replacements.push({ full, replacement: `${full} (blocked: sensitive path)` });
      continue;
    }
    try {
      const info = await stat(resolved.abs);
      if (info.isDirectory()) {
        const summary = await summarizeDir(resolved.abs);
        replacements.push({ full, replacement: `\`${path}\` (directory - ${summary})` });
        continue;
      }
      if (info.size > MAX_MENTION_FILE_BYTES) {
        replacements.push({ full, replacement: `${full} (blocked: file is too large; max ${MAX_MENTION_FILE_BYTES} bytes)` });
        continue;
      }
      if (totalBytes + info.size > MAX_MENTION_TOTAL_BYTES) {
        replacements.push({ full, replacement: `${full} (blocked: total @mention content is too large; max ${MAX_MENTION_TOTAL_BYTES} bytes)` });
        continue;
      }
      const content = await readFile(resolved.abs, "utf-8");
      totalBytes += info.size;
      const ext = resolved.abs.split(".").pop() ?? "";
      replacements.push({ full, replacement: `\`${path}\`:\n\`\`\`${ext}\n${content}\n\`\`\`` });
    } catch {
      replacements.push({ full, replacement: `${full} (not found)` });
    }
  }

  let result = message;
  for (const { full, replacement } of replacements) {
    result = result.replace(full, () => replacement);
  }
  return result;
}

const EMPTY_WORKFLOW_STATUS: WorkflowStatus = {
  active: false,
  name: undefined,
  stepIndex: 0,
  total: 0,
  label: "",
  steps: [],
  capabilities: [],
};

// How long the run can be continuously awaiting a response with no new content
// before the watchdog fires and aborts the in-flight request.
export const STALL_TIMEOUT_MS = 900_000;


export type ShouldAbortForStallArgs = {
  status: AgentStatus;
  awaitingResponse: boolean;
  lastActivityAt: number;
  nowMs: number;
  stallTimeoutMs: number;
};

// Pure decision helper: returns true when the run is genuinely stuck and should
// be aborted. Extracted so the timeout logic is unit-testable without a React harness.
export function shouldAbortForStall({ status, awaitingResponse, lastActivityAt, nowMs, stallTimeoutMs }: ShouldAbortForStallArgs): boolean {
  if (status !== "running") return false;
  if (!awaitingResponse) return false;
  return nowMs - lastActivityAt >= stallTimeoutMs;
}

async function writeProfileFile(dir: string, profile: AgentProfile): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${profile.id}.json`, JSON.stringify(profile, null, 2), "utf8");
}

async function deleteProfileFile(dir: string, id: string): Promise<void> {
  await unlink(`${dir}/${id}.json`).catch(() => {});
}

function sortedSetKey(ids: ReadonlySet<string>): string {
  const values: string[] = [];
  ids.forEach((id) => {
    values.push(id);
  });
  return values.sort().join("\x1f");
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  return sortedSetKey(a) === sortedSetKey(b);
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

function QuotaErrorBanner({ retryAt }: { retryAt: number }): ReactNode {
  const remaining = retryAt - Date.now();
  const expired = remaining <= 0;
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text color="yellow">
        {expired
          ? "Rate limit reached — retrying…"
          : `Rate limit reached — auto-retry in ${formatCountdown(remaining)}`}
      </Text>
      <Text color="cyan">{"[/agent] Switch provider"}</Text>
    </Box>
  );
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
  // Wall-clock ms timestamp the session started. Drives the whole-session timer
  // in the status bar; reset on /new.
  sessionStartedAt?: number;
  // Inspectable child sessions for the Agents strip and enter-session UI.
  subAgentSessions?: SubAgentSessionStore;
};

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
  globallyOnboarded = false,
  globalOnboardingPath,
  mouseEvents,
  sessionStartedAt: sessionStartedAtProp,
  subAgentSessions,
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
  const [unauthedProviders, setUnauthedProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [loginModal, setLoginModal] = useState<"codex" | "xai" | "choose" | null>(null);
  const [autoLoginProfile, setAutoLoginProfile] = useState<string | undefined>(undefined);
  // Updated every render so the stream callback always sees the current provider.
  onCredentialFailureRef.current = () => {
    if (loginModal !== null) return;
    const xaiName = xaiProfileFromProviderName(provider);
    const codexName = codexProfileFromProviderName(provider);
    if (xaiName !== undefined) {
      void getValidXaiToken(xaiName).then(
        () => {
          // Token is locally valid but the proxy returned 403 — subscription or
          // account-level access issue, not a bad token. Re-authing won't help.
          setCommandMessage(
            `Grok 403: "${xaiName}" has a valid token but the proxy rejected the request. ` +
            `Check your SuperGrok or X Premium+ subscription at grok.com.`,
          );
        },
        (err: unknown) => {
          if (err instanceof XaiAuthError) {
            setAutoLoginProfile(xaiName);
            setLoginModal("xai");
          }
        },
      );
    } else if (codexName !== undefined) {
      // Access token rejected by the provider (or refresh already dead): open
      // the browser re-auth flow instead of leaving the user on a 401 banner.
      setAutoLoginProfile(codexName);
      setLoginModal("codex");
    } else {
      setAutoLoginProfile(undefined);
      setLoginModal("choose");
    }
  };
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactionMode, setCompactionMode] = useState<CompactionMode>(
    initialSettings?.compactionMode ?? "llm",
  );
  const [maxConcurrentSubAgents, setMaxConcurrentSubAgents] = useState(() =>
    resolveMaxConcurrentSubAgents(initialSettings),
  );
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [permissionEntries, setPermissionEntries] = useState<ScopedApproval[]>([]);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [copyModeIndex, setCopyModeIndex] = useState<number | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>(
    initialWorkflowStatus ?? EMPTY_WORKFLOW_STATUS,
  );
  const [workflowHistory, setWorkflowHistory] = useState<WorkflowStatus[]>([]);
  // Messages queued while the agent is processing. Drained one-at-a-time when
  // isProcessing goes false (connector.reply fires). Lives in React state so
  // the drain path goes through sendMessage(), which correctly sets isProcessing.
  const pendingQueueRef = useRef<OutboundUserMessage[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([]);

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

  const codexProfileNames = useMemo(
    () =>
      providerCatalog
        .map((p) => p.codexProfile)
        .filter((name): name is string => name !== undefined),
    [providerCatalog],
  );
  const xaiProfileNames = useMemo(
    () =>
      providerCatalog
        .map((p) => p.xaiProfile)
        .filter((name): name is string => name !== undefined),
    [providerCatalog],
  );

  // Check which OAuth providers currently have valid tokens and update the
  // unauthedProviders set. Called after login/logout and when the agent modal opens.
  const refreshAuthState = (): void => {
    const checks = providerCatalog.flatMap((p) => {
      if (p.xaiProfile !== undefined) {
        const profile = p.xaiProfile;
        const providerName = p.name;
        return [getValidXaiToken(profile).then(
          () => ({ providerName, ok: true }),
          () => ({ providerName, ok: false }),
        )];
      }
      return [];
    });
    void Promise.all(checks).then((results) => {
      const unauthed = new Set(results.filter((r) => !r.ok).map((r) => r.providerName));
      setUnauthedProviders(unauthed);
    });
  };


  // Open the OAuth re-login modal for a dead/missing profile instead of dumping
  // the raw 401. The modal's autoLoginProfile path starts the browser flow
  // immediately so the user does not have to dig through a profile list first.
  const promptCodexRelogin = (name: string): void => {
    setAutoLoginProfile(name);
    setLoginModal("codex");
  };
  const promptXaiRelogin = (name: string): void => {
    setAutoLoginProfile(name);
    setLoginModal("xai");
  };

  const switchToCodexProfile = (name: string): void => {
    void refreshCodexInstructions().catch(() => {});
    void Promise.all([getValidCodexToken(name), fetchCodexModels(name).catch(() => [])]).then(
      ([token, liveModels]) => {
        const accountId = token.accountId;
        // Prefer the account's live model catalog; fall back to the current
        // default set when empty (e.g. while rate-limited the catalog is empty).
        const models = liveModels.length > 0 ? liveModels : [...CODEX_DEFAULT_MODELS];
        const defaultModel = models[0] ?? CODEX_DEFAULT_MODELS[0];
        registerCodexProvider({
          name: codexProviderName(name),
          baseURL: CODEX_BASE_URL,
          apiKey: token.access,
          models,
          defaultModel,
          codexProfile: name,
          ...(accountId !== undefined ? { codexAccountId: accountId } : {}),
        });
      },
      (err: unknown) => {
        // Refresh/token missing: drop the user into the browser re-auth flow
        // rather than surfacing the provider's 401 JSON as a status line.
        if (err instanceof CodexAuthError) {
          promptCodexRelogin(name);
          return;
        }
        setCommandMessage(
          `Could not use Codex profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const removeCodexProfileEverywhere = (name: string): void => {
    removeCodexProvider(codexProviderName(name));
    void removeCodexProfile(name).then(
      () => setCommandMessage(`Removed Codex profile "${name}".`),
      (err: unknown) => setCommandMessage(`Failed to remove Codex profile "${name}": ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  const switchToXaiProfile = (name: string): void => {
    void getValidXaiToken(name).then(
      (token) => {
        const defaultModel = XAI_DEFAULT_MODELS[0];
        registerXaiProvider({
          name: xaiProviderName(name),
          baseURL: XAI_BASE_URL,
          apiKey: token.access,
          models: [...XAI_DEFAULT_MODELS],
          defaultModel,
          xaiProfile: name,
        });
        refreshAuthState();
      },
      (err: unknown) => {
        if (err instanceof XaiAuthError) {
          promptXaiRelogin(name);
          return;
        }
        setCommandMessage(
          `Could not use xAI profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const removeXaiProfileEverywhere = (name: string): void => {
    removeXaiProvider(xaiProviderName(name));
    void removeXaiProfile(name).then(
      () => setCommandMessage(`Removed xAI profile "${name}".`),
      (err: unknown) => setCommandMessage(`Failed to remove xAI profile "${name}": ${err instanceof Error ? err.message : String(err)}`),
    );
  };

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

  const gates = useGates({ eventEmitter, setGatePending: state.setGatePending });

  useEffect(() => {
    const onWorkflow = (state: WorkflowControllerState) => {
      setWorkflowStatus(state.current);
      setWorkflowHistory(state.history);
    };
    eventEmitter.on("workflow", onWorkflow);
    return () => { eventEmitter.off("workflow", onWorkflow); };
  }, [eventEmitter]);

  useEffect(() => {
    if (subAgentSessions === undefined) return;
    return subAgentSessions.subscribe(() => {
      setSessionsTick((n) => n + 1);
    });
  }, [subAgentSessions]);

  // The strip reflects only active work: an agent leaves the visible list the
  // moment it reaches a terminal state. Completed sessions stay in the store
  // for later inspection but no longer occupy the strip or its nav.
  const agentSessions = useMemo(() => {
    void sessionsTick;
    return activeStripSessions(subAgentSessions?.listForStrip() ?? []);
  }, [subAgentSessions, sessionsTick]);

  // A running agent can reach a terminal state while agents-nav is open, which
  // shortens the strip list under the persisted selection index. Clamp at read
  // time so the highlight lands on a real row instead of drifting out of range.
  const agentsNavIndexClamped =
    agentSessions.length === 0 ? 0 : Math.min(agentsNavIndex, agentSessions.length - 1);

  const enteredSession = useMemo(() => {
    void sessionsTick;
    if (enteredSessionId === null || subAgentSessions === undefined) return undefined;
    return subAgentSessions.get(enteredSessionId);
  }, [enteredSessionId, subAgentSessions, sessionsTick]);

  // The task strip renders above the in-flight indicator: one line when compact,
  // the full checklist (plus heading and surrounding margins) when expanded.
  const taskChromeRows =
    !hasActiveTasks(state.tasks)
      ? 0
      : (tasksExpanded ? state.tasks.length + 1 : 1) + 2;

  // The plugins overlay renders outside the modal-stack accounting (like the
  // permissions overlay), so reserve rows for its box: chrome + one row per
  // plugin + the selected plugin's credential rows.
  const pluginChromeRows = (() => {
    if (!pluginsOpen || pluginsAdmin === undefined) return 0;
    const list = pluginsAdmin.list();
    const widestCreds = list.reduce((n, p) => Math.max(n, p.credentials.length), 0);
    return 6 + list.length + widestCreds + 2;
  })();

  // Agents strip (session store) + live progress fallback for chrome height.
  // Prefer the session store list once anything has been spawned this session.
  const activeSubAgents = useMemo(
    () => state.subAgents.filter((a) => a.status !== "done" && a.status !== "cancelled"),
    [state.subAgents],
  );
  // The strip caps rendered rows so retained history never crowds out the
  // transcript; +1 accounts for the surrounding marginTop wrapper.
  const agentsStripRows =
    agentSessions.length > 0
      ? agentsStripRowCount(agentSessions.length, DEFAULT_STRIP_MAX_VISIBLE) + 1
      : activeSubAgents.length > 0
        ? activeSubAgents.length + 2
        : 0;
  const subAgentChromeRows = agentsStripRows;

  const extraChromeRows =
    (mcpStatus.needsAuth.length > 0 ? 1 : 0) +
    (commandMessage !== null ? 1 : 0) +
    taskChromeRows +
    pluginChromeRows +
    (state.quotaError !== null ? 1 : 0) +
    subAgentChromeRows +
    extraPromptChromeRows(inputValue, columns ?? 80, rows ?? 24);

  const layout = useLayoutGeometry({
    columns,
    rows,
    sidebarOpen: false,
    gateContext: {
      pendingPermission: gates.pendingPermission,
      pendingOperator: gates.pendingOperator,
    },
    modalContext: { helpOpen, hookPanelOpen, exitConfirmOpen, agentModalOpen, permissionsOpen: permissionsOpen || settingsOpen, permissionEntryCount: permissionEntries.length },
    hookCount: state.hookCount,
    providerCatalog,
    extraChromeRows,
  });
  const { leftWidth, visibleRows, effectiveOverlayRows, permissionsOverlayRows } = layout;
  // Text wraps and renders inside the gutter so prose never touches the edges.
  const contentWidth = Math.max(8, leftWidth - TEXT_GUTTER * 2);

  // Cleared when layout width or thinking expand change — those affect all blocks.
  // Verbose no longer invalidates the cache: each block already keys collapsed vs
  // expanded layouts separately, and Ctrl+O only expands a viewport-local subset.
  const lineCacheRef = useRef(new Map<string, StyledLine[]>());
  const baseLinesRef = useRef<IncrementalLinesState | undefined>(undefined);
  const incrementalLinesRef = useRef<IncrementalLinesState | undefined>(undefined);
  const lineCacheKeysRef = useRef({ contentWidth, thinkingExpanded });
  if (
    lineCacheKeysRef.current.contentWidth !== contentWidth ||
    lineCacheKeysRef.current.thinkingExpanded !== thinkingExpanded
  ) {
    lineCacheRef.current.clear();
    clearMarkdownLineCache();
    baseLinesRef.current = undefined;
    incrementalLinesRef.current = undefined;
    lineCacheKeysRef.current = { contentWidth, thinkingExpanded };
  }

  // Tools Ctrl+O expands for the current viewport (± buffer). Refreshed after
  // scroll in a layout effect so line layout can depend on a stable Set.
  const [viewportExpandedIds, setViewportExpandedIds] = useState<Set<string>>(() => new Set());

  const explicitExpandKey = useMemo(
    () => sortedSetKey(expandedTools),
    [expandedTools],
  );

  const baseLayoutKey = useMemo(
    () => [
      contentWidth,
      thinkingExpanded ? "1" : "0",
      explicitExpandKey,
      String(state.currentPlanStep),
      state.planDeviated ? "1" : "0",
    ].join("|"),
    [contentWidth, thinkingExpanded, explicitExpandKey, state.currentPlanStep, state.planDeviated],
  );

  const isExplicitlyExpanded = useMemo(
    () => (block: RenderableBlock) => expandedTools.has(block.id),
    [expandedTools],
  );

  // Collapsed layout (explicit Ctrl+R expands only). Reused as the display when
  // verbose is off so toggling Ctrl+O does not throw away the warm incremental state.
  const membershipBase = useMemo(
    () => {
      const next = buildLinesIncremental(
        baseLinesRef.current,
        state.contentBlocks,
        contentWidth,
        thinkingExpanded,
        isExplicitlyExpanded,
        lineCacheRef.current,
        { currentStep: state.currentPlanStep, deviated: state.planDeviated },
        baseLayoutKey,
        DEFAULT_MAX_RENDERED_LOG_LINES,
      );
      baseLinesRef.current = next;
      return next;
    },
    // lineCacheRef is a stable ref — intentionally not in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.displayRevision, baseLayoutKey, contentWidth, thinkingExpanded, isExplicitlyExpanded, state.currentPlanStep, state.planDeviated],
  );

  const resourceBanner = useMemo(
    () => buildResourceBanner(loadedSkills ?? [], activePlugins ?? [], contentWidth),
    [loadedSkills, activePlugins, contentWidth],
  );

  const prefixLineCount =
    resourceBanner.length + (state.trimmedBlockCount > 0 ? 2 : 0);

  const viewportExpandKey = useMemo(
    () => {
      if (!verbose || viewportExpandedIds.size === 0) return "";
      return sortedSetKey(viewportExpandedIds);
    },
    [verbose, viewportExpandedIds],
  );

  const linesLayoutKey = useMemo(
    () => [
      baseLayoutKey,
      verbose ? "1" : "0",
      viewportExpandKey,
    ].join("|"),
    [baseLayoutKey, verbose, viewportExpandKey],
  );

  const isViewportExpanded = useMemo(
    () => {
      if (!verbose || viewportExpandedIds.size === 0) return isExplicitlyExpanded;
      return (block: RenderableBlock) =>
        expandedTools.has(block.id) || viewportExpandedIds.has(block.id);
    },
    [verbose, viewportExpandedIds, expandedTools, isExplicitlyExpanded],
  );

  const eventLogLines = useMemo(
    () => {
      let next: IncrementalLinesState;
      if (!verbose) {
        next = membershipBase;
        incrementalLinesRef.current = next;
      } else {
        next = buildLinesIncremental(
          incrementalLinesRef.current,
          state.contentBlocks,
          contentWidth,
          thinkingExpanded,
          isViewportExpanded,
          lineCacheRef.current,
          { currentStep: state.currentPlanStep, deviated: state.planDeviated },
          linesLayoutKey,
          DEFAULT_MAX_RENDERED_LOG_LINES,
        );
        incrementalLinesRef.current = next;
      }
      return state.trimmedBlockCount > 0
        ? [
            ...resourceBanner,
            [
              { text: `↑ ${state.trimmedBlockCount} earlier message${state.trimmedBlockCount === 1 ? "" : "s"} trimmed to keep the session responsive`, dim: true },
            ] satisfies StyledLine,
            [],
            ...next.lines,
          ]
        : [...resourceBanner, ...next.lines];
    },
    // lineCacheRef is a stable ref — intentionally not in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.displayRevision, state.trimmedBlockCount, membershipBase, linesLayoutKey, contentWidth, thinkingExpanded, verbose, isViewportExpanded, state.currentPlanStep, state.planDeviated, resourceBanner],
  );
  const scrollMaxOffset = maxLineOffset(eventLogLines, visibleRows);

  const lastToolId = useMemo(() => {
    const blocks = state.contentBlocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.type === "tool_call") return blocks[i]!.id;
    }
    return null;
  }, [state.contentBlocks]);

  const scroll = useScroll({ maxOffset: scrollMaxOffset });

  // The entered child view owns its own scroll: the parent transcript and the
  // child transcript have unrelated line counts, so one shared offset would
  // scroll the hidden parent while the child stayed pinned to its newest rows.
  const enteredTranscriptLineCount = useMemo(() => {
    if (enteredSession === undefined) return 0;
    return renderTranscriptLines(
      enteredSession.entries,
      subAgentTranscriptWidth(contentWidth),
    ).length;
  }, [enteredSession, contentWidth]);
  const enteredScrollMaxOffset = subAgentScrollWindow(
    enteredTranscriptLineCount,
    visibleRows,
    0,
  ).maxOffset;
  const enteredScroll = useScroll({ maxOffset: enteredScrollMaxOffset });
  const activeScroll = enteredSession !== undefined ? enteredScroll : scroll;

  // Ctrl+O expands tools intersecting the visible window. Membership uses the
  // *display* layout (same line space as scrollOffset) so mid-scroll tracking
  // stays correct after tools grow. Sticky hold + tool-count cap keep the set
  // from thrashing or exploding under dense tool rows. Toggle seeds the set
  // synchronously so the first verbose paint is already expanded.
  useLayoutEffect(() => {
    if (!verbose) {
      if (viewportExpandedIds.size > 0) setViewportExpandedIds(new Set());
      return;
    }

    const layout = incrementalLinesRef.current;
    if (layout === undefined) return;

    const nextIds = resolveViewportExpandIds({
      blocks: layout.blocks,
      blockLineStarts: layout.blockLineStarts,
      lineCount: layout.lines.length,
      prefixLineCount,
      visibleRows,
      scrollOffset: scroll.scrollOffset,
      atBottom: scroll.atBottom,
      previousIds: viewportExpandedIds,
    });

    if (sameStringSet(nextIds, viewportExpandedIds)) return;
    setViewportExpandedIds(nextIds);
  }, [
    verbose,
    scroll.scrollOffset,
    scroll.atBottom,
    visibleRows,
    // Recompute when either layout changes (content, expand set, prefix).
    membershipBase,
    eventLogLines,
    prefixLineCount,
    viewportExpandedIds,
  ]);

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

  // One controller per in-flight send so Ctrl+C / double-Esc can abort the
  // active run. Aborting rejects the send promise; the reactor's current cycle
  // finishes but no new cycle starts, which is the "Stopping" → "Stopped" path.
  const sendAbortRef = useRef<AbortController | null>(null);
  const [, forceRender] = useState(0);
  const didSendInitial = useRef(false);
  // Incremented on every send so useSpinner can reset its elapsed clock per turn.
  const sendCounterRef = useRef(0);
  const lastSentMessageRef = useRef<string>("");
  const quotaAutoRetryFiredRef = useRef(false);

  const sendMessageRef = useRef<(message: OutboundUserMessage) => void>(null!);
  sendMessageRef.current = (message: OutboundUserMessage) => {
    lastSentMessageRef.current = message.text;
    const trimmed = message.text.trim();
    if (trimmed.length > 0 && getSessionId !== undefined) {
      const sid = getSessionId();
      void appendSentMessage(cwd, sid, trimmed).then(() => {
        setSentHistoryBrowse((prev) => resetSentHistoryBrowse([...prev.sent, trimmed]));
      });
    }
    quotaAutoRetryFiredRef.current = false;
    sendCounterRef.current += 1;
    state.markRunning();
    scroll.scrollToBottom();

    // Append the user message to the transcript immediately (optimistic echo).
    // This ensures the input is visible even when send() is delayed by pre-send
    // work such as Codex/XAI token refresh. The subsequent message.received will
    // no-op the duplicate push.
    const displayContent = message.text.length > 0 ? message.text : "Please inspect the attached image.";
    const attachmentText = message.attachments.length > 0
      ? `\n[Attached ${message.attachments.length} image${message.attachments.length === 1 ? "" : "s"}: ${message.attachments.map((att) => att.name).join(", ")}]`
      : "";
    state.appendUserMessage(`${displayContent}${attachmentText}`);

    // Nudge a re-render so the in-flight indicator and interval timer activate
    // immediately rather than waiting for the first event from the new run.
    forceRender((n) => n + 1);
    const controller = new AbortController();
    sendAbortRef.current = controller;
    const inbound: InboundMessage = {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from: "user@local",
        to: ["agent@local"],
        date: new Date().toISOString(),
        messageId: `<${crypto.randomUUID()}@local>`,
        interchangeType: "conversation.message",
      },
      flags: [],
      signatureStatus: "missing",
      content: message.text.length > 0 ? message.text : "Please inspect the attached image.",
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    };
    agent.send(inbound, { signal: controller.signal }).catch((err: unknown) => {
      const kind = classifyAgentSendFailure(
        err,
        controller.signal.aborted,
        (e): e is CodexAuthError => e instanceof CodexAuthError,
        (e): e is XaiAuthError => e instanceof XaiAuthError,
      );
      if (kind === "abort") return;
      if (shouldSettleUiAfterSendFailure(kind)) {
        state.requestStop();
        gates.resetGates();
        forceRender((n) => n + 1);
      }
      if (kind === "codex_auth") {
        promptCodexRelogin((err as CodexAuthError).profile);
        return;
      }
      if (kind === "xai_auth") {
        promptXaiRelogin((err as XaiAuthError).profile);
        return;
      }
      onAgentError?.(err);
    });
  };
  const sendMessage = (message: OutboundUserMessage) => sendMessageRef.current(message);

  const requestStop = () => {
    quotaAutoRetryFiredRef.current = true;
    sendAbortRef.current?.abort();
    // Parent stop must cancel live children too: aborting the parent send signal
    // is linked into each task's child controller, and cancelAll flips session
    // status + fires registerCancel hooks that close child agents.
    subAgentSessions?.cancelAll("Parent stop");
    onInterrupt?.();
    state.requestStop();
    gates.resetGates();
    // Discard queued messages — a stopped run should not silently replay them
    // into the next session's first turn when connector.reply eventually fires.
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    forceRender((n) => n + 1);
  };

  requestStopRef.current = requestStop;

  const startNewSessionRef = useRef<() => void>(() => undefined);
  startNewSessionRef.current = () => {
    sendAbortRef.current?.abort();
    // Cancel live workers before clearing the strip so child reactors close
    // instead of continuing after /clear.
    subAgentSessions?.cancelAll("New session");
    state.clear();
    gates.resetGates();
    setExpandedTools(new Set());
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    setWorkflowHistory([]);
    setInputValue("");
    setSessionStartedAt(Date.now());
    setEnteredSessionId(null);
    setAgentsNavOpen(false);
    setAgentsNavIndex(0);
    subAgentSessions?.clear();
    onNewSession?.();
    if (getSessionId !== undefined) {
      void loadSentMessages(cwd, getSessionId()).then((sent) => {
        setSentHistoryBrowse(createSentHistoryBrowse(sent));
      });
    } else {
      setSentHistoryBrowse(createSentHistoryBrowse([]));
    }
    scroll.scrollToBottom();
    forceRender((n) => n + 1);
  };
  const startNewSession = () => startNewSessionRef.current();

  const commandContext = useMemo(() => ({
    signalClear: () => startNewSessionRef.current(),
    getMCPServers: () => mcpStatus.servers,
    ...(onStartWorkflow !== undefined ? { startWorkflow: onStartWorkflow } : {}),
    ...(onRenameSession !== undefined ? { renameSession: onRenameSession } : {}),
  }), [mcpStatus.servers, onStartWorkflow, onRenameSession]);

  useEffect(() => {
    if (!initialAuto) onToggleAuto?.(true);
  }, [initialAuto, onToggleAuto]);

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
      })) {
        requestStop();
        setCommandMessage("Request timed out after no response. Please retry.");
      }
    };
    const handle = setInterval(check, 1000);
    return () => clearInterval(handle);
  // `state` is a stable mutable object — only the reactive scalar fields matter here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.awaitingResponse]);

  // When a quota error is active, poll once per second and auto-resubmit the
  // last prompt as soon as the provider's retry-after window expires.
  useEffect(() => {
    if (state.quotaError === null) return;
    const interval = setInterval(() => {
      const qe = stateRef.current.quotaError;
      if (qe === null || quotaAutoRetryFiredRef.current) return;
      if (Date.now() < qe.retryAt) return;
      quotaAutoRetryFiredRef.current = true;
      sendMessageRef.current({ text: lastSentMessageRef.current, attachments: [] });
    }, 1000);
    return () => clearInterval(interval);
  // `state` is a stable mutable object — only `quotaError` drives re-subscription.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.quotaError]);

  // Drain one queued message when the agent finishes a response cycle.
  // Uses a ref for sendMessage so the closure never goes stale. Guards on
  // !isProcessing to avoid double-sending if connector.reply fires back-to-back.
  useEffect(() => {
    const onEvent = (event: { type: string }) => {
      if (event.type !== "connector.reply") return;
      if (pendingQueueRef.current.length === 0) return;
      // Do not drain while a gate is open — connector.reply should not fire
      // mid-gate, but if it does, markRunning() would zero gateCount and
      // corrupt the blocked state.
      if (stateRef.current.status === "blocked") return;
      const text = pendingQueueRef.current.shift()!;
      setQueuedCount((c) => Math.max(0, c - 1));
      sendMessageRef.current(text);
    };
    eventEmitter.on("event", onEvent);
    return () => { eventEmitter.off("event", onEvent); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send the initial task once the App (and its gate listeners) is mounted, so
  // the run is driven through the same abortable path as interactive sends.
  useEffect(() => {
    if (getSessionId === undefined) return;
    void loadSentMessages(cwd, getSessionId()).then((sent) => {
      setSentHistoryBrowse(createSentHistoryBrowse(sent));
    });
  }, [cwd, getSessionId]);

  useEffect(() => {
    if (didSendInitial.current) return;
    didSendInitial.current = true;
    if (skipInitialTask) return;
    if (initialTask.length > 0) sendMessage({ text: initialTask, attachments: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addPendingImage = (attachment: PendingImageAttachment): void => {
    setPendingImages((prev) => [...prev, attachment]);
    setCommandMessage(`Attached image: ${attachment.name}`);
  };

  const handlePasteImage = (): void => {
    setCommandMessage("Reading clipboard image...");
    void readClipboardImage().then((result) => {
      if (!result.ok) {
        setCommandMessage(`Image paste failed: ${result.reason}`);
        return;
      }
      addPendingImage(result.attachment);
    });
  };

  const handlePasteText = (text: string): boolean => {
    const paths = extractPastedImagePaths(text, cwd);
    if (paths.length === 0) return false;
    setCommandMessage(`Attaching ${paths.length} image${paths.length === 1 ? "" : "s"}...`);
    void Promise.all(paths.map((path) => imageAttachmentFromPath(path))).then((results) => {
      const attached = results.filter((result): result is { ok: true; attachment: PendingImageAttachment } => result.ok);
      const failed = results.length - attached.length;
      if (attached.length > 0) {
        setPendingImages((prev) => [...prev, ...attached.map((result) => result.attachment)]);
      }
      setCommandMessage(
        failed > 0
          ? `Attached ${attached.length} image${attached.length === 1 ? "" : "s"}; ${failed} failed.`
          : `Attached ${attached.length} image${attached.length === 1 ? "" : "s"}.`,
      );
    });
    return true;
  };

  const prepareOutboundMessage = async (
    message: string,
    baseAttachments: PendingImageAttachment[],
  ): Promise<OutboundUserMessage> => {
    let text = message;
    const mentions = findImagePathMentions(message, cwd);
    const loaded = await Promise.all(mentions.map((mention) => imageAttachmentFromPath(mention.path)));
    const attachments = [...baseAttachments];
    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i];
      const result = loaded[i];
      if (mention === undefined || result === undefined || !result.ok) continue;
      attachments.push(result.attachment);
      text = text.replace(mention.raw, `[Attached image: ${result.attachment.name}]`);
    }
    return { text: await resolveAtMentions(text, cwd), attachments };
  };

  const handleSend = (message: string) => {
    setCommandMessage(null);
    const attachments = pendingImages;
    setPendingImages([]);
    void prepareOutboundMessage(message, attachments).then((outbound) => {
      // Read live state from the ref — prepareOutboundMessage is async (it does
      // @-mention resolution + disk I/O), so the closed-over state.isProcessing
      // can be stale by the time this resolves. A previous turn can finish and
      // drain the queue during the async window; reading the stale value would
      // then queue a message nothing will ever drain, leaving the UI stuck.
      if (stateRef.current.isProcessing) {
        pendingQueueRef.current.push(outbound);
        setQueuedCount((c) => c + 1);
        return;
      }
      sendMessage(outbound);
    });
  };

  const handleInterrupt = (message: string) => {
    setCommandMessage(null);
    // requestStop must fire synchronously before any async work so the abort
    // signal reaches the in-flight HTTP request before at-mention resolution
    // has a chance to yield, preventing a stale connector.reply from racing
    // the new turn's state.
    requestStop();
    const attachments = pendingImages;
    setPendingImages([]);
    void prepareOutboundMessage(message, attachments).then(sendMessage);
  };

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

  // Whole-session timer for the status bar. Held in state so /new can zero it.
  const [sessionStartedAt, setSessionStartedAt] = useState(sessionStartedAtProp ?? Date.now());
  const sessionElapsedMs = useSessionClock(sessionStartedAt);
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
        || state.quotaError !== null,
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
        onToggleAuto?.(true);
      },
      enterAgentsNav: () => {
        if (agentSessions.length === 0) {
          setCommandMessage("No sub-agent sessions yet — spawn with task first");
          return;
        }
        // Prefer currently entered, else first running, else top of strip.
        const preferred =
          enteredSessionId !== null
            ? agentSessions.findIndex((s) => s.id === enteredSessionId)
            : agentSessions.findIndex((s) => s.status === "running");
        setAgentsNavIndex(preferred >= 0 ? preferred : 0);
        setAgentsNavOpen(true);
      },
      agentsNavPrev: () =>
        setAgentsNavIndex((i) => Math.max(0, Math.min(i, agentSessions.length - 1) - 1)),
      agentsNavNext: () =>
        setAgentsNavIndex((i) => Math.min(Math.max(0, agentSessions.length - 1), i + 1)),
      agentsNavConfirm: () => {
        const pick = agentSessions[agentsNavIndexClamped];
        if (pick === undefined) {
          setAgentsNavOpen(false);
          return;
        }
        setEnteredSessionId(pick.id);
        setAgentsNavOpen(false);
        setCommandMessage(`Viewing ${pick.agentId}: ${pick.description}`);
      },
      agentsNavCancel: () => setAgentsNavOpen(false),
      agentsNavKill: () => {
        const targetId =
          enteredSessionId !== null
            ? enteredSessionId
            : agentSessions[agentsNavIndexClamped]?.id;
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
        setEnteredSessionId(null);
        setCommandMessage("Back to parent session");
      },
    },
  );

  useMouseScroll(
    mouseEvents,
    (ticks) => activeScroll.scrollUp(ticks * 3),
    (ticks) => activeScroll.scrollDown(ticks * 3),
  );

  const handleCommand = (result: CommandResult) => {
    if (result.type === "send") {
      handleSend(result.text);
      return;
    }
    if (result.type === "message") {
      setCommandMessage(result.text);
      return;
    }
    if (result.type === "tier") {
      // Resolve strictly against the named tier (no fast→standard→clever
      // fallback walk) so /fast means "the fast tier's model", not "whatever
      // resolves." Provider names come from the live catalog so a tier assigned
      // this session is recognised without a restart.
      const settings: Settings = {
        providers: Object.fromEntries(providerCatalog.map((p) => [p.name, p])),
        tiers,
      };
      const leg = tierDefinitionAt(result.tier, settings)?.order[0];
      if (leg === undefined) {
        setCommandMessage(`The ${result.tier} tier is not configured. Assign it in /model.`);
        return;
      }
      applySelection(leg.provider, leg.model, reasoningEffort);
      setCommandMessage(`Switched to ${result.tier} tier (${leg.model}).`);
      return;
    }
    if (result.type === "view") {
      setTasksExpanded(true);
      return;
    }
    if (result.type === "overlay") {
      if (result.overlay === "permissions") {
        refreshPermissions();
        setPermissionsOpen(true);
      } else if (result.overlay === "settings") {
        refreshPermissions();
        setSettingsOpen(true);
      } else if (result.overlay === "plugins") {
        if (pluginsAdmin === undefined) {
          setCommandMessage("Plugins are not available in this context.");
        } else {
          setPluginsOpen(true);
        }
      } else {
        setHelpOpen(true);
      }
      return;
    }
    if (result.type === "modal" && result.modal === "agent") {
      setAgentModalOpen(true);
      refreshAuthState();
      const codexName = codexProfileFromProviderName(provider);
      const xaiName = xaiProfileFromProviderName(provider);
      setAgentModalUsage(null);
      if (codexName !== undefined) {
        void fetchCodexUsage(codexName).then(
          (usage) => {
            setAgentModalUsage(formatCodexUsage(usage));
          },
          () => setAgentModalUsage(null),
        );
      } else if (xaiName !== undefined) {
        const entry = providerCatalog.find((e) => e.name === provider);
        void fetchXaiUsage(xaiName, entry?.baseURL).then(
          (usage) => {
            setAgentModalUsage(formatXaiUsage(usage));
          },
          () => setAgentModalUsage(null),
        );
      } else {
        setAgentModalUsage(null);
      }
    }
    if (result.type === "modal" && (result.modal === "codex-login" || result.modal === "xai-login" || result.modal === "login")) {
      if (result.modal === "login") setLoginModal("choose");
      else setLoginModal(result.modal === "xai-login" ? "xai" : "codex");
    }
    if (result.type === "paste-image") {
      handlePasteImage();
      return;
    }
    if (result.type === "workflow") {
      if (onStartWorkflow === undefined) {
        setCommandMessage("Workflows are not available in this context.");
      } else {
        const msg = onStartWorkflow(result.name);
        if (msg.startsWith("Started")) {
          sendMessage({ text: workflowKickoffUserMessage(result.args), attachments: [] });
        } else {
          setCommandMessage(msg);
        }
      }
    }
  };

  const refreshPermissions = () => {
    if (permissionsAdmin === undefined) return;
    void permissionsAdmin.list().then(setPermissionEntries);
  };


  const handleRevokePermission = (entry: ScopedApproval) => {
    if (permissionsAdmin === undefined) return;
    void permissionsAdmin.revoke(entry).then(refreshPermissions);
  };

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
      getLogger(["intercode", "tui", "onboarding"]).error(
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
          pendingPlan={gates.pendingPlan}
          onApprove={gates.approve}
          onReject={gates.reject}
          pendingOperator={gates.pendingOperator}
          onSelectOperator={gates.selectOperator}
          pendingPermission={gates.pendingPermission}
          permissionQueueDepth={gates.permissionQueueDepth}
          onResolvePermission={gates.resolvePermission}
          width={columns}
        />
      </Box>
      {permissionsOpen && (
        <PermissionsManager
          entries={permissionEntries}
          onRevoke={handleRevokePermission}
          onClose={() => setPermissionsOpen(false)}
          maxHeight={permissionsOverlayRows}
        />
      )}
      {settingsOpen && (
        <SettingsOverlay
          permissionEntries={permissionEntries}
          onRevokePermission={handleRevokePermission}
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
          onClose={() => setSettingsOpen(false)}
          maxHeight={permissionsOverlayRows}
        />
      )}
      {pluginsOpen && pluginsAdmin !== undefined && (
        <PluginsManager admin={pluginsAdmin} onClose={() => setPluginsOpen(false)} cwd={cwd} />
      )}
      {loginModal === "choose" && (
        <LoginProviderPicker
          onSelect={(provider) => setLoginModal(provider)}
          onClose={() => setLoginModal(null)}
        />
      )}
      {(loginModal === "codex" || loginModal === "xai") && (
        <CodexLoginModal
          profiles={loginModal === "xai" ? xaiProfileNames : codexProfileNames}
          activeProfile={provider}
          providerPrefix={loginModal === "xai" ? "xai/" : "codex/"}
          title={loginModal === "xai" ? "xAI Login" : "Codex Login"}
          subtitle={loginModal === "xai" ? "Sign in with a SuperGrok or X Premium+ subscription" : "Sign in with a ChatGPT Plus/Pro subscription"}
          providerLabel={loginModal === "xai" ? "xAI" : "Codex"}
          onStartLogin={(name) => {
            const controller = new AbortController();
            const start = loginModal === "xai" ? startXaiLogin : startCodexLogin;
            return start({ profile: name, signal: controller.signal }).then((handle) => ({
              authorizeUrl: handle.authorizeUrl,
              completed: handle.completed,
              cancel: () => {
                controller.abort();
                handle.cancel();
              },
            }));
          }}
          autoLoginProfile={autoLoginProfile}
          onSwitchProfile={loginModal === "xai" ? switchToXaiProfile : switchToCodexProfile}
          onRemoveProfile={loginModal === "xai" ? removeXaiProfileEverywhere : removeCodexProfileEverywhere}
          onClose={() => { setLoginModal(null); setAutoLoginProfile(undefined); }}
        />
      )}
      {mcpStatus.needsAuth.length > 0 && <McpAuthPrompt servers={mcpStatus.needsAuth} />}
      {commandMessage !== null && (
        <Box paddingX={1}>
          <Text color="cyan">{commandMessage}</Text>
        </Box>
      )}
      {!taskFullScreenOpen && (
        <Box flexShrink={0} flexDirection="column">
          {hasActiveTasks(state.tasks) && (
            <Box flexDirection="column" marginTop={1}>
              <TaskView tasks={state.tasks} compact={!tasksExpanded} />
            </Box>
          )}
          {agentSessions.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <AgentsStrip
                sessions={agentSessions}
                selectedId={
                  agentsNavOpen ? (agentSessions[agentsNavIndexClamped]?.id ?? null) : null
                }
                enteredId={enteredSessionId}
                navActive={agentsNavOpen}
              />
            </Box>
          ) : activeSubAgents.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <TaskView tasks={activeSubAgents} title="Agents" />
            </Box>
          ) : null}
          <Box paddingX={1}><Text dimColor>{chromeDividerLine(Math.max(8, columns - 2))}</Text></Box>
          <InFlightIndicator
            active={state.isProcessing}
            timingAnchor={spinnerTiming.anchor}
            toolName={state.currentToolName}
            {...(spinnerLabel !== undefined ? { label: spinnerLabel } : {})}
            {...(() => {
              if (workflowStatus.active && workflowStatus.name !== undefined) {
                return { workflow: { name: workflowStatus.name, stepIndex: workflowStatus.stepIndex, total: workflowStatus.total, label: workflowStatus.label } };
              }
              const last = workflowHistory[workflowHistory.length - 1];
              if (last !== undefined && last.name !== undefined) {
                return { workflow: { name: last.name, stepIndex: last.total - 1, total: last.total, label: "done" } };
              }
              return {};
            })()}
          />
          {state.quotaError !== null && (
            <QuotaErrorBanner retryAt={state.quotaError.retryAt} />
          )}
          {copyModeOpen && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={color("brand")} paddingX={1}>
              <Text color={color("brand")} bold>Copy — ↑/↓ select · y/⏎ copy · a copy all · esc cancel</Text>
              {(() => {
                const windowSize = 6;
                const sel = copyModeIndex ?? 0;
                const start = Math.max(0, Math.min(sel - Math.floor(windowSize / 2), Math.max(0, copyTargetList.length - windowSize)));
                return copyTargetList.slice(start, start + windowSize).map((target, i) => {
                  const idx = start + i;
                  const selected = idx === sel;
                  return (
                    <Text key={target.id} color={selected ? color("text") : color("muted")} dimColor={!selected}>
                      {selected ? "› " : "  "}{target.label}: {target.preview}
                    </Text>
                  );
                });
              })()}
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
            sessionElapsedMs={sessionElapsedMs}
            mcpCount={mcpStatus.connected.length}
          />
        </Box>
        </Box>
      )}
    </Box>
  );
}
