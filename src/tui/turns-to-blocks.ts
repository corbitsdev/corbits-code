import type { ContentBlock as RuntimeContentBlock, ConversationTurn } from "@intx/types/runtime";

import { validateView } from "./view/index.js";
import {
  capStoredToolArguments,
  capStoredToolResultContent,
  type ContentBlockData,
} from "./use-stream.js";

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

  return out;
}