import { Box, Text, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";
import { ContextPanel, type ContextView } from "./components/context-panel.js";
import { DiffView } from "./components/diff-view.js";
import { PlanView } from "./components/plan-view.js";
import { ExitConfirm } from "./components/exit-confirm.js";
import { AgentModal, toAgentProviders, type ProviderFormSubmission } from "./components/agent-modal.js";
import { ModalStack } from "./components/modal-stack.js";
import { InFlightIndicator } from "./components/in-flight-indicator.js";
import type { ProviderCatalogEntry } from "../config.js";
import { useSpinner } from "./hooks/use-spinner.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useScroll } from "./hooks/use-scroll.js";
import { useDiff } from "./hooks/use-diff.js";
import { useKeymap } from "./hooks/use-keymap.js";
import { useProviderManager } from "./hooks/use-provider-manager.js";
import { useLayoutGeometry } from "./hooks/use-layout-geometry.js";
import type { CommandResult } from "./commands/registry.js";
import type { LifecycleHookStatus } from "../hooks.js";
import "./commands/built-in.js";

export type AppProps = {
  eventEmitter: EventEmitter;
  agent: Agent;
  sessionTitle: string;
  initialModel: string;
  initialProvider: string;
  providers: ProviderCatalogEntry[];
  globalSettingsPath: string;
  globalDefaultProvider?: string;
  cwd: string;
  initialTask?: string;
  initialHooks?: LifecycleHookStatus[];
  onToggleHook?: (hookId: string, enabled: boolean) => void;
  onAgentError?: (err: unknown) => void;
};

export function App({
  eventEmitter,
  agent,
  sessionTitle,
  initialModel,
  initialProvider,
  providers,
  globalSettingsPath,
  globalDefaultProvider: initialGlobalDefaultProvider,
  cwd,
  initialTask = "",
  initialHooks = [],
  onToggleHook,
  onAgentError,
}: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter, initialHooks);
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [inputValue, setInputValue] = useState("");
  const [hookPanelOpen, setHookPanelOpen] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<number>>(() => new Set());
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
  const [commandMessage, setCommandMessage] = useState<string | null>(null);

  const providerManager = useProviderManager({
    initialProvider,
    initialModel,
    initialCatalog: providers,
    initialGlobalDefaultProvider,
    cwd,
    globalSettingsPath,
    agent,
    onMessage: setCommandMessage,
  });
  const { provider, model, providerCatalog, applySelection, persistSelection, upsertProvider, deleteProvider } = providerManager;

  const gates = useGates({ eventEmitter, setGatePending: state.setGatePending });

  const commandContext = useMemo(() => ({
    getVerbose: () => verbose,
    toggleVerbose: () => {
      const next = !verbose;
      setVerbose(next);
      return next;
    },
  }), [verbose]);

  const planSteps = useMemo(() => {
    const block = state.contentBlocks.find((b) => b.type === "plan");
    return block?.type === "plan" ? block.steps : [];
  }, [state.contentBlocks]);

  const layout = useLayoutGeometry({
    columns,
    rows,
    sidebarOpen,
    gateContext: {
      pendingPermission: gates.pendingPermission,
      pendingPlan: gates.pendingPlan,
      pendingOperator: gates.pendingOperator,
    },
    modalContext: { helpOpen, hookPanelOpen, exitConfirmOpen, agentModalOpen },
    hookCount: state.hooks.length,
    providerCatalog,
  });
  const { leftWidth, rightWidth, visibleRows, diffVisibleRows, effectiveOverlayRows } = layout;

  const renderableCount = useMemo(
    () => state.contentBlocks.filter((b) =>
      b.type !== "reply" &&
      b.type !== "plan" &&
      (thinkingExpanded || b.type !== "thinking")
    ).length,
    [state.contentBlocks, thinkingExpanded],
  );

  const lastToolIndex = useMemo(() => {
    const renderable = state.contentBlocks.filter((b) => b.type !== "reply" && b.type !== "plan");
    for (let i = renderable.length - 1; i >= 0; i--) {
      if (renderable[i]?.type === "tool_call") return i;
    }
    return null;
  }, [state.contentBlocks]);

  const scroll = useScroll({ renderableCount, visibleRows });

  const latestUserMessageInLog = state.contentBlocks.some((block) =>
    block.type === "user" && block.content === state.latestUserMessage
  );
  const headerLatestUserMessage = latestUserMessageInLog ? "" : state.latestUserMessage;

  const diffActive = (sidebarOpen && contextView === "diff") || diffFullScreenOpen;
  const diff = useDiff({ cwd: process.cwd(), active: diffActive, refreshKey: renderableCount });
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
    agentModalOpen
  );

  // One controller per in-flight send so Ctrl+C / double-Esc can abort the
  // active run. Aborting rejects the send promise; the reactor's current cycle
  // finishes but no new cycle starts, which is the "Stopping" → "Stopped" path.
  const sendAbortRef = useRef<AbortController | null>(null);
  const [, forceRender] = useState(0);
  const didSendInitial = useRef(false);

  const sendMessage = (message: string) => {
    state.markRunning();
    const controller = new AbortController();
    sendAbortRef.current = controller;
    agent.send(message, { signal: controller.signal }).catch((err: unknown) => {
      // A user-initiated stop aborts the send; that is expected, not an error.
      if (controller.signal.aborted) return;
      onAgentError?.(err);
    });
  };

  const requestStop = () => {
    sendAbortRef.current?.abort();
    state.requestStop();
    // requestStop mutates the stream state in place, so nudge a re-render to
    // reflect the "Stopping" status immediately rather than on the next event.
    forceRender((n) => n + 1);
  };

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
    sendMessage(message);
  };

  // Spin only while the model is working with nothing streaming yet; the moment
  // a token lands, awaitingResponse flips false and the indicator clears.
  const awaitingResponse = state.status === "running" && state.awaitingResponse;
  const spinner = useSpinner(awaitingResponse);

  useKeymap(
    {
      exitConfirmOpen,
      helpOpen,
      gateOpen: gates.gateOpen,
      agentModalOpen,
      hookPanelOpen,
      diffFullScreenOpen,
      planFullScreenOpen,
      hasInput: inputValue.length > 0,
      inputFocused: inputActive,
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
      toggleThinking: () => setThinkingExpanded((e) => !e),
      toggleLastTool: () => {
        if (lastToolIndex !== null) {
          const idx = lastToolIndex;
          setExpandedTools((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
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
    },
  );

  const handleCommand = (result: CommandResult) => {
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
      setHelpOpen(true);
      return;
    }
    if (result.type === "modal" && result.modal === "agent") {
      setAgentModalOpen(true);
    }
  };

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexShrink={0} flexDirection="column">
        <Header
          sessionTitle={sessionTitle}
          latestUserMessage={headerLatestUserMessage}
          width={columns}
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
      />
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
            />
          )}
        <StatusBar
          provider={provider}
          model={model}
          turnsUsed={state.turnsUsed}
          planStep={state.currentPlanStep}
          planTotal={state.planTotal}
          planPending={gates.pendingPlan !== null}
          planDeviated={state.planDeviated}
          cost={state.formattedCost}
          tokens={state.totalTokens}
          elapsedMs={state.elapsedMs}
          status={state.status}
          currentToolName={state.currentToolName}
          streamingType={state.streamingType}
          awaitingResponse={state.awaitingResponse}
        />
        </Box>
      )}
    </Box>
  );
}
