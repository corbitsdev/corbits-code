import { useState, useEffect } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createFaremeter, formatCost } from "../faremeter.js";

export type AgentStreamState = {
  events: ReactorEmittedEvent[];
  turnsUsed: number;
  status: "running" | "done" | "failed";
  totalCost: number;
  totalTokens: number;
  formattedCost: string;
  addEvent(event: ReactorEmittedEvent): void;
};

export function createAgentStreamState(): AgentStreamState {
  const events: ReactorEmittedEvent[] = [];
  let turnsUsed = 0;
  let status: "running" | "done" | "failed" = "running";
  const faremeter = createFaremeter();

  return {
    get events() {
      return [...events];
    },
    get turnsUsed() {
      return turnsUsed;
    },
    get status() {
      return status;
    },
    get totalCost() {
      return faremeter.getTotalCost();
    },
    get totalTokens() {
      return faremeter.getTotalTokens();
    },
    get formattedCost() {
      return formatCost(faremeter.getTotalCost());
    },
    addEvent(event: ReactorEmittedEvent): void {
      events.push(event);

      if (event.type === "inference.done") {
        turnsUsed++;
      }

      if (event.type === "inference.usage") {
        const data = event.data as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number } };
        faremeter.addUsage(data.usage);
      }

      if (event.type === "reactor.done") {
        status = "done";
      }

      if (event.type === "reactor.error" || event.type === "inference.error") {
        status = "failed";
      }
    },
  };
}

export function useAgentStream(emitter: EventEmitter): AgentStreamState {
  const [state] = useState(() => createAgentStreamState());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handler = (event: ReactorEmittedEvent) => {
      state.addEvent(event);
      setTick((t) => t + 1);
    };
    emitter.on("event", handler);
    return () => {
      emitter.off("event", handler);
    };
  }, [emitter, state]);

  // Force re-render by reading tick
  void tick;

  return state;
}
