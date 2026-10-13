import {
  isPrimaryAskOperatorEvent,
  type OperatorGateEvent,
} from "./gate-events.js";
import { stripTerminalControlSequences } from "../util/control-char-strip.js";
import { sliceToWidth, stringWidth } from "./view/height.js";

export interface OperatorInputRequiredItem {
  readonly id: string;
  readonly question: string;
}

export interface OperatorInputRequiredState {
  readonly items: readonly OperatorInputRequiredItem[];
  readonly selectedId: string | null;
}

export const NO_OPERATOR_INPUT_REQUIRED: OperatorInputRequiredState = {
  items: [],
  selectedId: null,
};

export type OperatorInputRequiredRole =
  | "mark"
  | "label"
  | "routing"
  | "question"
  | "more"
  | "separator";

export interface OperatorInputRequiredPart {
  readonly text: string;
  readonly role: OperatorInputRequiredRole;
}

function sameItem(
  a: OperatorInputRequiredItem,
  b: OperatorInputRequiredItem,
): boolean {
  return a.id === b.id && a.question === b.question;
}

function selectedItem(
  state: OperatorInputRequiredState,
): OperatorInputRequiredItem | null {
  return state.items.find((item) => item.id === state.selectedId) ?? null;
}

/** Admit only marked primary asks, preserving insertion order by gate id. */
export function addOperatorInputRequired(
  state: OperatorInputRequiredState,
  event: OperatorGateEvent,
): OperatorInputRequiredState {
  if (
    !isPrimaryAskOperatorEvent(event) ||
    typeof event.id !== "string" ||
    event.id.length === 0
  ) {
    return state;
  }
  const item = { id: event.id, question: event.question };
  const index = state.items.findIndex((live) => live.id === event.id);
  if (index < 0) {
    return {
      items: [...state.items, item],
      selectedId: state.selectedId ?? event.id,
    };
  }
  const current = state.items[index];
  if (current !== undefined && sameItem(current, item)) return state;
  const items = [...state.items];
  items[index] = item;
  return { items, selectedId: state.selectedId };
}

/** Remove exactly one settled gate; unknown and repeated removals are no-ops. */
export function removeOperatorInputRequired(
  state: OperatorInputRequiredState,
  id: string,
): OperatorInputRequiredState {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return state;
  const items = state.items.filter((item) => item.id !== id);
  const selectedId =
    state.selectedId !== id ? state.selectedId : (items[0]?.id ?? null);
  return items.length === 0
    ? NO_OPERATOR_INPUT_REQUIRED
    : { items, selectedId };
}

export function operatorInputRequiredMoreCount(
  state: OperatorInputRequiredState,
): number {
  return Math.max(0, state.items.length - 1);
}

/** Prevent question content from claiming rows or terminal styling. */
export function operatorInputRequiredPreview(text: string): string {
  return stripTerminalControlSequences(text).replace(/\s+/g, " ").trim();
}

const MARK = "◆ ";
const LABEL = "INPUT REQUIRED";
const ROUTING = "operator answer needed";
const SEPARATOR = " · ";
const ELLIPSIS = "…";

function width(parts: readonly OperatorInputRequiredPart[]): number {
  return parts.reduce((total, part) => total + stringWidth(part.text), 0);
}

function fit(text: string, cells: number): string {
  if (stringWidth(text) <= cells) return text;
  if (cells <= stringWidth(ELLIPSIS)) return "";
  return `${sliceToWidth(text, cells - stringWidth(ELLIPSIS))}${ELLIPSIS}`;
}

/** One bounded semantic line, with content roles left for shell paint to theme. */
export function composeOperatorInputRequiredLine(
  state: OperatorInputRequiredState,
  cells: number,
): readonly OperatorInputRequiredPart[] {
  const item = selectedItem(state);
  if (item === null || cells <= 0) return [];
  const more = operatorInputRequiredMoreCount(state);
  const moreParts: OperatorInputRequiredPart[] =
    more > 0 ? [{ text: ` (+${more} more)`, role: "more" }] : [];
  const full: OperatorInputRequiredPart[] = [
    { text: MARK, role: "mark" },
    { text: LABEL, role: "label" },
    { text: SEPARATOR, role: "separator" },
    { text: ROUTING, role: "routing" },
  ];
  const question = operatorInputRequiredPreview(item.question);
  const room = cells - width(full) - stringWidth(SEPARATOR) - width(moreParts);
  if (question.length > 0 && room > stringWidth(ELLIPSIS)) {
    return [
      ...full,
      { text: SEPARATOR, role: "separator" },
      { text: fit(question, room), role: "question" },
      ...moreParts,
    ];
  }
  if (width(full) + width(moreParts) <= cells) return [...full, ...moreParts];
  const compact: OperatorInputRequiredPart[] = [
    { text: MARK, role: "mark" },
    { text: LABEL, role: "label" },
    ...moreParts,
  ];
  const result: OperatorInputRequiredPart[] = [];
  let remaining = cells;
  for (const part of compact) {
    const text = sliceToWidth(part.text, remaining);
    if (text.length === 0) break;
    result.push({ text, role: part.role });
    remaining -= stringWidth(text);
  }
  return result;
}
