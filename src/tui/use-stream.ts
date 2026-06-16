import { useState, useEffect, useRef } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { type } from "arktype";
import { createFaremeter, formatCost } from "../cost/faremeter.js";
import { lookupModelPricing } from "../cost/pricing-fetcher.js";
import { getActivePricingCache } from "../cost/cost-visibility.js";
import type { LifecycleHookEvent, LifecycleHookStatus } from "../session/hooks.js";
import { validateView, type ViewNode } from "./view/index.js";

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

const PlanStepSchema = type({ file: "string", action: "string", "reason?": "string" });
const PlanSchema = type({ "goal?": "string", steps: PlanStepSchema.array() });

export type PlanStep = { file: string; action: string; reason: string };

// The block payload by type. Blocks carry a stable `id` (see ContentBlock) so UI
// state like "which tool is expanded" survives array mutations (plan/present
// splices) that would otherwise renumber positional indices.
export type ContentBlockData =
  | { type: "user"; content: string }
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { type: "reply"; content: string }
  | { type: "plan"; goal?: string; steps: PlanStep[] }
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
  currentPlanStep: number | null;
  planTotal: number;
  planDeviated: boolean;
  elapsedMs: number;
  awaitingResponse: boolean;
  // True from the moment agent.send() is called until connector.reply fires.
  // Covers the full response window including streaming and tool execution.
  // Use this (not status === "running") to decide whether to queue a new message.
  isProcessing: boolean;
  currentToolName: string | null;
  streamingType: "text" | "thinking" | "tool" | null;
  activityTick: number;
  addEvent(event: ReactorEmittedEvent): void;
  addHookEvent(event: LifecycleHookEvent): void;
  setGatePending(pending: boolean): void;
  requestStop(): void;
  markRunning(): void;
  clear(): void;
};

function parsePlan(rawArguments: string): { goal?: string; steps: PlanStep[] } {
  if (rawArguments.length === 0) return { steps: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(rawArguments);
  } catch {
    return { steps: [] };
  }
  const result = PlanSchema(raw);
  if (result instanceof type.errors) return { steps: [] };
  const steps = result.steps
    .filter((s) => s.file.length > 0 || s.action.length > 0)
    .map((s) => ({ file: s.file, action: s.action, reason: s.reason ?? "" }));
  return result.goal !== undefined ? { goal: result.goal, steps } : { steps };
}

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

function nextFileStepIndex(steps: PlanStep[], from: number): number | null {
  for (let i = from; i < steps.length; i++) {
    if ((steps[i]?.file ?? "").length > 0) return i;
  }
  return null;
}

const PathArgSchema = type({ path: "string>0" });

function parsePathArgument(rawArguments: string): string | null {
  if (rawArguments.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  const result = PathArgSchema(raw);
  return result instanceof type.errors ? null : result.path;
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

  // Wrappers that assign a stable id and mark the snapshot dirty so the getter
  // rebuilds on next read.
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
  // True when at least one inference.text.delta fired since the last connector.reply.
  // Used to distinguish model-generated replies (already accumulated via deltas —
  // connector.reply would double the content) from director-generated replies
  // (no deltas — connector.reply is the only carrier).
  let hadTextDeltaSinceLastReply = false;
  // True while the model is working but nothing is streaming yet — the gap
  // between a send (or a tool result) and the first token of the next reply.
  // Drives the in-flight indicator; cleared the moment real content arrives.
  let awaitingResponse = false;
  // True from markRunning() until connector.reply (or clear/requestStop).
  // Stays true across all streaming and tool-execution phases within a cycle.
  let isProcessing = false;
  let latestUserMessage = "";
  let planSteps: PlanStep[] = [];
  let currentPlanStep: number | null = null;
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
      status = "running";
      finishedAt = null;
      awaitingResponse = true;
      isProcessing = true;
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
      planSteps = [];
      currentPlanStep = null;
      planDeviated = false;
      currentToolName = null;
      streamingType = null;
      gateCount = 0;
      startedAt = Date.now();
      finishedAt = null;
      openCallId = null;
      activityTick = 0;
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
          activityTick += 1;
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
          activityTick += 1;
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
          activityTick += 1;
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
        case "connector.reply": {
          const replyData = event.data as { content: string };
          if (!hadTextDeltaSinceLastReply && replyData.content.length > 0) {
            // Director-generated reply (no inference deltas this cycle) — render it.
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
          // A tool finished; the model is now deciding its next move with nothing
          // streaming, so re-arm the indicator until the next token arrives.
          awaitingResponse = true;
          currentToolName = null;
          streamingType = null;
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
            const planArgs = callIdToArguments.get(result.callId) ?? "";
            // Read all needed values before deleting map entries (H4).
            callIdToName.delete(result.callId);
            callIdToArguments.delete(result.callId);
            const { goal, steps } = parsePlan(planArgs);
            if (planCallIndex >= 0) {
              spliceBlocks(planCallIndex, 1);
            }
            const existingPlanIndex = contentBlocks.findIndex((b) => b.type === "plan");
            const planBlock = goal !== undefined ? { type: "plan" as const, goal, steps } : { type: "plan" as const, steps };
            if (existingPlanIndex >= 0) {
              setBlock(existingPlanIndex, planBlock);
            } else {
              unshiftBlock(planBlock);
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

          // `present` renders a view spec. On success, swap the tool result for the
          // rendered view block; on an invalid spec, fall through so the validation
          // error surfaces and the model can self-correct.
          if (name === "present" && !result.isError) {
            const rawArgs = callIdToArguments.get(result.callId) ?? "";
            // Read args before deleting (H4).
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

          // Delete map entries now that all special-case handling is done (H4).
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
          const err = (event.data as { error: { category: string; message: string } }).error;
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

  useEffect(() => {
    const handler = (event: ReactorEmittedEvent) => {
      state.addEvent(event);
      setTick((t) => t + 1);
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
