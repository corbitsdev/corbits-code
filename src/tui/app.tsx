import { Box, Text, useApp } from "ink";
import type { AgentStatus } from "./use-stream.js";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog, buildLineUnits, maxScrollOffset } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";
import { ContextPanel, type ContextView } from "./components/context-panel.js";
import { DiffView } from "./components/diff-view.js";
import { PlanView } from "./components/plan-view.js";
import { ExitConfirm } from "./components/exit-confirm.js";
import { AgentModal, toAgentProviders, type ProviderFormSubmission } from "./components/agent-modal.js";
import { ModalStack } from "./components/modal-stack.js";
import { PermissionsManager } from "./components/permissions-manager.js";
import type { PermissionsAdmin, ScopedApproval } from "../permission/admin.js";
import { InFlightIndicator } from "./components/in-flight-indicator.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import type { SubAgentProvider } from "../subagent/index.js";
import { useSpinner } from "./hooks/use-spinner.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useScroll } from "./hooks/use-scroll.js";
import { useDiff } from "./hooks/use-diff.js";
import { useKeymap } from "./hooks/use-keymap.js";
import { useMCPStatus } from "./hooks/use-mcp-status.js";
import { McpAuthPrompt } from "./components/mcp-auth-prompt.js";
import { CodexLoginModal } from "./components/codex-login-modal.js";
import { writeClipboard } from "./util/clipboard.js";
import { useProviderManager } from "./hooks/use-provider-manager.js";
import { startCodexLogin } from "../auth/codex/login.js";
import { getValidCodexToken, CodexAuthError } from "../auth/codex/session.js";
import { removeCodexProfile } from "../auth/codex/store.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js";
import { codexProviderName } from "../config/codex-providers.js";
import { useLayoutGeometry } from "./hooks/use-layout-geometry.js";
import type { CommandResult } from "./commands/registry.js";
import { listCommands } from "./commands/registry.js";
import type { AgentProfile } from "../agent/profiles.js";
import { writeFile, mkdir, unlink, readFile, opendir, realpath, stat } from "node:fs/promises";
import { resolve, isAbsolute, relative, sep } from "node:path";
import type { LifecycleHookStatus } from "../session/hooks.js";
import { WorkflowPanel } from "./components/workflow-panel.js";
import { WorkflowPickerModal } from "./components/workflow-picker-modal.js";
import type { WorkflowStatus } from "./workflow-controller.js";
import type { CapabilityName } from "../workflows/types.js";
import { WORKFLOWS } from "../workflows/index.js";
import { isSensitivePath } from "../plugins/secret-guard-plugin.js";
import "./commands/built-in.js";
import "./commands/plan.js";
import "./commands/workflows.js";

const MAX_MENTION_FILE_BYTES = 200_000;
const MAX_MENTION_TOTAL_BYTES = 400_000;
const MAX_MENTION_COUNT = 5;
const MAX_DIRECTORY_SUMMARY_ENTRIES = 200;
const MAX_DIRECTORY_NAMES = 20;

async function resolveWorkspacePath(cwd: string, path: string): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  if (isAbsolute(path) || path === "~" || path.startsWith("~/")) {
    return { ok: false, reason: "use a workspace-relative path" };
  }

  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || rel === ".." || rel.startsWith(sep) || rel.startsWith("/")) {
    return { ok: false, reason: "outside workspace" };
  }

  try {
    const [realAbs, realCwd] = await Promise.all([realpath(abs), realpath(cwd)]);
    const realRel = relative(realCwd, realAbs);
    if (realRel.startsWith("..") || realRel === ".." || realRel.startsWith(sep) || realRel.startsWith("/")) {
      return { ok: false, reason: "outside workspace" };
    }
    return { ok: true, abs: realAbs };
  } catch {
    return { ok: false, reason: "not found" };
  }
}

// Resolve @path/to/file mentions in a user message. Each @mention is replaced
// with the file's contents wrapped in a labelled fenced block so the agent gets
// full context without having to call read_file. Mentions that cannot be read
// safely are replaced with a short warning so the agent knows.
// Summarize a directory as a single line: file/subdir counts + subdir names.
// e.g. "47 files, 4 subdirectories (components/, hooks/, commands/, tui/)"
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
  // Match @word, @path/with/slashes, or @"quoted path" - stop at whitespace.
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
    const resolved = await resolveWorkspacePath(cwd, path);
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
export const STALL_TIMEOUT_MS = 120_000;

export type AgentMode = "edit" | "auto" | "plan";

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
  initialHooks?: LifecycleHookStatus[];
  onToggleHook?: (hookId: string, enabled: boolean) => void;
  onAgentError?: (err: unknown) => void;
  onInterrupt?: () => void;
  onNewSession?: () => void;
  permissionsAdmin?: PermissionsAdmin;
  profile?: string;
  initialAuto?: boolean;
  onToggleAuto?: (value: boolean) => void;
  onSubAgentProviderChange?: (provider: SubAgentProvider) => void;
  onStartWorkflow?: (name: string) => string;
  listWorkflows?: () => Array<{ name: string; description: string }>;
  onEnterPlanMode?: () => void;
  onExitPlanMode?: () => void;
  onToggleCapability?: (name: CapabilityName) => void;
  initialWorkflowStatus?: WorkflowStatus;
  initialProfiles?: AgentProfile[];
  profilesDir?: string;
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
  initialHooks = [],
  onToggleHook,
  onAgentError,
  onInterrupt,
  onNewSession,
  permissionsAdmin,
  profile,
  initialAuto = false,
  onToggleAuto,
  onSubAgentProviderChange,
  onStartWorkflow,
  listWorkflows,
  onEnterPlanMode,
  onExitPlanMode,
  onToggleCapability,
  initialWorkflowStatus,
  initialProfiles = [],
  profilesDir,
}: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter, initialHooks);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mcpStatus = useMCPStatus(eventEmitter);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [inputValue, setInputValue] = useState("");
  const [hookPanelOpen, setHookPanelOpen] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(() => new Set());
  const [verbose, setVerbose] = useState(false);
  const [agentMode, setAgentMode] = useState<AgentMode>(initialAuto ? "auto" : "edit");
  const agentModeRef = useRef(agentMode);
  agentModeRef.current = agentMode;
  const auto = agentMode === "auto";
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [contextView, setContextView] = useState<ContextView>("plan");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [diffScroll, setDiffScroll] = useState(0);
  const [planScroll, setPlanScroll] = useState(0);
  const [diffFullScreenOpen, setDiffFullScreenOpen] = useState(false);
  const [planFullScreenOpen, setPlanFullScreenOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [codexLoginOpen, setCodexLoginOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionEntries, setPermissionEntries] = useState<ScopedApproval[]>([]);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>(
    initialWorkflowStatus ?? EMPTY_WORKFLOW_STATUS,
  );
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
    cwd,
    globalSettingsPath,
    agent,
    onMessage: setCommandMessage,
    ...(onSubAgentProviderChange !== undefined ? { onSelectionChange: onSubAgentProviderChange } : {}),
  });
  const { provider, model, reasoningEffort, providerCatalog, applySelection, persistSelection, upsertProvider, deleteProvider, tiers, saveTierAssignment, registerCodexProvider, removeCodexProvider } = providerManager;

  // Codex profile names currently known, derived from the live catalog so the
  // login modal stays in sync after a login or removal.
  const codexProfileNames = useMemo(
    () =>
      providerCatalog
        .map((p) => p.codexProfile)
        .filter((name): name is string => name !== undefined),
    [providerCatalog],
  );

  // Resolve a fresh access token for a Codex profile and make it the active
  // provider. Surfaces a re-login hint if the profile can no longer be used.
  const switchToCodexProfile = (name: string): void => {
    void getValidCodexToken(name).then(
      (token) => {
        registerCodexProvider({
          name: codexProviderName(name),
          baseURL: CODEX_BASE_URL,
          apiKey: token,
          models: [...CODEX_DEFAULT_MODELS],
          defaultModel: CODEX_DEFAULT_MODELS[0],
          codexProfile: name,
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

  const [profiles, setProfiles] = useState<AgentProfile[]>(initialProfiles);

  const saveProfile = (profile: AgentProfile): { ok: true } | { ok: false; error: string } => {
    if (profilesDir === undefined) return { ok: false, error: "No profiles directory configured" };
    setProfiles((prev) => {
      const next = prev.filter((p) => p.id !== profile.id);
      next.push(profile);
      return next.sort((a, b) => a.id.localeCompare(b.id));
    });
    void writeProfileFile(profilesDir, profile);
    return { ok: true };
  };

  const deleteProfile = (id: string): void => {
    if (profilesDir === undefined) return;
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    void deleteProfileFile(profilesDir, id);
  };

  const gates = useGates({ eventEmitter, setGatePending: state.setGatePending });

  // Live workflow status published by the WorkflowController in the runner.
  useEffect(() => {
    const onWorkflow = (status: WorkflowStatus) => setWorkflowStatus(status);
    eventEmitter.on("workflow", onWorkflow);
    return () => { eventEmitter.off("workflow", onWorkflow); };
  }, [eventEmitter]);

  // Sync TUI mode with director plan phase transitions.
  // active=true: agent called plan_enter — switch to Plan mode.
  // active=false: plan approved — revert to Edit, but only if we were in Plan mode.
  useEffect(() => {
    const onPlanPhase = (active: boolean) => {
      if (active) {
        onEnterPlanMode?.();
        setAgentMode("plan");
      } else if (agentModeRef.current === "plan") {
        setAgentMode("edit");
      }
    };
    eventEmitter.on("plan-phase", onPlanPhase);
    return () => { eventEmitter.off("plan-phase", onPlanPhase); };
  }, [eventEmitter, onEnterPlanMode]);

  const planBlock = useMemo(() => {
    const block = state.contentBlocks.find((b) => b.type === "plan");
    return block?.type === "plan" ? block : undefined;
  }, [state.contentBlocks]);
  const planSteps = planBlock?.steps ?? [];
  const planGoal = planBlock?.goal;

  // Sidebar opens automatically when there's a plan or an active workflow.
  // Manual sidebarOpen still works for the diff view.
  const autoSidebarOpen = planSteps.length > 0 || workflowStatus.active;
  const effectiveSidebarOpen = sidebarOpen || autoSidebarOpen || workflowPanelOpen;

  // McpAuthPrompt and commandMessage render outside the overlay region, so
  // their rows must be subtracted explicitly to prevent the log from overpainting.
  const extraChromeRows =
    (mcpStatus.needsAuth.length > 0 ? 1 : 0) +
    (commandMessage !== null ? 1 : 0);

  const layout = useLayoutGeometry({
    columns,
    rows,
    sidebarOpen: effectiveSidebarOpen,
    gateContext: {
      pendingPermission: gates.pendingPermission,
      pendingPlan: gates.pendingPlan,
      pendingOperator: gates.pendingOperator,
    },
    modalContext: { helpOpen, hookPanelOpen, exitConfirmOpen, agentModalOpen, permissionsOpen, permissionEntryCount: permissionEntries.length },
    hookCount: state.hooks.length,
    providerCatalog,
    extraChromeRows,
  });
  const { leftWidth, rightWidth, visibleRows, diffVisibleRows, effectiveOverlayRows, permissionsOverlayRows } = layout;

  const scrollMaxOffset = useMemo(
    () => maxScrollOffset(
      buildLineUnits(
        state.contentBlocks,
        leftWidth,
        thinkingExpanded,
        (block) => verbose || expandedTools.has(block.id),
      ),
      visibleRows,
    ),
    [state.contentBlocks, leftWidth, thinkingExpanded, verbose, expandedTools, visibleRows],
  );

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

  const modeColor = agentMode === "plan" ? color("success") : agentMode === "auto" ? color("warning") : color("accent");

  const diffActive = (sidebarOpen && contextView === "diff") || diffFullScreenOpen;
  const diff = useDiff({ cwd: process.cwd(), active: diffActive });
  const diffLineCount = useMemo(
    () => (diff.result?.available ? diff.result.files.reduce((n, f) => n + f.lines.length, 0) : 0),
    [diff.result],
  );
  const diffMaxOffset = Math.max(0, diffLineCount - diffVisibleRows);

  // Input is inert while any overlay, modal, or gate is capturing keys, so
  // keystrokes (and Enter) never leak into the prompt underneath.
  const inputActive = !(
    exitConfirmOpen ||
    helpOpen ||
    gates.gateOpen ||
    hookPanelOpen ||
    agentModalOpen ||
    codexLoginOpen ||
    permissionsOpen ||
    workflowPanelOpen
  );

  // One controller per in-flight send so Ctrl+C / double-Esc can abort the
  // active run. Aborting rejects the send promise; the reactor's current cycle
  // finishes but no new cycle starts, which is the "Stopping" → "Stopped" path.
  const sendAbortRef = useRef<AbortController | null>(null);
  const [, forceRender] = useState(0);
  const didSendInitial = useRef(false);
  // Incremented on every send so useSpinner can reset its elapsed clock per turn.
  const sendCounterRef = useRef(0);

  const sendMessageRef = useRef<(message: string) => void>(null!);
  sendMessageRef.current = (message: string) => {
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
    sendAbortRef.current?.abort();
    onInterrupt?.();
    state.requestStop();
    // Discard queued messages — a stopped run should not silently replay them
    // into the next session's first turn when connector.reply eventually fires.
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    forceRender((n) => n + 1);
  };

  const startNewSessionRef = useRef<() => void>(() => undefined);
  startNewSessionRef.current = () => {
    sendAbortRef.current?.abort();
    state.clear();
    gates.resetGates();
    setExpandedTools(new Set());
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    onNewSession?.();
    scroll.scrollToBottom();
    forceRender((n) => n + 1);
  };
  const startNewSession = () => startNewSessionRef.current();

  const commandContext = useMemo(() => ({
    getVerbose: () => verbose,
    toggleVerbose: () => {
      const next = !verbose;
      setVerbose(next);
      return next;
    },
    getAuto: () => agentMode === "auto",
    toggleAuto: () => {
      const next = agentMode !== "auto";
      setAgentMode(next ? "auto" : "edit");
      onToggleAuto?.(next);
      return next;
    },
    signalClear: () => startNewSessionRef.current(),
    getMCPServers: () => mcpStatus.servers,
    ...(onStartWorkflow !== undefined ? { startWorkflow: onStartWorkflow } : {}),
    ...(listWorkflows !== undefined ? { listWorkflows } : {}),
    ...(onEnterPlanMode !== undefined ? { enterPlanMode: onEnterPlanMode } : {}),
    openWorkflowPanel: () => setWorkflowPanelOpen(true),
    openWorkflowPicker: () => setWorkflowPickerOpen(true),
  }), [verbose, agentMode, onToggleAuto, mcpStatus.servers, onStartWorkflow, listWorkflows, onEnterPlanMode]);

  // Track the last moment real progress was observed. Reset whenever new content
  // blocks arrive or the streaming type changes (both are signs the model is alive).
  const lastActivityAtRef = useRef(Date.now());
  const contentBlocksLength = state.contentBlocks.length;
  useEffect(() => {
    lastActivityAtRef.current = Date.now();
  }, [contentBlocksLength, state.streamingType]);

  // Watchdog: if the run stays in the awaiting-response gap beyond STALL_TIMEOUT_MS
  // with no new content, abort the in-flight request and surface a message so the
  // user knows they need to retry rather than waiting indefinitely.
  useEffect(() => {
    if (state.status !== "running") return;
    const check = () => {
      if (shouldAbortForStall({
        status: state.status,
        awaitingResponse: state.awaitingResponse,
        lastActivityAt: lastActivityAtRef.current,
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
    if (didSendInitial.current) return;
    didSendInitial.current = true;
    if (initialTask.length > 0) sendMessage(initialTask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = (message: string) => {
    setCommandMessage(null);
    // Resolve @file mentions before the message reaches the agent. This is
    // async; we fire-and-forget here so the send is non-blocking, trusting
    // that the message will be queued when processing is still ongoing.
    void resolveAtMentions(message, cwd).then((resolved) => {
      if (state.isProcessing) {
        pendingQueueRef.current.push(resolved);
        setQueuedCount((c) => c + 1);
        return;
      }
      sendMessage(resolved);
    });
  };

  // Spin for the full duration of a send cycle (markRunning → connector.reply):
  // "Thinking…" while waiting for the model's first token, "Working…" while
  // tools are executing between inference turns. isProcessing covers both phases
  // and correctly clears when connector.reply fires (unlike status === "running",
  // which stays set while the reactor is in wait() between user messages).
  const awaitingResponse = state.status === "running" && state.awaitingResponse;
  const spinner = useSpinner(state.isProcessing, sendCounterRef.current);
  const spinnerLabel = state.isProcessing && !awaitingResponse ? "Working…" : undefined;

  useKeymap(
    {
      exitConfirmOpen,
      // The permissions overlay owns input through its own useInput, exactly
      // like the help overlay, so block the global keymap the same way.
      helpOpen: helpOpen || permissionsOpen,
      gateOpen: gates.gateOpen,
      agentModalOpen: agentModalOpen || workflowPickerOpen || codexLoginOpen,
      hookPanelOpen,
      diffFullScreenOpen,
      planFullScreenOpen,
      workflowPanelOpen,
      hasInput: inputValue.length > 0,
      inputFocused: inputActive,
      commandPaletteOpen: inputValue.startsWith("/") && (
        !inputValue.includes(" ") ||
        listCommands().some(
          (c) => c.subcommands !== undefined && inputValue.startsWith(`/${c.name} `),
        )
      ),
      // "stopping" is deliberately excluded: a stop is already in flight, so the
      // next Ctrl+C / double-Esc should escalate to the exit path rather than
      // re-issuing a no-op stop and trapping the user while the run drains.
      isRunning: state.status === "running" || state.status === "blocked",
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
      scrollUp: () => {
        if (diffActive) setDiffScroll((o) => Math.max(0, o - 1));
        else scroll.scrollUp();
      },
      scrollDown: () => {
        if (diffActive) setDiffScroll((o) => Math.min(diffMaxOffset, o + 1));
        else scroll.scrollDown();
      },
      scrollToBottom: () => {
        if (diffActive) setDiffScroll(diffMaxOffset);
        else scroll.scrollToBottom();
      },
      toggleVerbose: () => {
        setVerbose((v) => !v);
      },
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
      togglePlanSidebar: () => {
        setPlanFullScreenOpen((open) => {
          if (open) setPlanScroll(0);
          return !open;
        });
      },
      toggleDiffFullScreen: () => {
        setDiffFullScreenOpen((open) => {
          if (open) setDiffScroll(0);
          return !open;
        });
      },
      toggleWorkflowPanel: () => setWorkflowPanelOpen((open) => !open),
      toggleHelp: () => setHelpOpen((open) => !open),
      copyMcpUrl: () => {
        const first = mcpStatus.needsAuth[0];
        if (first !== undefined) {
          writeClipboard(first.url);
          setCommandMessage(`Copied authorization URL for ${first.name}`);
        }
      },
      copyLastOutput: () => {
        // MCP auth URL takes priority when one is pending.
        const first = mcpStatus.needsAuth[0];
        if (first !== undefined) {
          writeClipboard(first.url);
          setCommandMessage(`Copied authorization URL for ${first.name}`);
          return;
        }
        // Walk backwards for the last copyable block: reply, text, or tool_result.
        const blocks = state.contentBlocks;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.type === "reply" || b.type === "text") {
            writeClipboard(b.content);
            setCommandMessage("Copied to clipboard");
            return;
          }
          if (b.type === "tool_result") {
            writeClipboard(b.content);
            setCommandMessage(`Copied ${b.name} output`);
            return;
          }
        }
      },
      cycleMode: () => {
        const order: AgentMode[] = ["edit", "auto", "plan"];
        const next = order[(order.indexOf(agentMode) + 1) % order.length]!;
        if (next === "plan") {
          onEnterPlanMode?.();
          onToggleAuto?.(false);
          setAgentMode("plan");
        } else {
          // Leaving plan mode — tell the director to unlock write/edit tools.
          if (agentMode === "plan") onExitPlanMode?.();
          const isAuto = next === "auto";
          onToggleAuto?.(isAuto);
          setAgentMode(next);
        }
      },
    },
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
    if (result.type === "view") {
      setDiffScroll(0);
      setContextView(result.view);
      setSidebarOpen(true);
      return;
    }
    if (result.type === "overlay") {
      if (result.overlay === "permissions") {
        refreshPermissions();
        setPermissionsOpen(true);
      } else {
        setHelpOpen(true);
      }
      return;
    }
    if (result.type === "modal" && result.modal === "agent") {
      setAgentModalOpen(true);
    }
    if (result.type === "modal" && result.modal === "codex-login") {
      setCodexLoginOpen(true);
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

  return (
    <Box flexDirection="column" height={rows}>
      <Box
        flexShrink={0}
        flexDirection="column"
        borderStyle="single"
        borderColor={color("muted")}
        borderTop={false}
        borderBottom
        borderLeft={false}
        borderRight={false}
      >
        <Header
          sessionTitle={sessionTitle}
          latestUserMessage={headerLatestUserMessage}
          width={columns}
          {...(profile !== undefined ? { profile } : {})}
          {...(workflowStatus.active && workflowStatus.name !== undefined
            ? {
                workflow: {
                  name: workflowStatus.name,
                  stepIndex: workflowStatus.stepIndex,
                  total: workflowStatus.total,
                  label: workflowStatus.label,
                },
              }
            : {})}
        />
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
        {planFullScreenOpen ? (
          <PlanView
            steps={planSteps}
            currentPlanStep={state.currentPlanStep}
            planDeviated={state.planDeviated}
            width={columns}
            borderColor={modeColor}
            {...(planGoal !== undefined ? { goal: planGoal } : {})}
          />
        ) : diffFullScreenOpen ? (
          <DiffView
            result={diff.result}
            scrollOffset={diffScroll}
            visibleRows={visibleRows}
            width={columns}
          />
        ) : (
          <>
            <Box width={leftWidth} flexDirection="column" overflow="hidden">
              <EventLog
                contentBlocks={state.contentBlocks}
                scrollOffset={scroll.scrollOffset}
                visibleRows={visibleRows}
                columns={leftWidth}
                thinkingExpanded={thinkingExpanded}
                expandedTools={expandedTools}
                verbose={verbose}
              />
            </Box>
            {effectiveSidebarOpen && (
              <Box width={rightWidth} flexDirection="column" overflow="hidden">
                {(workflowPanelOpen || (workflowStatus.active && contextView !== "diff" && planSteps.length === 0)) ? (
                  <WorkflowPanel
                    status={workflowStatus}
                    width={rightWidth}
                    maxRows={visibleRows}
                    onToggleCapability={(name) => onToggleCapability?.(name)}
                    onClose={() => setWorkflowPanelOpen(false)}
                  />
                ) : (
                  <ContextPanel
                    view={contextView}
                    steps={planSteps}
                    currentPlanStep={state.currentPlanStep}
                    planDeviated={state.planDeviated}
                    width={rightWidth}
                    diffResult={diff.result}
                    diffScrollOffset={diffScroll}
                    diffVisibleRows={diffVisibleRows}
                    borderColor={modeColor}
                    {...(planGoal !== undefined ? { goal: planGoal } : {})}
                  />
                )}
              </Box>
            )}
          </>
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
        agentProfiles={profiles}
        onSaveAgentProfile={saveProfile}
        onDeleteAgentProfile={deleteProfile}
        pendingPlan={gates.pendingPlan}
        onApprove={gates.approve}
        onReject={gates.reject}
        pendingOperator={gates.pendingOperator}
        onSelectOperator={gates.selectOperator}
        pendingPermission={gates.pendingPermission}
        onResolvePermission={gates.resolvePermission}
        width={columns}
      />
      {workflowPickerOpen && (
        <WorkflowPickerModal
          workflows={WORKFLOWS}
          onSelect={(name) => {
            setWorkflowPickerOpen(false);
            if (onStartWorkflow !== undefined) {
              const msg = onStartWorkflow(name);
              if (msg.startsWith("Started")) {
                sendMessage(`Begin the ${name} workflow.`);
              } else {
                setCommandMessage(msg);
              }
            }
          }}
          onClose={() => setWorkflowPickerOpen(false)}
        />
      )}
      {permissionsOpen && (
        <PermissionsManager
          entries={permissionEntries}
          onRevoke={handleRevokePermission}
          onClose={() => setPermissionsOpen(false)}
          maxHeight={permissionsOverlayRows}
        />
      )}
      {codexLoginOpen && (
        <CodexLoginModal
          profiles={codexProfileNames}
          activeProfile={provider}
          onStartLogin={(name) => {
            const controller = new AbortController();
            return startCodexLogin({ profile: name, signal: controller.signal }).then((handle) => ({
              authorizeUrl: handle.authorizeUrl,
              completed: handle.completed,
              cancel: () => {
                controller.abort();
                handle.cancel();
              },
            }));
          }}
          onSwitchProfile={switchToCodexProfile}
          onRemoveProfile={removeCodexProfileEverywhere}
          onClose={() => setCodexLoginOpen(false)}
        />
      )}
      {mcpStatus.needsAuth.length > 0 && <McpAuthPrompt servers={mcpStatus.needsAuth} />}
      {commandMessage !== null && (
        <Box paddingX={1}>
          <Text color="cyan">{commandMessage}</Text>
        </Box>
      )}
      {!planFullScreenOpen && !diffFullScreenOpen && (
        <Box flexShrink={0} flexDirection="column">
          <InFlightIndicator
            active={state.isProcessing}
            frame={spinner.frame}
            elapsedMs={spinner.elapsedMs}
            {...(spinnerLabel !== undefined ? { label: spinnerLabel } : {})}
          />
          <Box
            borderStyle="single"
            borderColor={modeColor}
            borderTop
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
          />
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
            />
          )}
        <StatusBar
          provider={provider}
          model={model}
          cost={state.formattedCost}
          inputTokens={state.inputTokens}
          outputTokens={state.outputTokens}
          cacheReadTokens={state.cacheReadTokens}
          elapsedMs={state.elapsedMs}
          status={state.status}
          reasoningEffort={reasoningEffort}
          auto={auto}
          agentMode={agentMode}
        />
        </Box>
      )}
    </Box>
  );
}
