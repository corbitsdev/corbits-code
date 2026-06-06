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
import { ApprovalModal } from "./components/approval-modal.js";
import { OperatorModal } from "./components/operator-modal.js";
import { PermissionModal } from "./components/permission-modal.js";
import { HookPanel } from "./components/hook-panel.js";
import { ExitConfirm } from "./components/exit-confirm.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { AgentModal, toAgentProviders, type ProviderFormSubmission } from "./components/agent-modal.js";
import { InFlightIndicator } from "./components/in-flight-indicator.js";
import { buildOpenAISource, providerCatalogToSettings, type ProviderCatalogEntry } from "../config.js";
import { localSettingsPath, saveGlobalSettings, saveLocalSettings } from "../settings.js";
import { useSpinner } from "./hooks/use-spinner.js";
import { color } from "./theme.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import { useGates } from "./hooks/use-gates.js";
import { useScroll } from "./hooks/use-scroll.js";
import { useDiff } from "./hooks/use-diff.js";
import { useKeymap } from "./hooks/use-keymap.js";
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
  const [diffFullScreenOpen, setDiffFullScreenOpen] = useState(false);
  const [model, setModel] = useState<string>(initialModel);
  const [provider, setProvider] = useState<string>(initialProvider);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>(providers);
  const [globalDefaultProvider, setGlobalDefaultProvider] = useState<string | undefined>(initialGlobalDefaultProvider);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);

  const applyCatalogSelection = (
    catalog: readonly ProviderCatalogEntry[],
    providerName: string,
    nextModel: string,
  ): boolean => {
    const entry = catalog.find((p) => p.name === providerName);
    if (entry === undefined) {
      setCommandMessage(`Provider "${providerName}" is no longer configured`);
      return false;
    }
    agent.setSource(buildOpenAISource({ id: entry.name, baseURL: entry.baseURL, apiKey: entry.apiKey, model: nextModel, displayName: entry.name }));
    setProvider(providerName);
    setModel(nextModel);
    return true;
  };

  // Apply a provider/model selection to the running session. setSource mutates
  // the agent's active source in place; the reactor reads it at the next
  // inference call, so the switch takes effect without recreating the agent.
  const applySelection = (providerName: string, nextModel: string): void => {
    if (applyCatalogSelection(providerCatalog, providerName, nextModel)) {
      setCommandMessage(`Now using ${providerName} · ${nextModel}`);
    }
  };

  const persistSelection = (providerName: string, nextModel: string): void => {
    applySelection(providerName, nextModel);
    // Selection-only, never credentials — safe to leave in the gitignored
    // per-repo file. Best-effort: a write failure must not crash the session.
    void saveLocalSettings(localSettingsPath(cwd), { provider: providerName, model: nextModel }).catch(
      (err: unknown) => {
        setCommandMessage(
          `Switched, but saving default failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const persistLocalSelection = (providerName: string, nextModel: string): void => {
    void saveLocalSettings(localSettingsPath(cwd), { provider: providerName, model: nextModel }).catch(
      (err: unknown) => {
        setCommandMessage(
          `Provider saved, but saving project selection failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  };

  const persistProviderCatalog = (
    catalog: ProviderCatalogEntry[],
    defaultProvider: string | undefined,
    successMessage: string,
  ): void => {
    let settings: ReturnType<typeof providerCatalogToSettings>;
    try {
      settings = providerCatalogToSettings(catalog, defaultProvider);
    } catch (err) {
      setCommandMessage(
        `Provider settings changed locally, but saving failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    setProviderCatalog(catalog);
    setGlobalDefaultProvider(defaultProvider);
    void saveGlobalSettings(globalSettingsPath, settings).then(
      () => setCommandMessage(successMessage),
      (err: unknown) => {
        setCommandMessage(
          `Provider settings changed locally, but saving failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };

  const defaultAfterProviderSave = (submission: ProviderFormSubmission, catalog: readonly ProviderCatalogEntry[]): string | undefined => {
    if (globalDefaultProvider === submission.originalName) return submission.name;
    if (globalDefaultProvider !== undefined && catalog.some((p) => p.name === globalDefaultProvider)) {
      return globalDefaultProvider;
    }
    return catalog.length === 1 ? catalog[0]?.name : submission.name;
  };

  const defaultAfterProviderDelete = (
    deletedProvider: string,
    fallbackProvider: string,
    catalog: readonly ProviderCatalogEntry[],
  ): string | undefined => {
    if (globalDefaultProvider === deletedProvider) return fallbackProvider;
    if (globalDefaultProvider !== undefined && catalog.some((p) => p.name === globalDefaultProvider)) {
      return globalDefaultProvider;
    }
    return catalog.length === 1 ? catalog[0]?.name : undefined;
  };

  const upsertProvider = (submission: ProviderFormSubmission): { ok: true } | { ok: false; error: string } => {
    const conflict = providerCatalog.find(
      (p) => p.name === submission.name && p.name !== submission.originalName,
    );
    if (conflict !== undefined) {
      setCommandMessage(`Provider "${submission.name}" already exists`);
      return { ok: false, error: `Provider "${submission.name}" already exists` };
    }
    const existing =
      submission.originalName !== undefined
        ? providerCatalog.find((p) => p.name === submission.originalName)
        : undefined;
    const apiKey = submission.apiKey ?? existing?.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      setCommandMessage("Provider API key is required");
      return { ok: false, error: "Provider API key is required" };
    }
    const entry: ProviderCatalogEntry = {
      name: submission.name,
      baseURL: submission.baseURL,
      apiKey,
      models: submission.models,
      ...(submission.defaultModel !== undefined ? { defaultModel: submission.defaultModel } : {}),
    };
    const catalog = providerCatalog
      .filter((p) => p.name !== submission.name && p.name !== submission.originalName)
      .concat(entry);
    const selectedModel = entry.defaultModel ?? entry.models[0];
    if (selectedModel === undefined) {
      setCommandMessage("Provider must include at least one model");
      return { ok: false, error: "Provider must include at least one model" };
    }
    const nextDefaultProvider = defaultAfterProviderSave(submission, catalog);
    applyCatalogSelection(catalog, entry.name, selectedModel);
    persistLocalSelection(entry.name, selectedModel);
    persistProviderCatalog(catalog, nextDefaultProvider, `Saved provider ${entry.name}`);
    return { ok: true };
  };

  const deleteProvider = (providerName: string): void => {
    if (providerCatalog.length <= 1) {
      setCommandMessage("Cannot remove the last provider");
      return;
    }
    const catalog = providerCatalog.filter((p) => p.name !== providerName);
    const fallback = catalog.find((p) => p.name === provider) ?? catalog[0];
    const fallbackModel = fallback?.defaultModel ?? fallback?.models[0];
    if (fallback === undefined || fallbackModel === undefined) {
      setCommandMessage("Cannot remove provider because no fallback provider is configured");
      return;
    }
    if (providerName === provider) {
      applyCatalogSelection(catalog, fallback.name, fallbackModel);
      persistLocalSelection(fallback.name, fallbackModel);
    }
    persistProviderCatalog(
      catalog,
      defaultAfterProviderDelete(providerName, fallback.name, catalog),
      `Removed provider ${providerName}`,
    );
  };

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

  // The context sidebar is collapsed by default; when closed the event log
  // reflows to the full width.
  const leftWidth = sidebarOpen ? Math.floor(columns * 0.65) : columns;
  const rightWidth = columns - leftWidth;

  // Reserve rows for the header, status bar, chat input, the separator line,
  // and the in-flight indicator row so the event log only paints into the
  // space it actually owns.
  const CHROME_ROWS = 12;

  // Overlays paint below the event log in the same fixed-height column, so the
  // log must give up rows for whichever one is open. Otherwise their combined
  // height exceeds the terminal and Ink's redraw desyncs — ghosting the overlay
  // onto itself (e.g. the permission choices collapsing onto one line). Over-
  // reserving only shrinks the log slightly while a modal has focus, which is
  // safe; under-reserving brings the ghosting back, so the estimates round up.
  const overlayRows = useMemo(() => {
    const innerWidth = Math.max(8, leftWidth - 8);
    if (gates.pendingPermission !== null) {
      const head = `${gates.pendingPermission.action}: ${gates.pendingPermission.subject}`;
      const subjectLines = Math.max(1, Math.ceil(head.length / innerWidth));
      const persistable = gates.pendingPermission.scopes.filter((s) => s.pattern !== null).length;
      const choices = 2 + persistable;
      // chrome (border+padding+margin, 6) + title + subject + choices + nav,
      // each block separated by a margin row.
      return 11 + subjectLines + choices;
    }
    if (gates.pendingPlan !== null) return 18;
    if (gates.pendingOperator !== null) return 10 + gates.pendingOperator.options.length;
    if (helpOpen) return 16;
    if (hookPanelOpen) return 4 + state.hooks.length;
    if (exitConfirmOpen) return 6;
    if (agentModalOpen) {
      // chrome (6) + title + section label + nav, plus the longer of the
      // provider list and the widest provider's model list (the two steps share
      // the same region, so reserve for whichever is taller).
      const widestModels = providerCatalog.reduce((n, p) => Math.max(n, p.models.length), 0);
      // +1 over the provider step: the model step renders an extra provider-name
      // header row above the list. Over-reserving is safe; under-reserving ghosts.
      return 16 + Math.max(providerCatalog.length, widestModels);
    }
    return 0;
  }, [
    gates.pendingPermission,
    gates.pendingPlan,
    gates.pendingOperator,
    helpOpen,
    hookPanelOpen,
    exitConfirmOpen,
    agentModalOpen,
    providerCatalog,
    leftWidth,
    state.hooks.length,
  ]);

  // When a modal closes, overlayRows drops to 0 in the same render the modal
  // unmounts. If the event log reclaimed those rows immediately it would expand
  // into the region the modal still physically occupies until Ink clears it on
  // the next frame — a one-frame overlap that ghosts the closing modal (most
  // visible right after a permission approval). Hold the previous non-zero
  // reservation for one extra render so the log only reclaims the rows once the
  // modal region has been cleared.
  const prevOverlayRowsRef = useRef(0);
  const [deferredOverlayRows, setDeferredOverlayRows] = useState(0);
  useEffect(() => {
    const prev = prevOverlayRowsRef.current;
    prevOverlayRowsRef.current = overlayRows;
    if (overlayRows === 0 && prev > 0) {
      // Reserve the closing modal's rows for this frame, then release them on
      // the next tick once Ink has cleared the modal region.
      setDeferredOverlayRows(prev);
      const handle = setTimeout(() => setDeferredOverlayRows(0), 0);
      return () => clearTimeout(handle);
    }
    setDeferredOverlayRows(0);
    return undefined;
  }, [overlayRows]);

  const effectiveOverlayRows = Math.max(overlayRows, deferredOverlayRows);
  const visibleRows = Math.max(1, rows - CHROME_ROWS - effectiveOverlayRows);

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
  const diffVisibleRows = Math.max(1, visibleRows - 2);
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
      openPlanSidebar: () => {
        setDiffFullScreenOpen(false);
        setDiffScroll(0);
        setContextView("plan");
        setSidebarOpen(true);
      },
      openDiffFullScreen: () => {
        setDiffScroll(0);
        setDiffFullScreenOpen(true);
      },
      closeDiffFullScreen: () => {
        setDiffFullScreenOpen(false);
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
        {diffFullScreenOpen ? (
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
      {hookPanelOpen ? (
        <HookPanel hooks={state.hooks} />
      ) : null}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {agentModalOpen && (
        <AgentModal
          providers={toAgentProviders(providerCatalog)}
          activeProvider={provider}
          activeModel={model}
          onApply={applySelection}
          onPersistDefault={persistSelection}
          onSaveProvider={upsertProvider}
          onDeleteProvider={deleteProvider}
          onClose={() => setAgentModalOpen(false)}
        />
      )}
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
      {gates.pendingPermission !== null && (
        <PermissionModal request={gates.pendingPermission} onResolve={gates.resolvePermission} />
      )}
      {commandMessage !== null && (
        <Box paddingX={1}>
          <Text color="cyan">{commandMessage}</Text>
        </Box>
      )}
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
    </Box>
  );
}
