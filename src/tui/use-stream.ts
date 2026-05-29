import { useState, useEffect } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createFaremeter, formatCost } from "../faremeter.js";
import type { PricingCache } from "../pricing-fetcher.js";

export type ContentBlock =
  | { type: "user"; content: string }
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { type: "reply"; content: string }
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

export function createAgentStreamState(modelId?: string, pricingCache?: PricingCache | null): AgentStreamState {
  const contentBlocks: ContentBlock[] = [];
  let turnsUsed = 0;
  let status: "running" | "done" | "failed" = "running";
  let latestUserMessage = "";
  const faremeter = createFaremeter(modelId === undefined ? {} : { modelId, pricingCache: pricingCache ?? null });

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
          const callBlock = contentBlocks.findLast((b) => b.type === "tool_call" && b.name === result.callId) ?? contentBlocks.findLast((b) => b.type === "tool_call");
          const name = callBlock ? (callBlock as ContentBlock & { type: "tool_call" }).name : result.callId;
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

export function useAgentStream(emitter: EventEmitter, modelId?: string, pricingCache?: PricingCache | null): AgentStreamState {
  const [state] = useState(() => createAgentStreamState(modelId, pricingCache));
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
