import { Box, Text, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";
import { ApprovalModal } from "./components/approval-modal.js";
import { OperatorModal } from "./components/operator-modal.js";
import { HookPanel } from "./components/hook-panel.js";
import type { Mode } from "../config.js";
import type { PlanStep } from "./use-stream.js";
import type { CommandResult } from "./commands/registry.js";
import type { LifecycleHookStatus } from "../hooks.js";
import "./commands/built-in.js";

export type PlanGateEvent = {
  plan: PlanStep[];
  resolve: (approved: boolean) => void;
};

export type OperatorGateEvent = {
  question: string;
  options: string[];
  resolve: (index: number) => void;
};

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
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const [hookPanelOpen, setHookPanelOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [model, setModel] = useState<string>(initialModel);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const pendingResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const [pendingOperator, setPendingOperator] = useState<{ question: string; options: string[] } | null>(null);
  const pendingOperatorResolveRef = useRef<((index: number) => void) | null>(null);
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;

  const commandContext = useMemo(() => ({
    getModel: () => model,
    setModel,
  }), [model]);

  useEffect(() => {
    const handler = ({ plan, resolve }: PlanGateEvent) => {
      if (modeRef.current === "teammate") {
        resolve(true);
        return;
      }
      pendingResolveRef.current = resolve;
      setPendingPlan(plan);
    };
    eventEmitter.on("plan.gate", handler);
    return () => {
      eventEmitter.off("plan.gate", handler);
    };
  }, [eventEmitter]);

  useEffect(() => {
    const handler = ({ question, options, resolve }: OperatorGateEvent) => {
      pendingOperatorResolveRef.current = resolve;
      setPendingOperator({ question, options });
    };
    eventEmitter.on("operator.gate", handler);
    return () => {
      eventEmitter.off("operator.gate", handler);
    };
  }, [eventEmitter]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (pendingPlan === null && pendingOperator === null) {
        exit();
      }
      return;
    }
    if (key.ctrl && input === "o") {
      setPlanCollapsed((c) => !c);
      return;
    }
    if (key.ctrl && input === "h") {
      setHookPanelOpen((open) => !open);
      return;
    }
    if (hookPanelOpen && /^[1-9]$/.test(input)) {
      const hook = state.hooks[Number(input) - 1];
      if (hook !== undefined) {
        onToggleHook?.(hook.id, !hook.enabled);
      }
      return;
    }
    if (key.escape && pendingPlan === null && pendingOperator === null) {
      exit();
      return;
    }
    if (key.tab && key.shift) {
      const next: Mode = mode === "manager" ? "teammate" : "manager";
      setMode(next);
      onModeChange(next);
    }
  });

  const handleSend = (message: string) => {
    setCommandMessage(null);
    agent.send(message).catch((err: unknown) => {
      onAgentError?.(err);
    });
  };

  const handleCommand = (result: CommandResult) => {
    if (result.type === "message") {
      setCommandMessage(result.text);
    }
  };

  const handleApprove = () => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    setPendingPlan(null);
    resolve?.(true);
  };

  const handleReject = () => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    setPendingPlan(null);
    resolve?.(false);
  };

  const handleOperatorSelect = (index: number) => {
    const resolve = pendingOperatorResolveRef.current;
    pendingOperatorResolveRef.current = null;
    setPendingOperator(null);
    resolve?.(index);
  };

  return (
    <Box flexDirection="column" height="100%">
      <Header
        turnsUsed={state.turnsUsed}
        status={state.status}
        totalCost={state.formattedCost}
        sessionTitle={sessionTitle}
        latestUserMessage={state.latestUserMessage}
        mode={mode}
      />
      <Box flexGrow={1} flexDirection="column">
        <EventLog contentBlocks={state.contentBlocks} planCollapsed={planCollapsed} />
      </Box>
      {hookPanelOpen ? (
        <HookPanel hooks={state.hooks} />
      ) : null}
      {pendingPlan !== null && (
        <ApprovalModal plan={pendingPlan} onApprove={handleApprove} onReject={handleReject} />
      )}
      {pendingOperator !== null && (
        <OperatorModal
          question={pendingOperator.question}
          options={pendingOperator.options}
          onSelect={handleOperatorSelect}
        />
      )}
      {commandMessage !== null && (
        <Box paddingX={1}>
          <Text color="cyan">{commandMessage}</Text>
        </Box>
      )}
      <ChatInput onSubmit={handleSend} onCommand={handleCommand} commandContext={commandContext} />
      <StatusBar />
    </Box>
  );
}
