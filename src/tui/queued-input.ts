import { sliceToWidth, stringWidth } from "./view/height.js";

export interface QueuedInputState {
  readonly messageIds: readonly string[];
}

export const NO_QUEUED_INPUT: QueuedInputState = { messageIds: [] };

export function acceptQueuedInput(
  state: QueuedInputState,
  messageId: string,
): QueuedInputState {
  if (messageId.length === 0 || state.messageIds.includes(messageId))
    return state;
  return { messageIds: [...state.messageIds, messageId] };
}

export function consumeQueuedInput(
  state: QueuedInputState,
  messageId: string,
): QueuedInputState {
  const index = state.messageIds.indexOf(messageId);
  if (index === -1) return state;
  return {
    messageIds: [
      ...state.messageIds.slice(0, index),
      ...state.messageIds.slice(index + 1),
    ],
  };
}

export function clearQueuedInput(state: QueuedInputState): QueuedInputState {
  return state.messageIds.length === 0 ? state : NO_QUEUED_INPUT;
}

export function queuedInputCount(state: QueuedInputState): number {
  return state.messageIds.length;
}

export type QueuedInputRole = "mark" | "label" | "separator" | "count";

export interface QueuedInputPart {
  readonly text: string;
  readonly role: QueuedInputRole;
}

/** One composer-adjacent row which retains its meaning even in narrow terminals. */
export function composeQueuedInputLine(
  state: QueuedInputState,
  width: number,
): readonly QueuedInputPart[] {
  if (width <= 0 || state.messageIds.length === 0) return [];
  const parts: readonly QueuedInputPart[] = [
    { text: "◆ ", role: "mark" },
    { text: "QUEUED INPUT", role: "label" },
    { text: " · ", role: "separator" },
    { text: String(state.messageIds.length), role: "count" },
  ];
  const text = parts.map((part) => part.text).join("");
  if (stringWidth(text) <= width) return parts;
  const compact = `QUEUED ${state.messageIds.length}`;
  if (stringWidth(compact) <= width) {
    return [
      { text: "QUEUED ", role: "label" },
      { text: String(state.messageIds.length), role: "count" },
    ];
  }
  return [{ text: sliceToWidth("QUEUED INPUT", width), role: "label" }];
}
