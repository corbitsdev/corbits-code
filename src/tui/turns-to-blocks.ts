import type { ContentBlock as RuntimeContentBlock, ConversationTurn } from "@intx/types/runtime";

import { validateView } from "./view/index.js";
import type { ContentBlockData } from "./use-stream.js";

function textFromBlocks(blocks: RuntimeContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("");
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

/** Best-effort transcript hydration when resuming a TUI session. */
export function turnsToContentBlocks(turns: ConversationTurn[]): ContentBlockData[] {
  const out: ContentBlockData[] = [];

  for (const turn of turns) {
    if (turn.role === "user") {
      const text = textFromBlocks(turn.content);
      if (text.length > 0) out.push({ type: "user", content: text });
      continue;
    }
    if (turn.role !== "assistant") continue;

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
            arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
          });
          break;
        case "tool_result": {
          const content = stringifyToolContent(block.content);
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
  }

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