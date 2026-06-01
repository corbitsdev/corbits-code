import { Box, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import type { Agent } from "@intx/agent";
import { useState, useEffect, useRef, type ReactNode } from "react";
import { useAgentStream } from "./use-stream.js";
import { Header } from "./components/header.js";
import { EventLog } from "./components/event-log.js";
import { StatusBar } from "./components/status-bar.js";
import { ChatInput } from "./components/chat-input.js";
import { ApprovalModal } from "./components/approval-modal.js";
import type { Mode } from "../config.js";
import type { PlanStep } from "./use-stream.js";

export type PlanGateEvent = {
  plan: PlanStep[];
  resolve: (approved: boolean) => void;
};

export type AppProps = {
  eventEmitter: EventEmitter;
  agent: Agent;
  sessionTitle: string;
  initialMode: Mode;
  onModeChange: (mode: Mode) => void;
};

export function App({ eventEmitter, agent, sessionTitle, initialMode, onModeChange }: AppProps): ReactNode {
  const state = useAgentStream(eventEmitter);
  const { exit } = useApp();
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const pendingResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;

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

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.ctrl && input === "o") {
      setPlanCollapsed((c) => !c);
      return;
    }
    if (key.escape && pendingPlan === null) {
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
    agent.send(message).catch(() => {});
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
      {pendingPlan !== null && (
        <ApprovalModal plan={pendingPlan} onApprove={handleApprove} onReject={handleReject} />
      )}
      <ChatInput onSubmit={handleSend} />
      <StatusBar />
    </Box>
  );
}
