import { useState, useEffect } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createFaremeter, formatCost } from "../faremeter.js";

export type PlanStep = { file: string; action: string };

export type ContentBlock =
  | { type: "user"; content: string }
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { type: "reply"; content: string }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "error"; message: string };

export type AgentStreamState = {
  contentBlocks: ContentBlock[];
  turnsUsed: number;
  status: "running" | "done" | "failed";
  totalCost: number;
  totalTokens: number;
  formattedCost: string;
  latestUserMessage: string;
  addEvent(event: ReactorEmittedEvent): void;
  addUserMessage(message: string): void;
};

function parsePlanSteps(rawArguments: string): PlanStep[] {
  if (rawArguments.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const out: PlanStep[] = [];
  for (const raw of steps) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const file = typeof s.file === "string" ? s.file : "";
    const action = typeof s.action === "string" ? s.action : "";
    if (file.length === 0 && action.length === 0) continue;
    out.push({ file, action });
  }
  return out;
}

export function createAgentStreamState(): AgentStreamState {
  const contentBlocks: ContentBlock[] = [];
  const callIdToName = new Map<string, string>();
  let turnsUsed = 0;
  let status: "running" | "done" | "failed" = "running";
  let latestUserMessage = "";
  const faremeter = createFaremeter();

  return {
    get contentBlocks() {
      return [...contentBlocks];
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
    get latestUserMessage() {
      return latestUserMessage;
    },
    addEvent(event: ReactorEmittedEvent): void {
      switch (event.type) {
        case "message.received": {
          const data = event.data as { message: { content: string } };
          latestUserMessage = data.message.content;
          contentBlocks.push({ type: "user", content: data.message.content });
          break;
        }
        case "inference.thinking.delta": {
          const token = (event.data as { token: string }).token;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "thinking") {
            last.content += token;
          } else {
            contentBlocks.push({ type: "thinking", content: token });
          }
          break;
        }
        case "inference.text.delta": {
          const token = (event.data as { token: string }).token;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "text") {
            last.content += token;
          } else {
            contentBlocks.push({ type: "text", content: token });
          }
          break;
        }
        case "inference.tool_call.start": {
          const data = event.data as { name: string; callId: string };
          callIdToName.set(data.callId, data.name);
          contentBlocks.push({ type: "tool_call", name: data.name, arguments: "" });
          break;
        }
        case "inference.tool_call.delta": {
          const fragment = (event.data as { argumentFragment: string }).argumentFragment;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "tool_call") {
            last.arguments += fragment;
          }
          break;
        }
        case "connector.reply": {
          // reply content is already accumulated via inference.text.delta
          break;
        }
        case "tool.done": {
          const result = (event.data as { result: { callId: string; content: string; isError: boolean } }).result;
          const trackedName = callIdToName.get(result.callId);
          const callBlock = contentBlocks.findLast((b) => b.type === "tool_call" && b.name === result.callId) ?? contentBlocks.findLast((b) => b.type === "tool_call");
          const name = trackedName ?? (callBlock ? (callBlock as ContentBlock & { type: "tool_call" }).name : result.callId);

          if (name === "submit_plan" && !result.isError) {
            let planCallIndex = -1;
            for (let i = contentBlocks.length - 1; i >= 0; i--) {
              const b = contentBlocks[i];
              if (b.type === "tool_call" && b.name === "submit_plan") {
                planCallIndex = i;
                break;
              }
            }
            const planArgs = planCallIndex >= 0
              ? (contentBlocks[planCallIndex] as ContentBlock & { type: "tool_call" }).arguments
              : "";
            const steps = parsePlanSteps(planArgs);
            if (planCallIndex >= 0) {
              contentBlocks.splice(planCallIndex, 1);
            }
            const existingPlanIndex = contentBlocks.findIndex((b) => b.type === "plan");
            if (existingPlanIndex >= 0) {
              contentBlocks[existingPlanIndex] = { type: "plan", steps };
            } else {
              contentBlocks.unshift({ type: "plan", steps });
            }
            break;
          }

          contentBlocks.push({ type: "tool_result", callId: result.callId, name, content: result.content, isError: result.isError });
          break;
        }
        case "reactor.error": {
          const data = event.data as { fatal: boolean; error: string };
          contentBlocks.push({ type: "error", message: `${data.fatal ? "fatal" : "error"}: ${data.error}` });
          break;
        }
        case "inference.error": {
          const err = (event.data as { error: { category: string; message: string } }).error;
          contentBlocks.push({ type: "error", message: `${err.category}: ${err.message}` });
          break;
        }
        default:
          break;
      }

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
    addUserMessage(message: string): void {
      latestUserMessage = message;
      contentBlocks.push({ type: "user", content: message });
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
