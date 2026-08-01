import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { EventEmitter } from "node:events";
import type { AgentStreamView } from "../use-stream.js";
import type { SubAgentSession, SubAgentSessionStore } from "../../subagent/index.js";
import type { Task } from "../../agent/tasks.js";
import type { OutboundUserMessage } from "../message-types.js";
import {
  activeStripSessions,
  agentsStripRowCount,
  computeAgentsStripWindow,
  DEFAULT_STRIP_MAX_VISIBLE,
  mergeInFlightSubAgents,
  shouldShowAgentsStrip,
  type AgentsStripWindow,
} from "../components/agents-strip.js";
import { useDrainLogic } from "./use-drain-logic.js";

export type UseAgentsStripArgs = {
  eventEmitter: EventEmitter;
  subAgentSessions: SubAgentSessionStore | undefined;
  sessionsTick: number;
  setSessionsTick: Dispatch<SetStateAction<number>>;
  state: AgentStreamView;
  stateRef: { current: AgentStreamView };
  sendMessageRef: { current: (message: OutboundUserMessage) => void };
  pendingQueueRef: { current: OutboundUserMessage[] };
  tryDrainQueuedMessageRef: { current: () => void };
  agentsNavOpen: boolean;
  agentsNavIndex: number;
  enteredSessionId: string | null;
};

export type AgentsStripState = {
  agentSessions: readonly SubAgentSession[];
  browseSessions: readonly SubAgentSession[];
  agentsNavList: readonly SubAgentSession[];
  agentsNavIndexClamped: number;
  enteredSession: SubAgentSession | undefined;
  activeSubAgents: Task[];
  activeSubAgentsRef: { current: Task[] };
  queuedCount: number;
  setQueuedCount: Dispatch<SetStateAction<number>>;
  hasRunningSubAgentSessions: () => boolean;
  steerOnEnter: boolean;
  agentsStripVisible: boolean;
  agentsStripScrollWindow: AgentsStripWindow | undefined;
  agentsStripRows: number;
};

/** Derives the Agents strip's session lists, nav windowing, and chrome row
 * count from the sub-agent session store and live stream state. */
export function useAgentsStrip({
  eventEmitter,
  subAgentSessions,
  sessionsTick,
  setSessionsTick,
  state,
  stateRef,
  sendMessageRef,
  pendingQueueRef,
  tryDrainQueuedMessageRef,
  agentsNavOpen,
  agentsNavIndex,
  enteredSessionId,
}: UseAgentsStripArgs): AgentsStripState {
  // The strip reflects only active work: an agent leaves the visible list the
  // moment it reaches a terminal state. Completed sessions stay in the store
  // for later inspection but no longer occupy the strip.
  const agentSessions = useMemo(() => {
    void sessionsTick;
    const merged = mergeInFlightSubAgents(
      subAgentSessions?.listForStrip() ?? [],
      state.subAgents,
    );
    return activeStripSessions(merged);
  }, [subAgentSessions, sessionsTick, state.subAgents]);

  // Ctrl+E browses the full strip surface (running + recent completed). The
  // chrome strip filters to running only; nav must still reach finished sessions
  // for inspection — otherwise a just-finished child vanishes from Ctrl+E while
  // the live-progress fallback can still paint a ghost "doing" row.
  const browseSessions = useMemo(() => {
    void sessionsTick;
    return subAgentSessions?.listForStrip() ?? [];
  }, [subAgentSessions, sessionsTick]);

  // A running agent can reach a terminal state while agents-nav is open, which
  // shortens the strip list under the persisted selection index. Clamp at read
  // time so the highlight lands on a real row instead of drifting out of range.
  const agentsNavList = agentsNavOpen ? browseSessions : agentSessions;
  const agentsNavIndexClamped =
    agentsNavList.length === 0 ? 0 : Math.min(agentsNavIndex, agentsNavList.length - 1);

  const enteredSession = useMemo(() => {
    void sessionsTick;
    if (enteredSessionId === null || subAgentSessions === undefined) return undefined;
    return subAgentSessions.get(enteredSessionId);
  }, [enteredSessionId, subAgentSessions, sessionsTick]);

  // Agents strip (session store) + live progress fallback for chrome height.
  // Prefer the session store list once anything has been spawned this session.
  const activeSubAgents = useMemo(
    () => state.subAgents.filter((a) => a.status !== "done" && a.status !== "cancelled"),
    [state.subAgents],
  );
  const activeSubAgentsRef = useRef(activeSubAgents);
  activeSubAgentsRef.current = activeSubAgents;
  const { queuedCount, setQueuedCount, hasRunningSubAgentSessions } = useDrainLogic({
    eventEmitter,
    subAgentSessions,
    setSessionsTick,
    stateRef,
    activeSubAgentsRef,
    sendMessageRef,
    pendingQueueRef,
    tryDrainQueuedMessageRef,
  });
  const steerOnEnter =
    state.isProcessing && activeSubAgents.length === 0 && !hasRunningSubAgentSessions();
  // The strip caps rendered rows so retained history never crowds out the
  // transcript; +1 accounts for the surrounding marginTop wrapper. When nav is
  // open the list may include completed sessions, so size against browseSessions.
  const agentsStripVisible = shouldShowAgentsStrip({
    chromeSessions: agentSessions,
    browseSessions,
    agentsNavOpen,
  });
  const agentsStripScrollWindow =
    agentsNavOpen && browseSessions.length > DEFAULT_STRIP_MAX_VISIBLE
      ? computeAgentsStripWindow(
          browseSessions.length,
          agentsNavIndexClamped,
          DEFAULT_STRIP_MAX_VISIBLE,
        )
      : undefined;
  const agentsStripRows = agentsStripVisible
    ? agentsNavOpen && browseSessions.length > 0
      ? agentsStripRowCount(
          browseSessions.length,
          DEFAULT_STRIP_MAX_VISIBLE,
          agentsStripScrollWindow,
        ) + 1
      : agentsStripRowCount(agentSessions.length, DEFAULT_STRIP_MAX_VISIBLE) + 1
    : 0;

  return {
    agentSessions,
    browseSessions,
    agentsNavList,
    agentsNavIndexClamped,
    enteredSession,
    activeSubAgents,
    activeSubAgentsRef,
    queuedCount,
    setQueuedCount,
    hasRunningSubAgentSessions,
    steerOnEnter,
    agentsStripVisible,
    agentsStripScrollWindow,
    agentsStripRows,
  };
}
