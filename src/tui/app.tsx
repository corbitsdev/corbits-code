import { Box, Text, useApp } from "ink";
import type { AgentStatus, ContentBlockData } from "./use-stream.js";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog, buildLinesIncremental, maxLineOffset, TEXT_GUTTER, type IncrementalLinesState } from "./components/event-log.js";
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
  type Settings,
} from "../config/settings.js";
import { getLogger } from "@intx/log";
import type { SubAgentProvider } from "../subagent/index.js";
import { useSpinner } from "./hooks/use-spinner.js";
import { extraPromptChromeRows } from "./prompt-layout.js";
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
import { copyTargets, transcriptMarkdown } from "./copy.js";
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
import { fetchCodexUsage, fetchCodexModels, formatCodexUsage, recordCodexUsage } from "../auth/codex/usage.js";
import { fetchXaiUsage, formatXaiUsage, recordXaiUsage } from "../auth/xai/usage.js";
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
import "./commands/built-in.js";

const MAX_MENTION_FILE_BYTES = 200_000;
const MAX_MENTION_TOTAL_BYTES = 400_000;
const MAX_MENTION_COUNT = 5;
const MAX_DIRECTORY_SUMMARY_ENTRIES = 200;
const MAX_DIRECTORY_NAMES = 20;

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
  onInjectSkill?: (skillRef: string) => void | Promise<void>;
  onToggleCapability?: (name: CapabilityName) => void;
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
  onInjectSkill,
  onToggleCapability,
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
  const pendingQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);

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
        setCommandMessage(
          err instanceof CodexAuthError
            ? err.message
            : `Could not use Codex profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
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
        // Populate usage for header immediately (xAI has no per-response headers yet).
        void fetchXaiUsage(name).then((u) => recordXaiUsage(u)).catch(() => {});
        refreshAuthState();
      },
      (err: unknown) => {
        setCommandMessage(
          err instanceof XaiAuthError
            ? err.message
            : `Could not use xAI profile "${name}": ${err instanceof Error ? err.message : String(err)}`,
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

  // The task strip renders above the in-flight indicator: one line when compact,
  // the full checklist (plus heading and surrounding margins) when expanded.
  const taskChromeRows =
    state.tasks.length === 0
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

  // McpAuthPrompt and commandMessage render outside the overlay region, so
  // their rows must be subtracted explicitly to prevent the log from overpainting.
  const activeSubAgents = state.subAgents.filter((a) => a.status !== "done");
  const subAgentChromeRows = activeSubAgents.length > 0 ? activeSubAgents.length + 2 : 0;

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
    hookCount: state.hooks.length,
    providerCatalog,
    extraChromeRows,
  });
  const { leftWidth, visibleRows, effectiveOverlayRows, permissionsOverlayRows } = layout;
  // Text wraps and renders inside the gutter so prose never touches the edges.
  const contentWidth = Math.max(8, leftWidth - TEXT_GUTTER * 2);

  // Cleared when layout width or display options change — those affect all blocks.
  const lineCacheRef = useRef(new Map<string, StyledLine[]>());
  const incrementalLinesRef = useRef<IncrementalLinesState | undefined>(undefined);
  const lineCacheKeysRef = useRef({ contentWidth, thinkingExpanded, verbose });
  if (
    lineCacheKeysRef.current.contentWidth !== contentWidth ||
    lineCacheKeysRef.current.thinkingExpanded !== thinkingExpanded ||
    lineCacheKeysRef.current.verbose !== verbose
  ) {
    lineCacheRef.current.clear();
    incrementalLinesRef.current = undefined;
    lineCacheKeysRef.current = { contentWidth, thinkingExpanded, verbose };
  }

  const linesLayoutKey = useMemo(
    () => [
      contentWidth,
      thinkingExpanded ? "1" : "0",
      verbose ? "1" : "0",
      [...expandedTools].sort().join("\x1f"),
      String(state.currentPlanStep),
      state.planDeviated ? "1" : "0",
    ].join("|"),
    [contentWidth, thinkingExpanded, verbose, expandedTools, state.currentPlanStep, state.planDeviated],
  );

  const eventLogLines = useMemo(
    () => {
      const next = buildLinesIncremental(
        incrementalLinesRef.current,
        state.contentBlocks,
        contentWidth,
        thinkingExpanded,
        (block) => verbose || expandedTools.has(block.id),
        lineCacheRef.current,
        { currentStep: state.currentPlanStep, deviated: state.planDeviated },
        linesLayoutKey,
      );
      incrementalLinesRef.current = next;
      if (state.trimmedBlockCount > 0) {
        const marker: StyledLine = [
          { text: `↑ ${state.trimmedBlockCount} earlier message${state.trimmedBlockCount === 1 ? "" : "s"} trimmed to keep the session responsive`, dim: true },
        ];
        return [marker, [], ...next.lines];
      }
      return next.lines;
    },
    // lineCacheRef is a stable ref — intentionally not in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.contentBlocks, state.trimmedBlockCount, linesLayoutKey, contentWidth, thinkingExpanded, verbose, expandedTools, state.currentPlanStep, state.planDeviated],
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

  const latestUserMessageInLog = state.contentBlocks.some((block) =>
    block.type === "user" && block.content === state.latestUserMessage
  );
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
    copyModeIndex !== null
  );

  const copyTargetList = useMemo(() => copyTargets(state.contentBlocks), [state.contentBlocks]);
  const copyModeOpen = copyModeIndex !== null;

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

  const sendMessageRef = useRef<(message: string) => void>(null!);
  sendMessageRef.current = (message: string) => {
    lastSentMessageRef.current = message;
    const trimmed = message.trim();
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
    // Nudge a re-render so the in-flight indicator and interval timer activate
    // immediately rather than waiting for the first event from the new run.
    forceRender((n) => n + 1);
    const controller = new AbortController();
    sendAbortRef.current = controller;
    agent.send(message, { signal: controller.signal }).catch((err: unknown) => {
      // A user-initiated stop aborts the send; that is expected, not an error.
      if (controller.signal.aborted) return;
      onAgentError?.(err);
    });
  };
  const sendMessage = (message: string) => sendMessageRef.current(message);

  const requestStop = () => {
    quotaAutoRetryFiredRef.current = true;
    sendAbortRef.current?.abort();
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
    state.clear();
    gates.resetGates();
    setExpandedTools(new Set());
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    setWorkflowHistory([]);
    setInputValue("");
    setSessionStartedAt(Date.now());
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
      sendMessageRef.current(lastSentMessageRef.current);
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
    if (initialTask.length > 0) sendMessage(initialTask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = (message: string) => {
    setCommandMessage(null);
    void resolveAtMentions(message, cwd).then((resolved) => {
      if (state.isProcessing) {
        pendingQueueRef.current.push(resolved);
        setQueuedCount((c) => c + 1);
        return;
      }
      sendMessage(resolved);
    });
  };

  const handleInterrupt = (message: string) => {
    setCommandMessage(null);
    // requestStop must fire synchronously before any async work so the abort
    // signal reaches the in-flight HTTP request before at-mention resolution
    // has a chance to yield, preventing a stale connector.reply from racing
    // the new turn's state.
    requestStop();
    void resolveAtMentions(message, cwd).then((resolved) => {
      sendMessage(resolved);
    });
  };

  // Spin for the full duration of a send cycle (markRunning → connector.reply).
  // The label tracks the live phase so "Thinking…" is reserved for reasoning
  // chunks, not tool execution or response waits.
  const awaitingResponse = state.status === "running" && state.awaitingResponse;
  const spinnerTiming = useSpinner(state.isProcessing, sendCounterRef.current);
  const spinnerLabel = (() => {
    if (!state.isProcessing) return undefined;
    if (state.currentToolName !== null || state.streamingType === "tool") return "Running tool…";
    if (state.streamingType === "thinking") return "Thinking…";
    if (state.streamingType === "text") return "Responding…";
    if (awaitingResponse) return "Working…";
    return "Working…";
  })();

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
      scrollUp: () => scroll.scrollUp(visibleRows),
      scrollDown: () => scroll.scrollDown(visibleRows),
      scrollToBottom: () => scroll.scrollToBottom(),
      toggleVerbose: () => {
        setVerbose((v) => !v);
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
        if (copyTargetList.length === 0) {
          setCommandMessage("Nothing to copy yet");
          return;
        }
        setCopyModeIndex(copyTargetList.length - 1);
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
    },
  );

  useMouseScroll(
    mouseEvents,
    () => scroll.scrollUp(3),
    () => scroll.scrollDown(3),
  );

  const handleCommand = (result: CommandResult) => {
    if (result.type === "send") {
      handleSend(result.text);
      return;
    }
    if (result.type === "skill") {
      const run = async (): Promise<void> => {
        await onInjectSkill?.(result.skill);
        if (result.text !== undefined && result.text.length > 0) {
          handleSend(result.text);
        }
      };
      void run();
      return;
    }
    if (result.type === "message") {
      setCommandMessage(result.text);
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
            recordCodexUsage(usage);
            setAgentModalUsage(formatCodexUsage(usage));
          },
          () => setAgentModalUsage(null),
        );
      } else if (xaiName !== undefined) {
        void fetchXaiUsage(xaiName).then(
          (usage) => {
            recordXaiUsage(usage);
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
    if (result.type === "workflow") {
      if (onStartWorkflow === undefined) {
        setCommandMessage("Workflows are not available in this context.");
      } else {
        const msg = onStartWorkflow(result.name);
        if (msg.startsWith("Started")) {
          sendMessage(workflowKickoffUserMessage(result.args));
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
        />
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
        {taskFullScreenOpen ? (
          <TaskView
            tasks={state.tasks}
          />
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
        onRequestAgentUsage={(kind, profile) => {
          setAgentModalUsage(null);
          if (kind === "codex") {
            void fetchCodexUsage(profile).then(
              (u) => { recordCodexUsage(u); setAgentModalUsage(formatCodexUsage(u)); },
              () => {},
            );
          } else {
            void fetchXaiUsage(profile).then(
              (u) => { recordXaiUsage(u); setAgentModalUsage(formatXaiUsage(u)); },
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
        onResolvePermission={gates.resolvePermission}
        width={columns}
      />
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
        <PluginsManager admin={pluginsAdmin} onClose={() => setPluginsOpen(false)} />
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
          {state.tasks.length > 0 && (
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
              <TaskView tasks={state.tasks} compact={!tasksExpanded} />
            </Box>
          )}
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
              model={model}
              rows={rows}
              columns={columns}
              {...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {})}
              {...(revolvingVerb !== undefined ? { verb: revolvingVerb } : {})}
            />
          )}
          {state.subAgents.some((a) => a.status !== "done") && (
            <Box flexDirection="column" marginTop={1}>
              <TaskView tasks={state.subAgents.filter((a) => a.status !== "done")} title="Agents" />
            </Box>
          )}
        <StatusBar
          sessionElapsedMs={sessionElapsedMs}
          mcpCount={mcpStatus.connected.length}
        />
        </Box>
      )}
    </Box>
  );
}
