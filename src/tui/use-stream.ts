import { useState, useEffect } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createFaremeter, formatCost } from "../faremeter.js";
import type { LifecycleHookEvent, LifecycleHookStatus } from "../hooks.js";

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

export type AgentStatus = "running" | "done" | "failed" | "blocked" | "stopping" | "stopped";

export type AgentStreamState = {
  contentBlocks: ContentBlock[];
  turnsUsed: number;
  status: AgentStatus;
  totalCost: number;
  totalTokens: number;
  formattedCost: string;
  latestUserMessage: string;
  hooks: LifecycleHookStatus[];
  currentPlanStep: number | null;
  planTotal: number;
  planDeviated: boolean;
  elapsedMs: number;
  awaitingResponse: boolean;
  addEvent(event: ReactorEmittedEvent): void;
  addHookEvent(event: LifecycleHookEvent): void;
  setGatePending(pending: boolean): void;
  requestStop(): void;
  markRunning(): void;
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

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

function nextFileStepIndex(steps: PlanStep[], from: number): number | null {
  for (let i = from; i < steps.length; i++) {
    if ((steps[i]?.file ?? "").length > 0) return i;
  }
  return null;
}

function parsePathArgument(rawArguments: string): string | null {
  if (rawArguments.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const path = (parsed as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function createAgentStreamState(initialHooks: LifecycleHookStatus[] = []): AgentStreamState {
  const contentBlocks: ContentBlock[] = [];
  const callIdToName = new Map<string, string>();
  const callIdToArguments = new Map<string, string>();
  const hooksById = new Map<string, LifecycleHookStatus>();
  let turnsUsed = 0;
  let status: AgentStatus = "running";
  let stopRequested = false;
  // True while the model is working but nothing is streaming yet — the gap
  // between a send (or a tool result) and the first token of the next reply.
  // Drives the in-flight indicator; cleared the moment real content arrives.
  let awaitingResponse = false;
  let latestUserMessage = "";
  let planSteps: PlanStep[] = [];
  let currentPlanStep: number | null = null;
  let planDeviated = false;
  const startedAt = Date.now();
  let finishedAt: number | null = null;
  let openCallId: string | null = null;
  const faremeter = createFaremeter();
  for (const hook of initialHooks) {
    hooksById.set(hook.id, { ...hook });
  }

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
    get hooks() {
      return [...hooksById.values()].map((hook) => ({ ...hook }));
    },
    get currentPlanStep() {
      return currentPlanStep;
    },
    get planTotal() {
      return planSteps.length;
    },
    get planDeviated() {
      return planDeviated;
    },
    get elapsedMs() {
      return (finishedAt ?? Date.now()) - startedAt;
    },
    get awaitingResponse() {
      return awaitingResponse;
    },
    setGatePending(pending: boolean): void {
      if (status === "done" || status === "failed" || status === "stopping" || status === "stopped") return;
      status = pending ? "blocked" : "running";
    },
    requestStop(): void {
      // Only an in-flight run can be stopped. Once stopping, the reactor's
      // current cycle finishes and reactor.done settles the status to "stopped".
      if (status !== "running" && status !== "blocked") return;
      stopRequested = true;
      status = "stopping";
    },
    markRunning(): void {
      // A fresh send revives the loop after it settled (done/stopped/failed).
      stopRequested = false;
      status = "running";
      finishedAt = null;
      awaitingResponse = true;
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
          awaitingResponse = false;
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
          awaitingResponse = false;
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
          awaitingResponse = false;
          const data = event.data as { name: string; callId: string };
          callIdToName.set(data.callId, data.name);
          callIdToArguments.set(data.callId, "");
          openCallId = data.callId;
          contentBlocks.push({ type: "tool_call", name: data.name, arguments: "" });
          break;
        }
        case "inference.tool_call.delta": {
          const fragment = (event.data as { argumentFragment: string }).argumentFragment;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "tool_call") {
            last.arguments += fragment;
          }
          if (openCallId !== null) {
            callIdToArguments.set(openCallId, (callIdToArguments.get(openCallId) ?? "") + fragment);
          }
          break;
        }
        case "connector.reply": {
          // reply content is already accumulated via inference.text.delta
          break;
        }
        case "tool.done": {
          // A tool finished; the model is now deciding its next move with nothing
          // streaming, so re-arm the indicator until the next token arrives.
          awaitingResponse = true;
          const result = (event.data as { result: { callId: string; content: unknown; isError: boolean } }).result;
          const trackedName = callIdToName.get(result.callId);
          const name = trackedName ?? result.callId;
          const content = stringifyToolContent(result.content);

          if (name === "submit_plan" && !result.isError) {
            let planCallIndex = -1;
            for (let i = contentBlocks.length - 1; i >= 0; i--) {
              const b = contentBlocks[i];
              if (b?.type === "tool_call" && b.name === "submit_plan") {
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
            planSteps = steps;
            planDeviated = false;
            currentPlanStep = steps.length > 0 ? 0 : null;
            break;
          }

          if (WRITE_TOOLS.has(name) && !result.isError && currentPlanStep !== null) {
            const path = parsePathArgument(callIdToArguments.get(result.callId) ?? "");
            if (path !== null) {
              // Skip fileless steps (e.g. "investigate the bug") — they carry no
              // path to match against, so a write during them is not a deviation.
              const targetIdx = nextFileStepIndex(planSteps, currentPlanStep);
              if (targetIdx !== null) {
                if (path === planSteps[targetIdx]?.file) {
                  currentPlanStep = targetIdx + 1 < planSteps.length ? targetIdx + 1 : null;
                  planDeviated = false;
                } else {
                  planDeviated = true;
                }
              }
            }
          }

          contentBlocks.push({ type: "tool_result", callId: result.callId, name, content, isError: result.isError });
          break;
        }
        case "reactor.error": {
          const data = event.data as { fatal: boolean; error: string };
          contentBlocks.push({ type: "error", message: data.error });
          break;
        }
        case "inference.error": {
          const err = (event.data as { error: { category: string; message: string } }).error;
          const friendly: Record<string, string> = {
            credential_failure: "Authentication failed — check your API key.",
            quota_exhausted: "Quota exhausted — usage limit reached.",
            context_overflow: "Context window full — start a new session.",
            retryable: "Request failed — will retry.",
            fatal: "Fatal inference error.",
            aborted: "Request aborted.",
            timeout: "Request timed out.",
            protocol_mismatch: "Unexpected response from inference API.",
          };
          const msg = friendly[err.category] ?? err.message;
          contentBlocks.push({ type: "error", message: msg });
          break;
        }
        default:
          break;
      }

      if (event.type === "inference.done") {
        turnsUsed++;
        awaitingResponse = false;
      }

      if (event.type === "inference.usage") {
        const data = event.data as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number } };
        faremeter.addUsage(data.usage);
      }

      if (event.type === "reactor.done") {
        status = stopRequested ? "stopped" : "done";
        finishedAt = Date.now();
        awaitingResponse = false;
      }

      if (event.type === "reactor.error" || event.type === "inference.error") {
        status = "failed";
        finishedAt = Date.now();
        awaitingResponse = false;
      }
    },
    addHookEvent(event: LifecycleHookEvent): void {
      switch (event.type) {
        case "hooks.loaded": {
          hooksById.clear();
          for (const hook of event.hooks) {
            hooksById.set(hook.id, { ...hook });
          }
          break;
        }
        case "hook.updated": {
          hooksById.set(event.hook.id, { ...event.hook });
          break;
        }
      }
    },
  };
}

export function useAgentStream(
  emitter: EventEmitter,
  initialHooks: LifecycleHookStatus[] = [],
): AgentStreamState {
  const [state] = useState(() => createAgentStreamState(initialHooks));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handler = (event: ReactorEmittedEvent) => {
      state.addEvent(event);
      setTick((t) => t + 1);
    };
    const hookHandler = (event: LifecycleHookEvent) => {
      state.addHookEvent(event);
      setTick((t) => t + 1);
    };
    emitter.on("event", handler);
    emitter.on("hook", hookHandler);
    return () => {
      emitter.off("event", handler);
      emitter.off("hook", hookHandler);
    };
  }, [emitter, state]);

  useEffect(() => {
    if (state.status !== "running" && state.status !== "blocked") return;
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [state, state.status]);

  // Force re-render by reading tick
  void tick;

  return state;
}
