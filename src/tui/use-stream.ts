import { useState, useEffect, useRef } from "react";
import { useMemo } from "react";
import type { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import { type } from "arktype";
import { createFaremeter, formatCost } from "../cost/faremeter.js";
import { lookupModelPricing } from "../cost/pricing-fetcher.js";
import { getActivePricingCache } from "../cost/cost-visibility.js";
import type { LifecycleHookEvent, LifecycleHookStatus } from "../session/hooks.js";
import { validateView, type ViewNode } from "./view/index.js";
import { parsePresentViewFromArgs } from "./tool-args.js";
import { parseManageTasksArgs, applyManageTasks, type Task } from "../agent/tasks.js";
import { isNonTerminalInferenceError } from "../inference-abort.js";
import {
  gatewayOverloadUserMessage,
  isGatewayOverloadInferenceError,
} from "../inference-gateway-error.js";

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
  | { type: "tool_call"; callId?: string; name: string; arguments: string; startedAt?: number }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean; finishedAt?: number }
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
  // Whether the latest user message is already visible as a block in the log,
  // so the header can stop showing it. Tracked incrementally to avoid an O(n)
  // block scan on every render.
  latestUserMessageLogged: boolean;
  hooks: LifecycleHookStatus[];
  // Cheap count accessor that avoids allocating the full hooks snapshot when
  // only the count is needed.
  hookCount: number;
  tasks: Task[];
  subAgents: Task[];
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
  inferenceRetry: { attempt: number; delayMs: number; retryAt: number } | null;
  currentPlanStep: number | null;
  planTotal: number | null;
  planDeviated: boolean;
  // Count of oldest blocks dropped from the display once the retention cap is
  // exceeded. Non-zero means the rendered transcript is a tail, not the whole
  // history; the UI surfaces this so the trim is never silent.
  trimmedBlockCount: number;
  // Bumped each time clear() replaces the transcript for a fresh session. The
  // renderer keys the committed-scrollback reset off this explicit signal rather
  // than inferring "replaced" from block ids, which clear() resets to reuse the
  // prior session's values.
  generation: number;
  addEvent(event: ReactorEmittedEvent): void;
  hydrateHistory(blocks: ContentBlockData[]): void;
  addHookEvent(event: LifecycleHookEvent): void;
  // Live sub-agent tool activity from the runner's onProgress channel. Keeps
  // the stall clock and status bar current without replaying the sub-agent
  // transcript into the parent content blocks.
  noteSubAgentProgress(info: { description: string; toolName: string }): void;
  setGatePending(pending: boolean): void;
  requestStop(): void;
  markRunning(): void;
  appendUserMessage(content: string): void;
  clear(): void;
};

// Inference error categories the reactor recovers from on its own — a retry is
// coming or the user aborted — so they must not terminally fail the run or
// finalize its in-flight tool calls.


// This is display-only state; the agent context is retained separately. Keep the
// TUI tail bounded so long tool-heavy runs do not stall every streaming render.
const MAX_RETAINED_BLOCKS = 600;

// Ingress caps keep a single block from forcing a full-history wrap on every frame.
export const MAX_STORED_TOOL_RESULT_CHARS = 48_000;
export const MAX_STORED_TOOL_ARGUMENT_CHARS = 24_000;
export const MAX_STORED_ASSISTANT_BLOCK_CHARS = 128_000;

// Per-block caps bound one block, but 600 blocks each near their cap would still
// pin tens of megabytes. This total-content budget trims the oldest blocks until
// the retained tail fits, so memory plateaus regardless of block mix. Measured in
// characters, which track bytes closely enough for a display budget.
export const MAX_RETAINED_TRANSCRIPT_BYTES = 8_000_000;

// Tool output pays off at the end (exit codes, error summaries, test totals),
// so the kept window anchors on the tail. Arguments and prose are head-anchored
// because the meaningful prefix (command path, opening sentences) comes first.
type CapAnchor = "head" | "tail";

function capWithOmissionSuffix(
  content: string,
  maxChars: number,
  label: string,
  anchor: CapAnchor = "head",
): string {
  if (content.length <= maxChars) return content;
  const omitted = content.length - maxChars;
  const marker = `\n\n… ${omitted} characters omitted from ${label}`;
  // The tail anchor also inserts a "\n\n" separator between the marker and the
  // kept content, so its budget must reserve those two characters. Otherwise the
  // result overshoots maxChars by 2, and a second cap on the already-capped
  // string would slice through the first marker.
  const separator = anchor === "tail" ? "\n\n" : "";
  const budget = maxChars - marker.length - separator.length;
  const kept = anchor === "tail" ? content.slice(content.length - budget) : content.slice(0, budget);
  return anchor === "tail" ? `${marker}${separator}${kept}` : `${kept}${marker}`;
}

export function capStoredToolResultContent(content: string): string {
  return capWithOmissionSuffix(content, MAX_STORED_TOOL_RESULT_CHARS, "stored tool output", "tail");
}

export function capStoredToolArguments(argumentsText: string): string {
  return capWithOmissionSuffix(argumentsText, MAX_STORED_TOOL_ARGUMENT_CHARS, "stored tool arguments");
}

function capStoredAssistantContent(content: string): string {
  return capWithOmissionSuffix(content, MAX_STORED_ASSISTANT_BLOCK_CHARS, "stored assistant text");
}

// A resumed transcript arrives already stringified. The producer
// (turnsToContentBlocks) already caps tool_result and tool_call content, so
// re-capping them here would double-cap: the tail-anchored tool_result marker
// would be re-cut, corrupting the omission suffix. Assistant text and thinking
// are the only fields the producer leaves uncapped, so they are the only ones
// bounded on hydration.
function capResumedBlock(block: ContentBlockData): ContentBlockData {
  switch (block.type) {
    case "text":
    case "thinking":
      return { ...block, content: capStoredAssistantContent(block.content) };
    default:
      return block;
  }
}

// Approximate retained size of a block for the total-content budget. Only the
// unbounded string fields matter; structural blocks (tasks, plan, view) are
// small and fixed, so they contribute nothing to the trimming decision.
function blockContentLength(block: ContentBlock): number {
  switch (block.type) {
    case "user":
    case "thinking":
    case "text":
    case "reply":
      return block.content.length;
    case "tool_call":
      return block.arguments.length;
    case "tool_result":
      return block.content.length;
    case "error":
      return block.message.length;
    default:
      return 0;
  }
}

const OMITTED_STREAMING_SUFFIX = "… additional streaming content omitted";

// Appends a fragment to a bounded buffer. The first frame that crosses the cap
// stitches in an omission marker; every subsequent frame short-circuits because
// the marker pushed content past the threshold, so the suffix appears once.
function appendBoundedInPlace(content: string, fragment: string, maxChars: number): string {
  if (content.length >= maxChars) return content;
  const room = maxChars - content.length;
  if (fragment.length <= room) return content + fragment;
  const head = content + fragment.slice(0, room);
  return `${head}\n\n${OMITTED_STREAMING_SUFFIX}`;
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

function stringifyToolArguments(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

// A sub-agent is a worker, so one without a named profile is still labeled —
// "worker" — so the activity row always reads like a named crew member rather
// than a bare task description.
const DEFAULT_AGENT_NAME = "worker";

function parseTaskToolTitle(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as { description?: unknown; agent?: unknown };
    const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
    const agent = typeof parsed.agent === "string" && parsed.agent.trim().length > 0
      ? parsed.agent.trim()
      : DEFAULT_AGENT_NAME;
    if (description.length === 0) return agent;
    return `${agent}: ${description}`;
  } catch {
    return DEFAULT_AGENT_NAME;
  }
}

// Done sub-agents are never rendered (the agents strip only shows non-done
// entries), so drop them here rather than let the array grow for the whole
// session. This keeps subAgents bounded by concurrently active sub-agents.
function updateSubAgent(tasks: Task[], callId: string, patch: Omit<Task, "id">): Task[] {
  const next = tasks.filter((task) => task.id !== callId);
  if (patch.status === "done" || patch.status === "cancelled") return next;
  return [...next, { id: callId, ...patch }];
}

// Settle (or prune) a strip entry when a tool result lands. Prefer name === "task";
// also match by callId so a lost callId→name map cannot leave a permanent "doing"
// ghost. Exported for regression tests that simulate map loss without poking
// createAgentStreamState internals.
export function settleSubAgentOnToolResult(
  agents: readonly Task[],
  callId: string,
  toolName: string | undefined,
  isError: boolean,
  title: string,
): Task[] {
  const name = toolName ?? callId;
  if (name !== "task" && !agents.some((a) => a.id === callId)) return [...agents];
  return updateSubAgent([...agents], callId, {
    title,
    status: isError ? "cancelled" : "done",
  });
}

// High-frequency streamed fragments buffer between display drains instead of
// re-concatenating the block on every fragment; every other event forces the
// buffer to flush so any handler that reads block content sees it settled.
const STREAM_DELTA_TYPES = new Set([
  "inference.text.delta",
  "inference.thinking.delta",
  "inference.tool_call.delta",
]);

export function createAgentStreamState(
  initialHooks: LifecycleHookStatus[] = [],
  getModelId?: () => string,
  initialContentBlocks: ContentBlockData[] = [],
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
  // The display retains the whole conversation while the agent compacts its own
  // turns, so a long-running session would grow the block array without bound —
  // and every streaming render pays O(blocks) to snapshot, map, and diff it.
  // Cap the retained tail so per-render cost and memory plateau; the dropped
  // count feeds a trimmed-history marker.
  let trimmedBlockCount = 0;
  // Session epoch: incremented by clear() so the renderer can reset committed
  // scrollback on an explicit signal instead of guessing from block ids.
  let generation = 0;
  const trimOldestBlocks = (): void => {
    let drop = Math.max(0, contentBlocks.length - MAX_RETAINED_BLOCKS);
    let retainedBytes = 0;
    for (let i = drop; i < contentBlocks.length; i++) {
      retainedBytes += blockContentLength(contentBlocks[i]!);
    }
    // Keep dropping the oldest block until the retained tail fits the byte
    // budget, but never drop the newest block — the live stream needs somewhere
    // to append even when a single block exceeds the budget on its own.
    while (retainedBytes > MAX_RETAINED_TRANSCRIPT_BYTES && drop < contentBlocks.length - 1) {
      retainedBytes -= blockContentLength(contentBlocks[drop]!);
      drop += 1;
    }
    if (drop > 0) {
      contentBlocks.splice(0, drop);
      trimmedBlockCount += drop;
      contentBlocksDirty = true;
    }
  };
  // Monotonic per-state counter for stable block ids. Stable ids let the UI key
  // expansion/selection state to a block rather than its array position, which
  // shifts when plan/present handlers splice the array.
  let blockSeq = 0;
  const nextBlockId = (): string => `b${(blockSeq += 1)}`;

  const pushBlock = (block: ContentBlockData): void => {
    contentBlocks.push({ ...block, id: nextBlockId() });
    contentBlocksDirty = true;
    trimOldestBlocks();
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

  // A turn can end (user abort, reactor/inference error) while a tool_call is
  // still outstanding — no tool.done ever arrives. Its block would stay
  // resultless, so the display keeps spinning a live braille clock on a tool
  // that is no longer running. Synthesize an aborted tool_result for every
  // resultless call so the row settles into a normal completed (error) state.
  const finalizeOutstandingToolCalls = (): void => {
    const resolved = new Set<string>();
    for (const block of contentBlocks) {
      if (block.type === "tool_result") resolved.add(block.callId);
    }
    // Snapshot the current calls before pushing — pushBlock mutates the array.
    const outstanding = contentBlocks.filter(
      (block): block is ContentBlock & { type: "tool_call" } =>
        block.type === "tool_call" && !resolved.has(block.callId ?? block.id),
    );
    const outstandingIds = new Set<string>();
    for (const call of outstanding) {
      const callId = call.callId ?? call.id;
      outstandingIds.add(callId);
      resolved.add(callId);
      pushBlock({
        type: "tool_result",
        callId,
        name: call.name,
        content: "Aborted.",
        isError: true,
        finishedAt: Date.now(),
      });
    }
    // The Agents-strip fallback is keyed by tool callId. Drop matching entries
    // so a stop/error cannot leave a ghost "doing" row while the session store
    // (and Ctrl+E) correctly show nothing running.
    if (outstandingIds.size > 0 && subAgents.length > 0) {
      subAgents = subAgents.filter((a) => !outstandingIds.has(a.id));
    }
  };

  const ensureUserBlock = (fullContent: string): void => {
    latestUserMessage = fullContent;
    latestUserMessageLogged = true;
    const last = contentBlocks[contentBlocks.length - 1];
    if (!last || last.type !== "user" || last.content !== fullContent) {
      pushBlock({ type: "user", content: fullContent });
    }
  };

  const callIdToName = new Map<string, string>();
  const callIdToArguments = new Map<string, string>();
  const activeToolCallIds = new Set<string>();
  const hooksById = new Map<string, LifecycleHookStatus>();
  // Cached snapshot of hooks — rebuilt lazily only when the underlying map is
  // mutated, so repeated reads within one render return the same reference.
  let hooksSnapshot: LifecycleHookStatus[] = [];
  let hooksDirty = true;
  let turnsUsed = 0;
  let status: AgentStatus = "idle";
  let stopRequested = false;
  // Distinguishes model-generated replies (accumulated via deltas — connector.reply
  // would double the content) from director-generated replies (no deltas).
  let hadTextDeltaSinceLastReply = false;
  let awaitingResponse = false;
  let isProcessing = false;
  let latestUserMessage = "";
  // Whether the latestUserMessage is already represented by a user block in
  // contentBlocks. Used by the header to avoid duplicating the message preview
  // once the block has landed in the transcript (via appendUserMessage on submit
  // or message.received).
  let latestUserMessageLogged = true;
  let tasks: Task[] = [];
  let subAgents: Task[] = [];
  let quotaError: { retryAfterMs: number; retryAt: number } | null = null;
  let inferenceRetry: { attempt: number; delayMs: number; retryAt: number } | null = null;
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
  // Boundary marking where the current inference attempt's blocks begin,
  // and the tool call ids known before it started. inference.retry has two
  // producers with opposite meanings, distinguished by ordering. The harness
  // emits it for a pre-commit retry: the failed attempt's inference.start was
  // still buffered and is discarded, so the event arrives before any
  // inference.start for the cycle and there is nothing to retract. The
  // reactor emits it after a committed attempt failed: inferenceRunner is
  // about to restart from scratch and re-stream what the failed attempt
  // already rendered, so the transcript must roll back to the attempt
  // boundary. The boundary is therefore only armed between an
  // inference.start and its cycle's inference.done (or a rollback); a retry
  // arriving disarmed is the harness kind and must not touch the previous
  // cycle's settled blocks.
  let attemptStartBlockIndex: number | null = null;
  let attemptStartCallIds: Set<string> = new Set();
  // A cycle can also terminate in inference.error with no inference.done
  // (user abort, fatal, exhausted failover). The boundary must not stay
  // armed across that terminal error — a later cycle's pre-commit harness
  // retry would splice away the aborted partial and anything rendered since,
  // including user messages. But the reactor's committed-retry path emits
  // its inference.retry immediately after the failed attempt's
  // inference.error, and that retry must still retract. So inference.error
  // hands the armed boundary off here; only an immediately-following
  // inference.retry consumes it, and any other event clears it.
  let errorRollbackHandoff: { blockIndex: number; callIds: Set<string> } | null = null;
  // Tool call ids that already produced a tool_result block in the current
  // cycle. Index-based providers synthesize callIds that are only unique
  // within one cycle (e.g. "0", "1"), so deduping re-emitted tool.done
  // events must be scoped to the cycle, not the whole transcript.
  let resolvedCallIds = new Set<string>();
  // Streamed fragments accumulate here between drains and join once on flush,
  // so a burst of N fragments costs O(N) buffering plus one join rather than N
  // growing concatenations. The target is the block (and field) currently being
  // streamed into; switching targets flushes the previous one first.
  let pendingBlock: ContentBlock | null = null;
  let pendingField: "content" | "arguments" | null = null;
  let pendingFragments: string[] = [];
  let pendingMaxChars = 0;
  const flushPending = (): void => {
    if (pendingBlock === null || pendingFragments.length === 0) return;
    const joined = pendingFragments.join("");
    pendingFragments = [];
    if (pendingField === "arguments" && pendingBlock.type === "tool_call") {
      pendingBlock.arguments = appendBoundedInPlace(pendingBlock.arguments, joined, pendingMaxChars);
      // The block is the sole accumulator; mirror the settled value into the
      // callId map so a tool.done that arrives without a tool_call.end still
      // resolves the arguments it needs.
      if (pendingBlock.callId !== undefined) callIdToArguments.set(pendingBlock.callId, pendingBlock.arguments);
    } else if (pendingField === "content" && "content" in pendingBlock) {
      pendingBlock.content = appendBoundedInPlace(pendingBlock.content, joined, pendingMaxChars);
    }
    // Deliberately not marking contentBlocksDirty: this mutates the field of a
    // block object already reachable through the last-taken snapshot array (same
    // reference, not a new one), so that snapshot already reflects the new
    // content without a rebuild. Marking dirty here would force the
    // contentBlocks getter to re-copy the whole array on every streamed token,
    // making steady-state streaming cost grow with transcript length instead of
    // staying O(1).
  };
  const bufferFragment = (
    block: ContentBlock,
    field: "content" | "arguments",
    maxChars: number,
    fragment: string,
  ): void => {
    if (pendingBlock !== block || pendingField !== field) {
      flushPending();
      pendingBlock = block;
      pendingField = field;
      pendingMaxChars = maxChars;
    }
    pendingFragments.push(fragment);
    // See the note in flushPending: buffering a fragment does not change the
    // shape of contentBlocks, only a field on an object already in the last
    // snapshot, so this must not force a full-array re-copy either.
  };
  let activityTick = 0;
  let lastActivityAt = Date.now();
  // Bump on every streamed token: advances the render tick and resets the
  // stall clock in one place so the two never drift.
  const markActivity = (): void => {
    activityTick += 1;
    lastActivityAt = Date.now();
  };
  // Footer spinner flags (isProcessing / streamingType) normally clear on
  // connector.reply or requestStop(); terminal stream paths must settle too.
  const settleProcessingChrome = (): void => {
    isProcessing = false;
    currentToolName = null;
    streamingType = null;
  };
  let faremeter = makeFaremeter();
  for (const hook of initialHooks) {
    hooksById.set(hook.id, { ...hook });
  }
  hooksDirty = true;
  for (const block of initialContentBlocks) {
    pushBlock(capResumedBlock(block));
  }
  // Blocks now hold capped copies, so drop the original resume payload — it can
  // be multiple megabytes and would otherwise stay reachable through the prop
  // long after the visible tail is trimmed. This mutates a caller-owned array,
  // which is safe only because the useState initializer runs exactly once; a
  // double-invoked initializer (e.g. React StrictMode) would hydrate the
  // already-emptied array and lose the transcript.
  initialContentBlocks.length = 0;

  return {
    get contentBlocks() {
      flushPending();
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
    get latestUserMessageLogged() {
      return latestUserMessageLogged;
    },
    get hooks() {
      if (hooksDirty) {
        hooksSnapshot = [...hooksById.values()].map((hook) => ({ ...hook }));
        hooksDirty = false;
      }
      return hooksSnapshot;
    },
    get hookCount() {
      return hooksById.size;
    },
    get tasks() {
      return tasks;
    },
    get subAgents() {
      return subAgents;
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
    get inferenceRetry() {
      return inferenceRetry;
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
    get trimmedBlockCount() {
      return trimmedBlockCount;
    },
    get generation() {
      return generation;
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
      quotaError = null;
      inferenceRetry = null;
      if (status !== "running" && status !== "blocked") {
        // Quota exhaustion leaves status at "failed" while auto-retry is armed;
        // still land in a terminal stopped state so ESC/Ctrl+C can dismiss the wait.
        if (status === "failed") {
          stopRequested = true;
          status = "stopped";
          awaitingResponse = false;
          settleProcessingChrome();
          finishedAt = Date.now();
          finalizeOutstandingToolCalls();
          activeToolCallIds.clear();
        }
        return;
      }
      stopRequested = true;
      status = "stopped";
      awaitingResponse = false;
      settleProcessingChrome();
      finishedAt = Date.now();
      finalizeOutstandingToolCalls();
      activeToolCallIds.clear();
    },
    markRunning(): void {
      // A fresh send revives the loop after it settled (done/stopped/failed).
      // Clear any gate count left over from an aborted-while-gated prior run so
      // the new run never starts wedged in "blocked".
      stopRequested = false;
      gateCount = 0;
      activeToolCallIds.clear();
      quotaError = null;
      inferenceRetry = null;
      status = "running";
      finishedAt = null;
      awaitingResponse = true;
      isProcessing = true;
      // A fresh send (re)enters the awaiting-response gap; restart the stall
      // clock so a send following a long idle stretch is not aborted on the
      // watchdog's first tick against a stale timestamp.
      lastActivityAt = Date.now();
    },
    appendUserMessage(content: string): void {
      ensureUserBlock(content);
    },
    clear(): void {
      contentBlocks.length = 0;
      contentBlocksDirty = true;
      hooksDirty = true;
      blockSeq = 0;
      generation += 1;
      trimmedBlockCount = 0;
      callIdToName.clear();
      callIdToArguments.clear();
      activeToolCallIds.clear();
      pendingBlock = null;
      pendingField = null;
      pendingFragments = [];
      turnsUsed = 0;
      status = "idle";
      stopRequested = false;
      hadTextDeltaSinceLastReply = false;
      awaitingResponse = false;
      isProcessing = false;
      latestUserMessage = "";
      latestUserMessageLogged = true;
      tasks = [];
      subAgents = [];
      quotaError = null;
      inferenceRetry = null;
      currentPlanStep = null;
      planTotal = null;
      planDeviated = false;
      currentToolName = null;
      streamingType = null;
      gateCount = 0;
      startedAt = Date.now();
      finishedAt = null;
      openCallId = null;
      attemptStartBlockIndex = null;
      attemptStartCallIds = new Set();
      errorRollbackHandoff = null;
      resolvedCallIds = new Set();
      activityTick = 0;
      lastActivityAt = Date.now();
      contextTokens = 0;
      faremeter = makeFaremeter();
    },
    hydrateHistory(blocks: ContentBlockData[]): void {
      // Resumed-session history lands after first paint. Prepend it so past
      // turns sit ahead of anything already streamed into the fresh transcript.
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block !== undefined) unshiftBlock(block);
      }
      // The serial-pushBlock resume path trimmed to MAX_RETAINED_BLOCKS as it
      // went; prepending bypasses that, so enforce the cap now. trimOldestBlocks
      // splices from the front, dropping the oldest prepended history and keeping
      // the most recent turns — matching the old invariant and avoiding a mass
      // collapse on the user's first post-resume message.
      trimOldestBlocks();
      for (const block of contentBlocks) {
        if (block.type === "tasks") tasks = [...block.tasks];
        if (block.type === "plan") {
          planTotal = block.steps.length;
          currentPlanStep = block.steps.length > 0 ? 0 : null;
          planDeviated = false;
        }
      }
    },
    addEvent(event: ReactorEmittedEvent): void {
      // Settle any buffered stream fragments before a structural event runs, so
      // handlers that read the last block's content or arguments never see a
      // half-drained buffer.
      if (!STREAM_DELTA_TYPES.has(event.type)) flushPending();
      // The handoff only survives from an inference.error to the very next
      // event; consume it here so any event other than inference.retry
      // (a user message, the next cycle's start, ...) discards it.
      const precedingErrorRollback = event.type === "inference.retry" ? errorRollbackHandoff : null;
      errorRollbackHandoff = null;
      switch (event.type) {
        case "message.received": {
          const data = event.data as { message: { content?: string; attachments?: Array<{ name: string; contentType: string }> } };
          const content = data.message.content ?? "";
          const attachments = data.message.attachments ?? [];
          const attachmentText = attachments.length > 0
            ? `\n[Attached ${attachments.length} image${attachments.length === 1 ? "" : "s"}: ${attachments.map((att) => att.name).join(", ")}]`
            : "";
          const full = `${content}${attachmentText}`;
          // The rollback boundary must never straddle a user block: any
          // later retry retracting across it would erase the user's message.
          attemptStartBlockIndex = null;
          ensureUserBlock(full);
          break;
        }
        case "inference.start": {
          inferenceRetry = null;
          attemptStartBlockIndex = contentBlocks.length;
          attemptStartCallIds = new Set(callIdToName.keys());
          resolvedCallIds = new Set();
          break;
        }
        case "inference.retry": {
          {
            const retryData = event.data as {
              attempt: number;
              delayMs: number;
            };
            inferenceRetry = {
              attempt: retryData.attempt,
              delayMs: retryData.delayMs,
              retryAt: Date.now() + retryData.delayMs,
            };
          }
          // A retry directly after a terminal inference.error is the
          // reactor's committed-retry: re-arm from the handoff so the
          // failed attempt (and its rendered error line) is retracted.
          if (attemptStartBlockIndex === null && precedingErrorRollback !== null) {
            attemptStartBlockIndex = precedingErrorRollback.blockIndex;
            attemptStartCallIds = precedingErrorRollback.callIds;
          }
          if (attemptStartBlockIndex !== null) {
            spliceBlocks(attemptStartBlockIndex, contentBlocks.length - attemptStartBlockIndex);
            for (const callId of callIdToName.keys()) {
              if (!attemptStartCallIds.has(callId)) {
                callIdToName.delete(callId);
                callIdToArguments.delete(callId);
                activeToolCallIds.delete(callId);
              }
            }
            awaitingResponse = activeToolCallIds.size === 0;
            // Drop strip-fallback entries for tool calls that were rolled back
            // with this attempt. Without this, a streamed task tool_call that
            // never executed leaves a permanent "doing" Agents ghost.
            subAgents = subAgents.filter((a) => attemptStartCallIds.has(a.id));
            attemptStartBlockIndex = null;
            openCallId = null;
            currentToolName = null;
            streamingType = null;
          }
          break;
        }
        case "inference.done": {
          // The cycle's streamed content is settled; disarm the rollback
          // boundary so a harness pre-commit retry for the *next* cycle
          // (which arrives before that cycle's inference.start) cannot
          // splice away this cycle's blocks.
          attemptStartBlockIndex = null;
          break;
        }
        case "inference.thinking.delta": {
          awaitingResponse = false;
          streamingType = "thinking";
          markActivity();
          const token = (event.data as { token: string }).token;
          const last = contentBlocks[contentBlocks.length - 1];
          if (!last || last.type !== "thinking") {
            flushPending();
            pushBlock({ type: "thinking", content: "" });
          }
          bufferFragment(contentBlocks[contentBlocks.length - 1]!, "content", MAX_STORED_ASSISTANT_BLOCK_CHARS, token);
          break;
        }
        case "inference.text.delta": {
          awaitingResponse = false;
          streamingType = "text";
          hadTextDeltaSinceLastReply = true;
          markActivity();
          const token = (event.data as { token: string }).token;
          const last = contentBlocks[contentBlocks.length - 1];
          if (!last || last.type !== "text") {
            flushPending();
            pushBlock({ type: "text", content: "" });
          }
          bufferFragment(contentBlocks[contentBlocks.length - 1]!, "content", MAX_STORED_ASSISTANT_BLOCK_CHARS, token);
          break;
        }
        case "inference.tool_call.start": {
          awaitingResponse = false;
          const data = event.data as { name: string; callId: string };
          activeToolCallIds.add(data.callId);
          currentToolName = data.name;
          streamingType = "tool";
          callIdToName.set(data.callId, data.name);
          callIdToArguments.set(data.callId, "");
          openCallId = data.callId;
          pushBlock({ type: "tool_call", callId: data.callId, name: data.name, arguments: "", startedAt: Date.now() });
          break;
        }
        case "inference.tool_call.delta": {
          markActivity();
          const fragment = (event.data as { argumentFragment: string }).argumentFragment;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last && last.type === "tool_call") {
            bufferFragment(last, "arguments", MAX_STORED_TOOL_ARGUMENT_CHARS, fragment);
          }
          break;
        }
        case "inference.tool_call.end": {
          awaitingResponse = false;
          streamingType = "tool";
          const data = event.data as { name: string; callId: string; arguments?: unknown };
          currentToolName = data.name;
          callIdToName.set(data.callId, data.name);
          const last = contentBlocks[contentBlocks.length - 1];
          // The streamed fragments live on the open tool_call block (flushed just
          // above), so that block is the single accumulator; the final arguments
          // payload, when present, supersedes the streamed text.
          const streamedArguments = last?.type === "tool_call" && last.callId === data.callId ? last.arguments : "";
          const rawArgumentText = data.arguments === undefined ? streamedArguments : stringifyToolArguments(data.arguments);
          const argumentText = capStoredToolArguments(rawArgumentText);
          callIdToArguments.set(data.callId, argumentText);
          openCallId = null;
          if (last?.type === "tool_call" && last.name === data.name) {
            if (argumentText.length > 0) last.arguments = argumentText;
            contentBlocksDirty = true;
          } else {
            pushBlock({ type: "tool_call", callId: data.callId, name: data.name, arguments: argumentText, startedAt: Date.now() });
          }
          if (data.name === "task") {
            subAgents = updateSubAgent(subAgents, data.callId, {
              title: parseTaskToolTitle(argumentText),
              status: "doing",
            });
          }
          break;
        }
        case "connector.reply": {
          const replyData = event.data as { content: string };
          if (!hadTextDeltaSinceLastReply && replyData.content.length > 0) {
            const last = contentBlocks[contentBlocks.length - 1];
            if (last && last.type === "text") {
              last.content = capStoredAssistantContent(last.content + replyData.content);
              contentBlocksDirty = true;
            } else {
              pushBlock({ type: "text", content: capStoredAssistantContent(replyData.content) });
            }
          }
          hadTextDeltaSinceLastReply = false;
          awaitingResponse = false;
          if (activeToolCallIds.size === 0 && !subAgents.some((a) => a.status === "doing")) {
            isProcessing = false;
          }
          break;
        }
        case "tool.done": {
          const result = (event.data as { result: { callId: string; content: unknown; isError: boolean } }).result;
          activeToolCallIds.delete(result.callId);
          awaitingResponse = activeToolCallIds.size === 0;
          // Restart the stall clock only once every sibling result is in and
          // the reactor is genuinely waiting to infer again.
          if (awaitingResponse) lastActivityAt = Date.now();
          currentToolName = null;
          streamingType = null;
          // A retried inference cycle (or any other re-emission upstream) can
          // deliver the same tool.done twice; the call already has a result
          // block, so a second one would render as a duplicate transcript
          // line. Scoped to the current cycle because index-based providers
          // reuse callIds across cycles.
          if (resolvedCallIds.has(result.callId)) break;
          resolvedCallIds.add(result.callId);
          const trackedName = callIdToName.get(result.callId);
          const name = trackedName ?? result.callId;
          const content = capStoredToolResultContent(stringifyToolContent(result.content));

          // Prefer name === "task"; also match by callId so a lost callId→name
          // map (retry rollback, partial bookkeeping) cannot leave a "doing" ghost.
          const rawArgs = callIdToArguments.get(result.callId) ?? "";
          subAgents = settleSubAgentOnToolResult(
            subAgents,
            result.callId,
            trackedName,
            result.isError,
            parseTaskToolTitle(rawArgs),
          );

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
            const validated = validateView(parsePresentViewFromArgs(rawArgs));
            let presentCallIndex = -1;
            for (let i = contentBlocks.length - 1; i >= 0; i--) {
              const b = contentBlocks[i];
              if (b?.type === "tool_call" && b.name === "present") {
                presentCallIndex = i;
                break;
              }
            }
            if (!validated.ok) {
              if (presentCallIndex >= 0) {
                spliceBlocks(presentCallIndex, 1);
              }
              pushBlock({
                type: "tool_result",
                callId: result.callId,
                name: "present",
                content: `present view validation failed: ${validated.error}`,
                isError: true,
              });
              break;
            }
            if (presentCallIndex >= 0) {
              spliceBlocks(presentCallIndex, 1);
            }
            pushBlock({ type: "view", node: validated.node });
            break;
          }

          callIdToName.delete(result.callId);
          callIdToArguments.delete(result.callId);

          pushBlock({
            type: "tool_result",
            callId: result.callId,
            name,
            content,
            isError: result.isError,
            finishedAt: Date.now(),
          });
          if (
            activeToolCallIds.size === 0 &&
            !subAgents.some((a) => a.status === "doing") &&
            inferenceRetry === undefined
          ) {
            isProcessing = false;
          }
          break;
        }
        case "reactor.error": {
          const data = event.data as { fatal: boolean; error: string };
          pushBlock({ type: "error", message: data.error });
          break;
        }
        case "inference.error": {
          // Terminal for this attempt: disarm the boundary so it cannot leak
          // into a later cycle, but hand it off in case the reactor follows
          // up immediately with a committed-retry inference.retry.
          if (attemptStartBlockIndex !== null) {
            errorRollbackHandoff = { blockIndex: attemptStartBlockIndex, callIds: attemptStartCallIds };
            attemptStartBlockIndex = null;
          }
          const err = (event.data as {
            error: {
              category: string;
              message: string;
              retryAfterMs?: number;
              statusCode?: number;
              raw?: unknown;
            };
          }).error;
          const friendly: Record<string, string> = {
            // The App opens the OAuth re-login modal on this category; keep the
            // transcript line short and free of raw 401 JSON from the provider.
            credential_failure: "Session expired — re-authenticating…",
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
          const classified: {
            category: string;
            message: string;
            statusCode?: number;
            raw?: unknown;
          } = {
            category,
            message: err.message,
            ...(err.statusCode !== undefined ? { statusCode: err.statusCode } : {}),
            ...(err.raw !== undefined ? { raw: err.raw } : {}),
          };
          const msg = isGatewayOverloadInferenceError(classified)
            ? gatewayOverloadUserMessage(classified)
            : (friendly[category] ?? err.message);
          // The director immediately continues recoverable attempts; rendering an
          // error here would flash a terminal-looking failure during recovery.
          if (!isNonTerminalInferenceError(classified)) {
            pushBlock({ type: "error", message: msg });
          }
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
        inferenceRetry = null;
        status = stopRequested ? "stopped" : "done";
        finishedAt = Date.now();
        awaitingResponse = false;
        settleProcessingChrome();
        // A clean done resolves every tool_call in order, but a stopped run may
        // leave one dangling; settle it so it stops rendering as running.
        if (stopRequested) finalizeOutstandingToolCalls();
      }

      if (event.type === "reactor.error" || event.type === "inference.error") {
        // Only a terminal error ends the run. A reactor.error carries an explicit
        // fatal flag; a retryable/aborted inference error is transient and the
        // reactor will retry, so flipping to "failed" and synthesizing aborted
        // results for in-flight tool calls would wrongly settle a run that is
        // about to resume.
        const terminal =
          event.type === "reactor.error"
            ? (event.data as { fatal: boolean }).fatal === true
            : !isNonTerminalInferenceError(
                (event.data as {
                  error: {
                    category: string;
                    message: string;
                    statusCode?: number;
                    raw?: unknown;
                  };
                }).error,
              );
        if (terminal) {
          inferenceRetry = null;
          status = "failed";
          finishedAt = Date.now();
          awaitingResponse = false;
          settleProcessingChrome();
          finalizeOutstandingToolCalls();
        }
      }
    },
    addHookEvent(event: LifecycleHookEvent): void {
      switch (event.type) {
        case "hooks.loaded": {
          hooksById.clear();
          for (const hook of event.hooks) {
            hooksById.set(hook.id, { ...hook });
          }
          hooksDirty = true;
          break;
        }
        case "hook.updated": {
          hooksById.set(event.hook.id, { ...event.hook });
          hooksDirty = true;
          break;
        }
      }
    },
    noteSubAgentProgress(info: { description: string; toolName: string }): void {
      lastActivityAt = Date.now();
      activityTick++;
      // Show the worker's current tool in the status bar so a long-running
      // task does not look stalled while the parent is blocked on its result.
      currentToolName = info.toolName;
      streamingType = "tool";
      // Annotate matching Agents-strip entries with the live tool name.
      // Title is "agent: description"; match on the description suffix and
      // rewrite the trailing " · tool" annotation without losing the base.
      subAgents = subAgents.map((a) => {
        if (a.status !== "doing") return a;
        const base = a.title.includes(" · ")
          ? a.title.slice(0, a.title.lastIndexOf(" · "))
          : a.title;
        if (base === info.description || base.endsWith(`: ${info.description}`)) {
          return { ...a, title: `${base} · ${info.toolName}` };
        }
        return a;
      });
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

export type AgentStreamView = AgentStreamState & { displayRevision: number };

export function useAgentStream(
  emitter: EventEmitter,
  initialHooks: LifecycleHookStatus[] = [],
  getModel?: () => string,
  onInferenceTimeout?: () => void,
  initialContentBlocks: ContentBlockData[] = [],
  onCredentialFailure?: () => void,
): AgentStreamView {
  // getModel is read live by the faremeter's pricing resolver, so a
  // mid-session model switch is priced correctly without recreating the state.
  const [state] = useState(() => createAgentStreamState(initialHooks, getModel, initialContentBlocks));
  const [tick, setTick] = useState(0);
  const [displayRevision, setDisplayRevision] = useState(0);
  const onInferenceTimeoutRef = useRef(onInferenceTimeout);
  onInferenceTimeoutRef.current = onInferenceTimeout;
  const onCredentialFailureRef = useRef(onCredentialFailure);
  onCredentialFailureRef.current = onCredentialFailure;
  const pendingRenderRef = useRef(false);
  const pendingLineRevisionRef = useRef(false);

  const bumpDisplayRevision = (): void => {
    pendingLineRevisionRef.current = false;
    setDisplayRevision((r) => r + 1);
  };

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

  // Line layout is heavier than chrome updates; coalesce it during token streaming.
  useEffect(() => {
    const interval = setInterval(() => {
      if (pendingLineRevisionRef.current) {
        bumpDisplayRevision();
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (event: ReactorEmittedEvent) => {
      state.addEvent(event);
      if (TOKEN_EVENTS.has(event.type)) {
        pendingRenderRef.current = true;
        pendingLineRevisionRef.current = true;
      } else {
        setTick((t) => t + 1);
        bumpDisplayRevision();
      }
      if (event.type === "inference.error") {
        const category = (event.data as { error: { category: string } }).error.category;
        if (category === "timeout") onInferenceTimeoutRef.current?.();
        if (category === "credential_failure") onCredentialFailureRef.current?.();
      }
    };
    const hookHandler = (event: LifecycleHookEvent) => {
      state.addHookEvent(event);
      setTick((t) => t + 1);
      bumpDisplayRevision();
    };
    const progressHandler = (info: { description: string; toolName: string }) => {
      state.noteSubAgentProgress(info);
      // Progress is infrequent (per tool call), so render immediately rather
      // than waiting on the token drain interval.
      setTick((t) => t + 1);
      bumpDisplayRevision();
    };
    const hydrateHandler = (blocks: ContentBlockData[]) => {
      state.hydrateHistory(blocks);
      setTick((t) => t + 1);
      bumpDisplayRevision();
    };
    emitter.on("event", handler);
    emitter.on("hook", hookHandler);
    emitter.on("subagent.progress", progressHandler);
    emitter.on("history.hydrate", hydrateHandler);
    return () => {
      emitter.off("event", handler);
      emitter.off("hook", hookHandler);
      emitter.off("subagent.progress", progressHandler);
      emitter.off("history.hydrate", hydrateHandler);
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

  return useMemo(
    () => Object.assign(Object.create(state), { displayRevision }),
    [state, displayRevision],
  );
}
