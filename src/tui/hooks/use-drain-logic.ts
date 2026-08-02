import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { EventEmitter } from "node:events";
import type { AgentStreamView } from "../use-stream.js";
import type { SubAgentSessionStore } from "../../subagent/index.js";
import type { Task } from "../../agent/tasks.js";
import type { OutboundUserMessage } from "../message-types.js";

export type UseDrainLogicArgs = {
  eventEmitter: EventEmitter;
  subAgentSessions: SubAgentSessionStore | undefined;
  setSessionsTick: Dispatch<SetStateAction<number>>;
  stateRef: { current: AgentStreamView };
  activeSubAgentsRef: { current: Task[] };
  sendMessageRef: { current: (message: OutboundUserMessage) => void };
  pendingQueueRef: { current: OutboundUserMessage[] };
  tryDrainQueuedMessageRef: { current: () => void };
};

export type DrainLogicController = {
  queuedCount: number;
  setQueuedCount: Dispatch<SetStateAction<number>>;
  hasRunningSubAgentSessions: () => boolean;
};

// Messages queued while the agent is processing. Drained one-at-a-time when
// isProcessing goes false (connector.reply fires). Lives in React state so
// the drain path goes through sendMessage(), which correctly sets isProcessing.
export function useDrainLogic({
  eventEmitter,
  subAgentSessions,
  setSessionsTick,
  stateRef,
  activeSubAgentsRef,
  sendMessageRef,
  pendingQueueRef,
  tryDrainQueuedMessageRef,
}: UseDrainLogicArgs): DrainLogicController {
  const [queuedCount, setQueuedCount] = useState(0);

  const hasRunningSubAgentSessions = (): boolean =>
    subAgentSessions?.list().some((session) => session.status === "running") ?? false;

  tryDrainQueuedMessageRef.current = () => {
    if (stateRef.current.status === "blocked") return;
    if (stateRef.current.isProcessing) return;
    if (activeSubAgentsRef.current.length > 0) return;
    if (hasRunningSubAgentSessions()) return;
    if (pendingQueueRef.current.length === 0) return;
    const next = pendingQueueRef.current.shift()!;
    setQueuedCount((c) => Math.max(0, c - 1));
    sendMessageRef.current(next);
  };

  useEffect(() => {
    if (subAgentSessions === undefined) return;
    return subAgentSessions.subscribe(() => {
      setSessionsTick((n) => n + 1);
      tryDrainQueuedMessageRef.current();
    });
  }, [subAgentSessions]);

  // Drain one queued message when the orchestrator is idle and no sub-agents run.
  useEffect(() => {
    const onEvent = (event: { type: string }) => {
      if (event.type !== "connector.reply") return;
      tryDrainQueuedMessageRef.current();
    };
    eventEmitter.on("event", onEvent);
    return () => { eventEmitter.off("event", onEvent); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { queuedCount, setQueuedCount, hasRunningSubAgentSessions };
}
