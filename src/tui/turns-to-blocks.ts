import type { ContentBlock as RuntimeContentBlock, ConversationTurn } from "@intx/types/runtime";

import type { Task } from "../agent/tasks.js";
import { validateView, type ViewNode } from "./view/index.js";

type PlanBlockStep = { file: string; action: string; reason?: string };

export type ContentBlockData =
  | { type: "user"; content: string }
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call"; callId?: string; name: string; arguments: string; startedAt?: number }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean; finishedAt?: number }
  | { type: "reply"; content: string }
  | { type: "plan"; steps: PlanBlockStep[] }
  | { type: "view"; node: ViewNode }
  | { type: "error"; message: string };

// Ingress caps keep a single block from forcing a full-history wrap on every frame.
export const MAX_STORED_TOOL_RESULT_CHARS = 48_000;
export const MAX_STORED_TOOL_ARGUMENT_CHARS = 24_000;

// Tool output pays off at the end (exit codes, error summaries, test totals),
// so the kept window anchors on the tail. Arguments are head-anchored because
// the meaningful prefix (command path, opening flags) comes first.
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

function textFromBlocks(blocks: RuntimeContentBlock[]): string {
  const parts: string[] = [];
  let imageCount = 0;
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    if (block.type === "image") imageCount += 1;
  }
  if (imageCount > 0) {
    parts.push(`[Attached ${imageCount} image${imageCount === 1 ? "" : "s"}]`);
  }
  return parts.join("\n");
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

function upsertResumeBlock(
  blocks: ContentBlockData[],
  block: { type: "plan"; steps: PlanBlockStep[] },
): ContentBlockData[] {
  const next = [...blocks];
  const existing = next.findIndex((entry) => entry.type === block.type);
  if (existing === -1) {
    next.unshift(block);
  } else {
    next[existing] = block;
  }
  return next;
}

/**
 * Mirror live-stream tool.done handling when hydrating a session: submit_plan
 * collapses into a single plan block, and manage_tasks rows are dropped
 * entirely because the resumed task list is rendered as one aggregated block
 * (see hydrateTasksFromTurns) rather than as one row per call.
 */
function finalizeResumeToolBlocks(blocks: ContentBlockData[]): ContentBlockData[] {
  const callIdToCallIndex = new Map<string, number>();
  const callIdToResultIndex = new Map<string, number>();
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.type === "tool_call" && block.callId !== undefined) {
      callIdToCallIndex.set(block.callId, i);
    } else if (block?.type === "tool_result") {
      callIdToResultIndex.set(block.callId, i);
    }
  }

  let planSteps: PlanBlockStep[] | null = null;
  const indicesToRemove = new Set<number>();

  // manage_tasks strips regardless of its result's outcome, matching
  // applyManageTasksToolCall: the tool_call is the authoritative event, not
  // whatever the (side-effect-free) handler's tool_result happens to say —
  // so an errored or missing result must not leave the raw rows behind.
  for (let i = 0; i < blocks.length; i += 1) {
    const call = blocks[i];
    if (call?.type !== "tool_call" || call.name !== "manage_tasks") continue;
    indicesToRemove.add(i);
    const resultIndex = call.callId !== undefined ? callIdToResultIndex.get(call.callId) : undefined;
    if (resultIndex !== undefined) indicesToRemove.add(resultIndex);
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const result = blocks[i];
    if (result?.type !== "tool_result" || result.isError) continue;
    const callIndex = callIdToCallIndex.get(result.callId);
    if (callIndex === undefined) continue;
    const call = blocks[callIndex];
    if (call?.type !== "tool_call" || call.name !== "submit_plan") continue;

    indicesToRemove.add(callIndex);
    indicesToRemove.add(i);
    let steps: PlanBlockStep[] = [];
    try {
      const parsed = JSON.parse(call.arguments) as {
        steps?: Array<{ file: string; action: string; reason?: string }>;
      };
      if (Array.isArray(parsed.steps)) {
        steps = parsed.steps.map((s) => ({
          file: s.file,
          action: s.action,
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        }));
      }
    } catch {
      /* invalid args → empty plan */
    }
    planSteps = steps;
  }

  let out = blocks.filter((_, index) => !indicesToRemove.has(index));
  if (planSteps !== null) {
    out = upsertResumeBlock(out, { type: "plan", steps: planSteps });
  }
  return out;
}

export const RESUME_TRANSCRIPT_BLOCK_LIMIT = 2000;

type TurnsToContentBlocksOptions = {
  maxBlocks?: number;
};

function turnToContentBlocks(turn: ConversationTurn): ContentBlockData[] {
  const out: ContentBlockData[] = [];
  if (turn.role === "user") {
    const text = textFromBlocks(turn.content);
    if (text.length > 0) out.push({ type: "user", content: text });
    return out;
  }
  if (turn.role !== "assistant") return out;

  // Build a callId→name map so tool_result blocks can reference the tool name.
  const callIdToName = new Map<string, string>();
  for (const block of turn.content) {
    if (block.type === "tool_call") callIdToName.set(block.id, block.name);
  }

  for (const block of turn.content) {
    switch (block.type) {
      case "thinking":
        out.push({ type: "thinking", content: block.thinking });
        break;
      case "text":
        out.push({ type: "text", content: block.text });
        break;
      case "tool_call":
        out.push({
          type: "tool_call",
          callId: block.id,
          name: block.name,
          arguments: capStoredToolArguments(
            typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
          ),
        });
        break;
      case "tool_result": {
        const content = capStoredToolResultContent(stringifyToolContent(block.content));
        out.push({
          type: "tool_result",
          callId: block.callId,
          name: callIdToName.get(block.callId) ?? block.callId,
          content,
          isError: block.isError === true,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Best-effort transcript hydration when resuming a TUI session. */
export function turnsToContentBlocks(
  turns: ConversationTurn[],
  options: TurnsToContentBlocksOptions = {},
): ContentBlockData[] {
  const maxBlocks = options.maxBlocks ?? Infinity;

  // Collect turn-blocks newest-first (backward iteration with early exit so a
  // deep session only processes recent turns), then flatten oldest-first.
  // Building forward with unshift would be O(n²) — each unshift shifts every
  // accumulated element.
  const collected: ContentBlockData[][] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const blocks = turnToContentBlocks(turns[i]!);
    if (blocks.length === 0) continue;
    collected.push(blocks);
    total += blocks.length;
    if (total >= maxBlocks) break;
  }

  const out: ContentBlockData[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    out.push(...collected[i]!);
  }
  if (out.length > maxBlocks) out.splice(0, out.length - maxBlocks);

  // Collapse present tool calls into view blocks when args are still available.
  for (let i = 0; i < out.length; i++) {
    const block = out[i];
    if (block?.type !== "tool_call" || block.name !== "present") continue;
    try {
      const view = (JSON.parse(block.arguments) as { view?: unknown }).view;
      const validated = validateView(view);
      if (validated.ok) {
        out.splice(i, 1, { type: "view", node: validated.node });
      }
    } catch {
      // keep tool_call line
    }
  }

  return finalizeResumeToolBlocks(out);
}