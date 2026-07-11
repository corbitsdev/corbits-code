import type { ContentBlock as RuntimeContentBlock, ConversationTurn } from "@intx/types/runtime";

import { applyManageTasks, parseManageTasksArgs, type Task } from "../agent/tasks.js";
import { validateView } from "./view/index.js";
import {
  capStoredToolArguments,
  capStoredToolResultContent,
  type ContentBlockData,
} from "./use-stream.js";

type PlanBlockStep = { file: string; action: string; reason?: string };

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
  block: { type: "plan"; steps: PlanBlockStep[] } | { type: "tasks"; tasks: Task[] },
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

/** Mirror live-stream tool.done handling for plan/tasks when hydrating a session. */
function finalizeResumeToolBlocks(blocks: ContentBlockData[]): ContentBlockData[] {
  const callIdToCallIndex = new Map<string, number>();
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.type === "tool_call" && block.callId !== undefined) {
      callIdToCallIndex.set(block.callId, i);
    }
  }

  let tasks: Task[] = [];
  let planSteps: PlanBlockStep[] | null = null;
  const indicesToRemove = new Set<number>();

  for (let i = 0; i < blocks.length; i += 1) {
    const result = blocks[i];
    if (result?.type !== "tool_result" || result.isError) continue;
    const callIndex = callIdToCallIndex.get(result.callId);
    if (callIndex === undefined) continue;
    const call = blocks[callIndex];
    if (call?.type !== "tool_call") continue;

    if (call.name === "submit_plan") {
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
      continue;
    }

    if (call.name === "manage_tasks") {
      indicesToRemove.add(callIndex);
      indicesToRemove.add(i);
      let raw: unknown;
      try {
        raw = JSON.parse(call.arguments);
      } catch {
        continue;
      }
      const parsed = parseManageTasksArgs(raw);
      if (parsed !== null) {
        tasks = applyManageTasks(tasks, parsed);
      }
    }
  }

  let out = blocks.filter((_, index) => !indicesToRemove.has(index));
  if (planSteps !== null) {
    out = upsertResumeBlock(out, { type: "plan", steps: planSteps });
  }
  if (tasks.length > 0) {
    out = upsertResumeBlock(out, { type: "tasks", tasks });
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