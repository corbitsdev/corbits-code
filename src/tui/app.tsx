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
import { useSpinner } from "./hooks/use-spinner.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useScroll } from "./hooks/use-scroll.js";
import { useDiff } from "./hooks/use-diff.js";
import { useKeymap } from "./hooks/use-keymap.js";
import { useMCPStatus } from "./hooks/use-mcp-status.js";
import { McpAuthPrompt } from "./components/mcp-auth-prompt.js";
import { writeClipboard } from "./util/clipboard.js";
import { useProviderManager } from "./hooks/use-provider-manager.js";
import { useLayoutGeometry } from "./hooks/use-layout-geometry.js";
import type { CommandResult } from "./commands/registry.js";
import type { LifecycleHookStatus } from "../session/hooks.js";
import "./commands/built-in.js";

// How long the run can be continuously awaiting a response with no new content
// before the watchdog fires and aborts the in-flight request.
export const STALL_TIMEOUT_MS = 120_000;

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
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [contextView, setContextView] = useState<ContextView>("plan");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [diffScroll, setDiffScroll] = useState(0);
  const [planScroll, setPlanScroll] = useState(0);
  const [diffFullScreenOpen, setDiffFullScreenOpen] = useState(false);
  const [planFullScreenOpen, setPlanFullScreenOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionEntries, setPermissionEntries] = useState<ScopedApproval[]>([]);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
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
  });
  const { provider, model, reasoningEffort, providerCatalog, applySelection, persistSelection, upsertProvider, deleteProvider } = providerManager;

  const gates = useGates({ eventEmitter, setGatePending: state.setGatePending });

  const planSteps = useMemo(() => {
    const block = state.contentBlocks.find((b) => b.type === "plan");
    return block?.type === "plan" ? block.steps : [];
  }, [state.contentBlocks]);

  // McpAuthPrompt and commandMessage render outside the overlay region, so
  // their rows must be subtracted explicitly to prevent the log from overpainting.
  const extraChromeRows =
    (mcpStatus.needsAuth.length > 0 ? 1 : 0) +
    (commandMessage !== null ? 1 : 0);

  const layout = useLayoutGeometry({
    columns,
    rows,
    sidebarOpen,
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
    permissionsOpen
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
    signalClear: () => startNewSessionRef.current(),
    getMCPServers: () => mcpStatus.servers,
  }), [verbose, mcpStatus.servers]);

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
    if (state.isProcessing) {
      // Agent is mid-response — queue for delivery at the next connector.reply.
      pendingQueueRef.current.push(message);
      setQueuedCount((c) => c + 1);
      return;
    }
    sendMessage(message);
  };

  // Spin only while the model is working with nothing streaming yet; the moment
  // a token lands, awaitingResponse flips false and the indicator clears.
  const awaitingResponse = state.status === "running" && state.awaitingResponse;
  const spinner = useSpinner(awaitingResponse, sendCounterRef.current);

  useKeymap(
    {
      exitConfirmOpen,
      // The permissions overlay owns input through its own useInput, exactly
      // like the help overlay, so block the global keymap the same way.
      helpOpen: helpOpen || permissionsOpen,
      gateOpen: gates.gateOpen,
      agentModalOpen,
      hookPanelOpen,
      diffFullScreenOpen,
      planFullScreenOpen,
      hasInput: inputValue.length > 0,
      inputFocused: inputActive,
      commandPaletteOpen: inputValue.startsWith("/") && !inputValue.includes(" "),
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
        setPlanFullScreenOpen((open) => !open);
        if (planFullScreenOpen) {
          setPlanScroll(0);
        }
      },
      toggleDiffFullScreen: () => {
        setDiffFullScreenOpen((open) => !open);
        if (diffFullScreenOpen) {
          setDiffScroll(0);
        }
      },
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
        setPermissionsOpen(true);
      } else {
        setHelpOpen(true);
      }
      return;
    }
    if (result.type === "modal" && result.modal === "agent") {
      setAgentModalOpen(true);
    }
  };

  const refreshPermissions = () => {
    if (permissionsAdmin === undefined) return;
    void permissionsAdmin.list().then(setPermissionEntries);
  };

  useEffect(() => {
    if (!permissionsOpen) return;
    refreshPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsOpen]);

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
        />
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
        {planFullScreenOpen ? (
          <PlanView
            steps={planSteps}
            currentPlanStep={state.currentPlanStep}
            planDeviated={state.planDeviated}
            width={columns}
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
            {sidebarOpen && (
              <Box width={rightWidth} flexDirection="column" overflow="hidden">
                <ContextPanel
                  view={contextView}
                  steps={planSteps}
                  currentPlanStep={state.currentPlanStep}
                  planDeviated={state.planDeviated}
                  width={rightWidth}
                  diffResult={diff.result}
                  diffScrollOffset={diffScroll}
                  diffVisibleRows={diffVisibleRows}
                />
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
      {mcpStatus.needsAuth.length > 0 && <McpAuthPrompt servers={mcpStatus.needsAuth} />}
      {commandMessage !== null && (
        <Box paddingX={1}>
          <Text color="cyan">{commandMessage}</Text>
        </Box>
      )}
      {!planFullScreenOpen && !diffFullScreenOpen && (
        <Box flexShrink={0} flexDirection="column">
          <InFlightIndicator
            active={awaitingResponse}
            frame={spinner.frame}
            elapsedMs={spinner.elapsedMs}
          />
          <Box
            borderStyle="single"
            borderColor={color("muted")}
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
          elapsedMs={state.elapsedMs}
          status={state.status}
          connectedMCPServers={mcpStatus.connected}
          reasoningEffort={reasoningEffort}
        />
        </Box>
      )}
    </Box>
  );
}
