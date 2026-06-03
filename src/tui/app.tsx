import { Box, Text, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useMemo, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";
import { ContextPanel, type ContextView } from "./components/context-panel.js";
import { ApprovalModal } from "./components/approval-modal.js";
import { OperatorModal } from "./components/operator-modal.js";
import { HookPanel } from "./components/hook-panel.js";
import { ExitConfirm } from "./components/exit-confirm.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useScroll } from "./hooks/use-scroll.js";
import { useDiff } from "./hooks/use-diff.js";
import { useKeymap } from "./hooks/use-keymap.js";
import type { Mode } from "../config.js";
import type { CommandResult } from "./commands/registry.js";
import type { LifecycleHookStatus } from "../hooks.js";
import "./commands/built-in.js";

export type AppProps = {
  eventEmitter: EventEmitter;
  agent: Agent;
  sessionTitle: string;
  initialMode: Mode;
  initialModel: string;
  initialHooks?: LifecycleHookStatus[];
  onModeChange: (mode: Mode) => void;
  onToggleHook?: (hookId: string, enabled: boolean) => void;
  onAgentError?: (err: unknown) => void;
};

export function App({
  eventEmitter,
  agent,
  sessionTitle,
  initialMode,
  initialModel,
  initialHooks = [],
  onModeChange,
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
  const [diffScroll, setDiffScroll] = useState(0);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [model, setModel] = useState<string>(initialModel);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);

  const gates = useGates({ eventEmitter, mode, setGatePending: state.setGatePending });

  const commandContext = useMemo(() => ({
    getModel: () => model,
    setModel,
    getVerbose: () => verbose,
    toggleVerbose: () => {
      const next = !verbose;
      setVerbose(next);
      return next;
    },
  }), [model, verbose]);

  const planSteps = useMemo(() => {
    const block = state.contentBlocks.find((b) => b.type === "plan");
    return block?.type === "plan" ? block.steps : [];
  }, [state.contentBlocks]);

  const leftWidth = Math.floor(columns * 0.65);
  const rightWidth = columns - leftWidth;

  // Reserve rows for the header, status bar, and chat input chrome so the
  // event log only ever paints into the space it actually owns.
  const CHROME_ROWS = 10;
  const visibleRows = Math.max(1, rows - CHROME_ROWS);

  const renderableCount = useMemo(
    () => state.contentBlocks.filter((b) => b.type !== "reply" && b.type !== "plan").length,
    [state.contentBlocks],
  );

  const lastToolIndex = useMemo(() => {
    const renderable = state.contentBlocks.filter((b) => b.type !== "reply" && b.type !== "plan");
    for (let i = renderable.length - 1; i >= 0; i--) {
      if (renderable[i]?.type === "tool_call") return i;
    }
    return null;
  }, [state.contentBlocks]);

  const scroll = useScroll({ renderableCount, visibleRows });

  const diffActive = contextView === "diff";
  const diff = useDiff({ cwd: process.cwd(), active: diffActive, refreshKey: renderableCount });
  const diffVisibleRows = Math.max(1, visibleRows - 2);
  const diffLineCount = useMemo(
    () => (diff.result?.available ? diff.result.files.reduce((n, f) => n + f.lines.length, 0) : 0),
    [diff.result],
  );
  const diffMaxOffset = Math.max(0, diffLineCount - diffVisibleRows);

  // Input is inert while any overlay, modal, or gate is capturing keys, so
  // keystrokes (and Enter) never leak into the prompt underneath.
  const inputActive = !(exitConfirmOpen || helpOpen || gates.gateOpen || hookPanelOpen);

  useKeymap(
    {
      exitConfirmOpen,
      helpOpen,
      gateOpen: gates.gateOpen,
      hookPanelOpen,
      hasInput: inputValue.length > 0,
    },
    {
      clearInput: () => setInputValue(""),
      requestExit: () => setExitConfirmOpen(true),
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
      toggleMode: () => {
        const next: Mode = mode === "manager" ? "teammate" : "manager";
        setMode(next);
        onModeChange(next);
      },
      toggleContextView: () => {
        setDiffScroll(0);
        setContextView((v) => (v === "plan" ? "diff" : "plan"));
      },
      toggleHelp: () => setHelpOpen((open) => !open),
    },
  );

  const handleSend = (message: string) => {
    setCommandMessage(null);
    agent.send(message).catch((err: unknown) => {
      onAgentError?.(err);
    });
  };

  const handleCommand = (result: CommandResult) => {
    if (result.type === "message") {
      setCommandMessage(result.text);
      return;
    }
    if (result.type === "view") {
      setDiffScroll(0);
      setContextView(result.view);
      return;
    }
    if (result.type === "overlay") {
      setHelpOpen(true);
    }
  };

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexShrink={0} flexDirection="column">
        <Header
          turnsUsed={state.turnsUsed}
          status={state.status}
          totalCost={state.formattedCost}
          sessionTitle={sessionTitle}
          latestUserMessage={state.latestUserMessage}
          mode={mode}
          width={columns}
        />
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
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
      </Box>
      {hookPanelOpen ? (
        <HookPanel hooks={state.hooks} />
      ) : null}
      {exitConfirmOpen && (
        <ExitConfirm onConfirm={() => exit()} onCancel={() => setExitConfirmOpen(false)} />
      )}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {gates.pendingPlan !== null && (
        <ApprovalModal plan={gates.pendingPlan} onApprove={gates.approve} onReject={gates.reject} />
      )}
      {gates.pendingOperator !== null && (
        <OperatorModal
          question={gates.pendingOperator.question}
          options={gates.pendingOperator.options}
          onSelect={gates.selectOperator}
        />
      )}
      {commandMessage !== null && (
        <Box paddingX={1}>
          <Text color="cyan">{commandMessage}</Text>
        </Box>
      )}
      <Box flexShrink={0} flexDirection="column">
        <ChatInput
          onSubmit={handleSend}
          onCommand={handleCommand}
          commandContext={commandContext}
          value={inputValue}
          onChange={setInputValue}
          active={inputActive}
        />
        <StatusBar
          model={model}
          mode={mode}
          planStep={state.currentPlanStep}
          planTotal={state.planTotal}
          planPending={gates.pendingPlan !== null}
          planDeviated={state.planDeviated}
          cost={state.formattedCost}
          tokens={state.totalTokens}
          elapsedMs={state.elapsedMs}
          status={state.status}
        />
      </Box>
    </Box>
  );
}
