import { useState, useEffect, useRef } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { type } from "arktype";
import { createFaremeter, formatCost } from "../cost/faremeter.js";
import { lookupModelPricing } from "../cost/pricing-fetcher.js";
import { getActivePricingCache } from "../cost/cost-visibility.js";
import type { LifecycleHookEvent, LifecycleHookStatus } from "../session/hooks.js";
import { validateView, type ViewNode } from "./view/index.js";
import { parseManageTasksArgs, applyManageTasks, type Task } from "../agent/tasks.js";

// Provider-agnostic detection of context-window-overflow error text. The
// upstream classifier only tags a 400 with specific English phrases as
// context_overflow; providers that return a 429 or differently-worded body
// (e.g. z.ai) slip through mislabeled, so we re-check the message here.
function looksLikeContextOverflow(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("input is too long") ||
    lower.includes("exceeds the maximum") ||
    lower.includes("reduce the length")
  );
}

// PlanStep is the type used by the plan gate modal (approval UI).
export type PlanStep = {
  file: string;
  action: string;
  completed: boolean;
  deviated: boolean;
};

// Raw step as stored in the "plan" content block from submit_plan args.
type PlanBlockStep = { file: string; action: string; reason?: string };

export type ContentBlockData =
  | { type: "user"; content: string }
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { type: "reply"; content: string }
  | { type: "tasks"; tasks: Task[] }
  | { type: "plan"; steps: PlanBlockStep[] }
  | { type: "view"; node: ViewNode }
  | { type: "error"; message: string };

export type ContentBlock = ContentBlockData & { id: string };

export type AgentStatus = "idle" | "running" | "done" | "failed" | "blocked" | "stopping" | "stopped";

export type AgentStreamState = {
  contentBlocks: ContentBlock[];
  turnsUsed: number;
  status: AgentStatus;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  formattedCost: string;
  latestUserMessage: string;
  hooks: LifecycleHookStatus[];
  tasks: Task[];
  elapsedMs: number;
  awaitingResponse: boolean;
  // Use this (not status === "running") to decide whether to queue a new message.
  isProcessing: boolean;
  currentToolName: string | null;
  streamingType: "text" | "thinking" | "tool" | null;
  activityTick: number;
  // Tracked in the store rather than mirrored into a ref via an effect, so it
  // stays in sync with every event without an extra subscription.
  lastActivityAt: number;
  quotaError: { retryAfterMs: number; retryAt: number } | null;
  currentPlanStep: number | null;
  planTotal: number | null;
  planDeviated: boolean;
  addEvent(event: ReactorEmittedEvent): void;
  addHookEvent(event: LifecycleHookEvent): void;
  setGatePending(pending: boolean): void;
  requestStop(): void;
  markRunning(): void;
  clear(): void;
};

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function stringifyToolArguments(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export function createAgentStreamState(
  initialHooks: LifecycleHookStatus[] = [],
  getModelId?: () => string,
): AgentStreamState {
  // Price each turn at the active model's rate, resolved live so a mid-session
  // provider/model switch is reflected without recreating the meter.
  const makeFaremeter = () =>
    createFaremeter({
      resolvePricing: () =>
        getModelId === undefined ? null : lookupModelPricing(getActivePricingCache(), getModelId()),
    });
  const contentBlocks: ContentBlock[] = [];
  // Cached snapshot returned by the contentBlocks getter. Rebuilt lazily only
  // when the internal array is mutated, so repeated reads within one render
  // return the same reference and referential-equality memoization holds.
  let contentBlocksSnapshot: ContentBlock[] = [];
  let contentBlocksDirty = true;
  // Monotonic per-state counter for stable block ids. Stable ids let the UI key
  // expansion/selection state to a block rather than its array position, which
  // shifts when plan/present handlers splice the array.
  let blockSeq = 0;
  const nextBlockId = (): string => `b${(blockSeq += 1)}`;

  const pushBlock = (block: ContentBlockData): void => {
    contentBlocks.push({ ...block, id: nextBlockId() });
    contentBlocksDirty = true;
  };
  const spliceBlocks = (start: number, deleteCount: number): void => {
    contentBlocks.splice(start, deleteCount);
    contentBlocksDirty = true;
  };
  const unshiftBlock = (block: ContentBlockData): void => {
    contentBlocks.unshift({ ...block, id: nextBlockId() });
    contentBlocksDirty = true;
  };
  const setBlock = (index: number, block: ContentBlockData): void => {
    contentBlocks[index] = { ...block, id: nextBlockId() };
    contentBlocksDirty = true;
  };

  const callIdToName = new Map<string, string>();
  const callIdToArguments = new Map<string, string>();
  const hooksById = new Map<string, LifecycleHookStatus>();
  let turnsUsed = 0;
  let status: AgentStatus = "idle";
  let stopRequested = false;
  // Distinguishes model-generated replies (accumulated via deltas — connector.reply
  // would double the content) from director-generated replies (no deltas).
  let hadTextDeltaSinceLastReply = false;
  let awaitingResponse = false;
  let isProcessing = false;
  let latestUserMessage = "";
  let tasks: Task[] = [];
  let quotaError: { retryAfterMs: number; retryAt: number } | null = null;
  let currentPlanStep: number | null = null;
  let planTotal: number | null = null;
  let planDeviated = false;
  let currentToolName: string | null = null;
  let streamingType: "text" | "thinking" | "tool" | null = null;
  // Refcount of open gates. Status is "blocked" while this is > 0, so
  // resolving one gate while another is still open does not prematurely
  // flip status back to "running".
  let gateCount = 0;
  let cacheReadTokens = 0;
  let contextTokens = 0;
  let startedAt = Date.now();
  let finishedAt: number | null = null;
  let openCallId: string | null = null;
  let activityTick = 0;
  let lastActivityAt = Date.now();
  // Bump on every streamed token: advances the render tick and resets the
  // stall clock in one place so the two never drift.
  const markActivity = (): void => {
    activityTick += 1;
    lastActivityAt = Date.now();
  };
  let faremeter = makeFaremeter();
  for (const hook of initialHooks) {
    hooksById.set(hook.id, { ...hook });
  }

  return {
    get contentBlocks() {
      if (contentBlocksDirty) {
        contentBlocksSnapshot = [...contentBlocks];
        contentBlocksDirty = false;
      }
      return contentBlocksSnapshot;
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
    get inputTokens() {
      return faremeter.getInputTokens();
    },
    get outputTokens() {
      return faremeter.getOutputTokens();
    },
    get cacheReadTokens() {
      return cacheReadTokens;
    },
    get contextTokens() {
      return contextTokens;
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
    get tasks() {
      return tasks;
    },
    get elapsedMs() {
      return (finishedAt ?? Date.now()) - startedAt;
    },
    get awaitingResponse() {
      return awaitingResponse;
    },
    get isProcessing() {
      return isProcessing;
    },
    get currentToolName() {
      return currentToolName;
    },
    get streamingType() {
      return streamingType;
    },
    get activityTick() {
      return activityTick;
    },
    get lastActivityAt() {
      return lastActivityAt;
    },
    get quotaError() {
      return quotaError;
    },
    get currentPlanStep() {
      return currentPlanStep;
    },
    get planTotal() {
      return planTotal;
    },
    get planDeviated() {
      return planDeviated;
    },
    setGatePending(pending: boolean): void {
      // Always balance the count, even when the run is terminal/stopping — a gate
      // that opened while running can still resolve after a stop, and if the
      // decrement were skipped the count would stick above zero and wedge the
      // next run in "blocked". Only the status flip is gated on a live run.
      gateCount += pending ? 1 : -1;
      if (gateCount < 0) gateCount = 0;
      if (status === "idle" || status === "done" || status === "failed" || status === "stopping" || status === "stopped") return;
      status = gateCount > 0 ? "blocked" : "running";
    },
    requestStop(): void {
      if (status !== "running" && status !== "blocked") return;
      stopRequested = true;
      status = "stopped";
      awaitingResponse = false;
      isProcessing = false;
      currentToolName = null;
      streamingType = null;
      finishedAt = Date.now();
    },
    markRunning(): void {
      // A fresh send revives the loop after it settled (done/stopped/failed).
      // Clear any gate count left over from an aborted-while-gated prior run so
      // the new run never starts wedged in "blocked".
      stopRequested = false;
      gateCount = 0;
      quotaError = null;
      status = "running";
      finishedAt = null;
      awaitingResponse = true;
      isProcessing = true;
      // A fresh send (re)enters the awaiting-response gap; restart the stall
      // clock so a send following a long idle stretch is not aborted on the
      // watchdog's first tick against a stale timestamp.
      lastActivityAt = Date.now();
    },
    clear(): void {
      contentBlocks.length = 0;
      contentBlocksDirty = true;
      blockSeq = 0;
      callIdToName.clear();
      callIdToArguments.clear();
      turnsUsed = 0;
      status = "idle";
      stopRequested = false;
      hadTextDeltaSinceLastReply = false;
      awaitingResponse = false;
      isProcessing = false;
      latestUserMessage = "";
      tasks = [];
      quotaError = null;
      currentPlanStep = null;
      planTotal = null;
      planDeviated = false;
      currentToolName = null;
      streamingType = null;
      gateCount = 0;
      startedAt = Date.now();
      finishedAt = null;
      openCallId = null;
      activityTick = 0;
      lastActivityAt = Date.now();
      contextTokens = 0;
      faremeter = makeFaremeter();
    },
    addEvent(event: ReactorEmittedEvent): void {
      switch (event.type) {
        case "message.received": {
          const data = event.data as { message: { content: string } };
          latestUserMessage = data.message.content;
          pushBlock({ type: "user", content: data.message.content });
          break;
        }
        case "inference.thinking.delta": {
          awaitingResponse = false;
          streamingType = "thinking";
          markActivity();
          const token = (event.data as { token: string }).token;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "thinking") {
            last.content += token;
            contentBlocksDirty = true;
          } else {
            pushBlock({ type: "thinking", content: token });
          }
          break;
        }
        case "inference.text.delta": {
          awaitingResponse = false;
          streamingType = "text";
          hadTextDeltaSinceLastReply = true;
          markActivity();
          const token = (event.data as { token: string }).token;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "text") {
            last.content += token;
            contentBlocksDirty = true;
          } else {
            pushBlock({ type: "text", content: token });
          }
          break;
        }
        case "inference.tool_call.start": {
          awaitingResponse = false;
          const data = event.data as { name: string; callId: string };
          currentToolName = data.name;
          streamingType = "tool";
          callIdToName.set(data.callId, data.name);
          callIdToArguments.set(data.callId, "");
          openCallId = data.callId;
          pushBlock({ type: "tool_call", name: data.name, arguments: "" });
          break;
        }
        case "inference.tool_call.delta": {
          markActivity();
          const fragment = (event.data as { argumentFragment: string }).argumentFragment;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "tool_call") {
            last.arguments += fragment;
            contentBlocksDirty = true;
          }
          if (openCallId !== null) {
            callIdToArguments.set(openCallId, (callIdToArguments.get(openCallId) ?? "") + fragment);
          }
          break;
        }
        case "inference.tool_call.end": {
          awaitingResponse = false;
          streamingType = "tool";
          const data = event.data as { name: string; callId: string; arguments?: unknown };
          currentToolName = data.name;
          callIdToName.set(data.callId, data.name);
          const existingArguments = callIdToArguments.get(data.callId) ?? "";
          const argumentText = data.arguments === undefined ? existingArguments : stringifyToolArguments(data.arguments);
          callIdToArguments.set(data.callId, argumentText);
          openCallId = null;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last?.type === "tool_call" && last.name === data.name) {
            if (argumentText.length > 0) last.arguments = argumentText;
            contentBlocksDirty = true;
          } else {
            pushBlock({ type: "tool_call", name: data.name, arguments: argumentText });
          }
          break;
        }
        case "connector.reply": {
          const replyData = event.data as { content: string };
          if (!hadTextDeltaSinceLastReply && replyData.content.length > 0) {
            const last = contentBlocks[contentBlocks.length - 1];
            if (last && last.type === "text") {
              last.content += replyData.content;
              contentBlocksDirty = true;
            } else {
              pushBlock({ type: "text", content: replyData.content });
            }
          }
          hadTextDeltaSinceLastReply = false;
          awaitingResponse = false;
          isProcessing = false;
          break;
        }
        case "tool.done": {
          awaitingResponse = true;
          // Restart the stall clock so the wait for the model's next move is
          // measured from now, not from the previous token.
          lastActivityAt = Date.now();
          currentToolName = null;
          streamingType = null;
          const result = (event.data as { result: { callId: string; content: unknown; isError: boolean } }).result;
          const trackedName = callIdToName.get(result.callId);
          const name = trackedName ?? result.callId;
          const content = stringifyToolContent(result.content);

          if (name === "submit_plan" && !result.isError) {
            const rawArgs = callIdToArguments.get(result.callId) ?? "";
            callIdToName.delete(result.callId);
            callIdToArguments.delete(result.callId);
            let steps: PlanBlockStep[] = [];
            try {
              const parsed = JSON.parse(rawArgs) as { steps?: Array<{ file: string; action: string; reason?: string }> };
              if (Array.isArray(parsed.steps)) {
                steps = parsed.steps.map((s) => ({ file: s.file, action: s.action, ...(s.reason !== undefined ? { reason: s.reason } : {}) }));
              }
            } catch { /* invalid args → empty plan */ }
            // Remove originating tool_call block
            let planCallIndex = -1;
            for (let i = contentBlocks.length - 1; i >= 0; i--) {
              const b = contentBlocks[i];
              if (b?.type === "tool_call" && b.name === "submit_plan") { planCallIndex = i; break; }
            }
            if (planCallIndex >= 0) spliceBlocks(planCallIndex, 1);
            // Replace existing plan block or pin at index 0
            const existingPlanIndex = contentBlocks.findIndex((b) => b.type === "plan");
            const planBlock = { type: "plan" as const, steps };
            if (existingPlanIndex >= 0) {
              setBlock(existingPlanIndex, planBlock);
            } else {
              unshiftBlock(planBlock);
            }
            currentPlanStep = 0;
            planTotal = steps.length;
            planDeviated = false;
            break;
          }

          if ((name === "write_file" || name === "edit_file") && !result.isError && currentPlanStep !== null && planTotal !== null) {
            const rawArgs = callIdToArguments.get(result.callId) ?? "";
            callIdToName.delete(result.callId);
            callIdToArguments.delete(result.callId);
            let filePath = "";
            try { filePath = (JSON.parse(rawArgs) as { path?: string }).path ?? ""; } catch { /* ignored */ }
            const planBlock = contentBlocks.find((b) => b.type === "plan");
            if (planBlock?.type === "plan" && filePath.length > 0) {
              // Find the next step with a non-empty file, skipping fileless steps.
              let nextFileIndex: number | null = null;
              for (let i = currentPlanStep; i < planBlock.steps.length; i++) {
                const s = planBlock.steps[i];
                if (s !== undefined && s.file.length > 0) { nextFileIndex = i; break; }
              }
              if (nextFileIndex !== null && planBlock.steps[nextFileIndex]?.file === filePath) {
                // Find the next file step after this one; null if none remain.
                let afterIndex: number | null = null;
                for (let i = nextFileIndex + 1; i < planBlock.steps.length; i++) {
                  const s = planBlock.steps[i];
                  if (s !== undefined && s.file.length > 0) { afterIndex = i; break; }
                }
                currentPlanStep = afterIndex;
              } else {
                planDeviated = true;
              }
            }
          }

          if (name === "manage_tasks" && !result.isError) {
            let taskCallIndex = -1;
            for (let i = contentBlocks.length - 1; i >= 0; i--) {
              const b = contentBlocks[i];
              if (b?.type === "tool_call" && b.name === "manage_tasks") {
                taskCallIndex = i;
                break;
              }
            }
            const taskArgs = callIdToArguments.get(result.callId) ?? "";
            callIdToName.delete(result.callId);
            callIdToArguments.delete(result.callId);
            const newTasks = (() => {
              let raw: unknown;
              try { raw = JSON.parse(taskArgs as string); } catch { return tasks; }
              const parsed = parseManageTasksArgs(raw);
              return parsed !== null ? applyManageTasks(tasks, parsed) : tasks;
            })();
            if (taskCallIndex >= 0) {
              spliceBlocks(taskCallIndex, 1);
            }
            const existingTaskIndex = contentBlocks.findIndex((b) => b.type === "tasks");
            const taskBlock = { type: "tasks" as const, tasks: newTasks };
            if (existingTaskIndex >= 0) {
              setBlock(existingTaskIndex, taskBlock);
            } else {
              unshiftBlock(taskBlock);
            }
            tasks = newTasks;
            break;
          }

          if (name === "present" && !result.isError) {
            const rawArgs = callIdToArguments.get(result.callId) ?? "";
            callIdToName.delete(result.callId);
            callIdToArguments.delete(result.callId);
            let view: unknown;
            try {
              view = (JSON.parse(rawArgs) as { view?: unknown }).view;
            } catch {
              view = undefined;
            }
            const validated = validateView(view);
            if (validated.ok) {
              // Remove the originating tool_call block so it does not appear
              // as a redundant "Render view" line above the rendered output (H3).
              let presentCallIndex = -1;
              for (let i = contentBlocks.length - 1; i >= 0; i--) {
                const b = contentBlocks[i];
                if (b?.type === "tool_call" && b.name === "present") {
                  presentCallIndex = i;
                  break;
                }
              }
              if (presentCallIndex >= 0) {
                spliceBlocks(presentCallIndex, 1);
              }
              pushBlock({ type: "view", node: validated.node });
              break;
            }
          }

          callIdToName.delete(result.callId);
          callIdToArguments.delete(result.callId);

          pushBlock({ type: "tool_result", callId: result.callId, name, content, isError: result.isError });
          break;
        }
        case "reactor.error": {
          const data = event.data as { fatal: boolean; error: string };
          pushBlock({ type: "error", message: data.error });
          break;
        }
        case "inference.error": {
          const err = (event.data as { error: { category: string; message: string; retryAfterMs?: number } }).error;
          const friendly: Record<string, string> = {
            credential_failure: "Authentication failed — check your API key.",
            quota_exhausted: "Quota exhausted — usage limit reached.",
            context_overflow: "Context window full — compaction could not keep up. Try /clear to start fresh.",
            retryable: "Request failed — will retry.",
            aborted: "Request aborted.",
            timeout: "Request timed out.",
            protocol_mismatch: "Unexpected response from inference API.",
          };
          // Some providers (e.g. z.ai) report a context-window overflow as a 429
          // or a 400 whose wording the upstream classifier does not recognize, so
          // it arrives mislabeled as quota_exhausted/fatal. Trust the message text
          // over the category when it clearly describes a context overflow, so the
          // user gets the right guidance instead of a misleading "quota" error.
          const category = looksLikeContextOverflow(err.message) ? "context_overflow" : err.category;
          const msg = friendly[category] ?? err.message;
          pushBlock({ type: "error", message: msg });
          if (category === "quota_exhausted" && err.retryAfterMs !== undefined) {
            quotaError = { retryAfterMs: err.retryAfterMs, retryAt: Date.now() + err.retryAfterMs };
          }
          break;
        }
        default:
          break;
      }

      if (event.type === "inference.done") {
        turnsUsed++;
        awaitingResponse = false;
        streamingType = null;
      }

      if (event.type === "inference.usage") {
        const data = event.data as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number } };
        faremeter.addUsage(data.usage);
        cacheReadTokens += data.usage.cacheRead;
        contextTokens = data.usage.input + data.usage.output;
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

// Token events arrive at high frequency; structural events (status changes,
// turn boundaries) bypass pending-render batching so they're never delayed.
const TOKEN_EVENTS = new Set([
  "inference.text.delta",
  "inference.thinking.delta",
  "inference.tool_call.delta",
]);

export function useAgentStream(
  emitter: EventEmitter,
  initialHooks: LifecycleHookStatus[] = [],
  getModel?: () => string,
  onInferenceTimeout?: () => void,
): AgentStreamState {
  // getModel is read live by the faremeter's pricing resolver, so a
  // mid-session model switch is priced correctly without recreating the state.
  const [state] = useState(() => createAgentStreamState(initialHooks, getModel));
  const [tick, setTick] = useState(0);
  const onInferenceTimeoutRef = useRef(onInferenceTimeout);
  onInferenceTimeoutRef.current = onInferenceTimeout;
  const pendingRenderRef = useRef(false);

  // ~30fps drain makes streaming feel metronomic rather than bursty.
  useEffect(() => {
    const interval = setInterval(() => {
      if (pendingRenderRef.current) {
        pendingRenderRef.current = false;
        setTick((t) => t + 1);
      }
    }, 33);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (event: ReactorEmittedEvent) => {
      state.addEvent(event);
      if (TOKEN_EVENTS.has(event.type)) {
        pendingRenderRef.current = true;
      } else {
        setTick((t) => t + 1);
      }
      if (
        event.type === "inference.error" &&
        (event.data as { error: { category: string } }).error.category === "timeout"
      ) {
        onInferenceTimeoutRef.current?.();
      }
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
    if (state.status !== "running" && state.status !== "blocked" && state.quotaError === null) return;
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [state, state.status, state.quotaError]);

  void tick;

  return state;
}
