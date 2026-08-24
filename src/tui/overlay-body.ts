/**
 * Text shaping for the decision overlay — the permission approval and the
 * operator question.
 *
 * This is the one framed surface in the shell and the moment a human is asked
 * to authorize something, so it is shaped rather than listed: a dithered header
 * carrying the subject, air between the subject and the choices, and two rows
 * per choice so a long label wraps instead of clipping and short labels get
 * breathing room.
 *
 * Wrapping is on word boundaries. A token longer than the line (a path, a URL)
 * is broken deliberately — preferring a separator the reader already parses as
 * a boundary — rather than sliced blind at the column.
 */

import { middleEllipsis } from "./command-display.js";
import { prefixIndexForWidth, stringWidth } from "./view/height.js";
import { UI } from "./theme.js";

/** House ordered-dither ramp, sparsest-first, leading the header. */
export const DECISION_DITHER = "░▒▓";

/** Marker on the active choice. Solid: the densest cell of the same ramp. */
export const DECISION_ACTIVE_MARK = "█";

/**
 * Display rows every choice occupies, wrapped or not. One: the choices are a
 * single list, and a blank row between them reads as unrelated statements.
 */
export const DECISION_CHOICE_ROWS = 1;

/** Narrowest line this module will shape text into. */
const MIN_WRAP_WIDTH = 4;

const HEADER_PREFIX = `${DECISION_DITHER} `;
const CHOICE_INDENT = "  ";

/** Hanging indent on a wrapped continuation row. */
const CONTINUATION = "  ";

/**
 * Break points inside an over-long token, best first. A path separator wins
 * because a reader already parses it as a boundary; the second tier catches
 * URLs and flag-ish identifiers before falling back to a blind cut.
 */
const PREFERRED_BREAKS = ["/", "\\"] as const;
const FALLBACK_BREAKS = ["-", "_", ".", ":", "=", "&", "?"] as const;

function splitLongToken(token: string, width: number): [string, string] {
  const limit = Math.max(1, Math.floor(width));
  // The cut is a column budget, so the search window is the code-unit index
  // where that budget runs out — not the budget itself.
  const window = prefixIndexForWidth(token, limit);
  for (const candidates of [PREFERRED_BREAKS, FALLBACK_BREAKS]) {
    let best = -1;
    for (const ch of candidates) {
      const idx = token.lastIndexOf(ch, Math.max(0, window - 1));
      if (idx > best) best = idx;
    }
    // Keep the separator on the leading half, and require at least one
    // character before it so every break makes progress.
    if (best >= 1) return [token.slice(0, best + 1), token.slice(best + 1)];
  }
  // A single glyph wider than the whole budget still has to make progress.
  const cut = window > 0 ? window : String.fromCodePoint(token.codePointAt(0) ?? 32).length;
  return [token.slice(0, cut), token.slice(cut)];
}

/**
 * Wrap one logical line at word boundaries. Continuation rows keep the source
 * line's leading indent, so the indented payload lines of an expanded command
 * stay visually attached to their placeholder.
 */
export function wrapWords(text: string, width: number): string[] {
  const w = Math.max(MIN_WRAP_WIDTH, Math.floor(width));
  const trimmed = text.trim();
  if (trimmed.length === 0) return [""];

  const indent = text.slice(0, text.length - text.trimStart().length);
  const usable = (pad: string): string => (stringWidth(pad) > w - 2 ? "" : pad);

  const out: string[] = [];
  let pad = usable(indent);
  let line = "";
  const flush = (): void => {
    out.push(pad + line);
    line = "";
    pad = usable(indent);
  };

  for (const raw of trimmed.split(/\s+/)) {
    let word = raw;
    for (;;) {
      const lineWidth = stringWidth(line);
      const room = w - stringWidth(pad) - (lineWidth > 0 ? lineWidth + 1 : 0);
      if (stringWidth(word) <= room) {
        line = line.length > 0 ? `${line} ${word}` : word;
        break;
      }
      if (line.length > 0) {
        flush();
        continue;
      }
      const [head, rest] = splitLongToken(word, w - stringWidth(pad));
      line = head;
      flush();
      word = rest;
    }
  }
  if (line.length > 0) out.push(pad + line);
  return out.length > 0 ? out : [""];
}

/** Wrap a multi-line block, preserving blank lines, capped at `maxLines`. */
export function wrapOverlayText(text: string, width: number, maxLines: number): string[] {
  const cap = Math.max(1, Math.floor(maxLines));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (out.length >= cap) break;
    if (raw.trim().length === 0) {
      out.push("");
      continue;
    }
    for (const line of wrapWords(raw, width)) {
      if (out.length >= cap) break;
      out.push(line);
    }
  }
  return out.slice(0, cap);
}

/** A shaped overlay row: painted content plus the palette role it wears. */
export interface OverlayBodyRow {
  readonly text: string;
  readonly fg: string;
}

/**
 * Shape a decision body into rows.
 *
 * The first non-empty line of `text` is the subject — the tool being asked
 * about, or the operator's question — and is the one thing on screen wearing
 * the action color. Everything below it is context. A trailing blank row is
 * part of the body so the choice list never abuts the question.
 *
 * `contextLines` budgets the context rows only. The header and the two rows of
 * air are charged on top of it, so shaping never costs the operator a row of
 * the command they are being asked to approve.
 */
export function composeDecisionBody(
  text: string,
  width: number,
  contextLines: number,
): OverlayBodyRow[] {
  // Zero is a valid budget: on a terminal too short to spare a row of air
  // plus a line of context on top of the header, the context section is
  // dropped entirely rather than forced to cost at least one row it cannot
  // afford — the choices below it must win that row instead.
  const budget = Math.max(0, Math.floor(contextLines));
  const lines = text.split("\n");
  const headIndex = lines.findIndex((l) => l.trim().length > 0);
  if (headIndex < 0) return [];

  const rows: OverlayBodyRow[] = [];
  const prefixWidth = stringWidth(HEADER_PREFIX);
  const headerWidth = width - prefixWidth;
  const header = wrapWords(lines[headIndex] ?? "", headerWidth);
  header.forEach((line, i) => {
    rows.push({
      text: i === 0 ? `${HEADER_PREFIX}${line}` : `${" ".repeat(prefixWidth)}${line}`,
      fg: UI.action,
    });
  });

  const rest = budget > 0 ? lines.slice(headIndex + 1).filter((l) => l.trim().length > 0) : [];
  if (rest.length > 0) {
    rows.push({ text: "", fg: UI.textDim });
    // Continuation rows are indented so a wrapped chain segment can never be
    // mistaken for a further segment of the command being approved.
    const wrapped = rest.map((line) =>
      wrapWords(line, width - CONTINUATION.length).map((part, i) =>
        i === 0 ? part : `${CONTINUATION}${part}`,
      ),
    );
    const flat = wrapped.flat();
    // The last source line carries the notice and the expand affordance. When
    // the budget cannot hold everything, that line keeps a row rather than
    // being the first thing dropped — losing it would hide from the operator
    // that there is more to inspect before approving.
    const truncated = flat.length > budget && rest.length > 1 && budget >= 3;
    const tail = truncated ? (wrapped[wrapped.length - 1]?.[0] ?? null) : null;
    const head = flat.slice(0, tail === null ? budget : budget - 2);
    for (const line of head) rows.push({ text: line, fg: UI.text });
    if (tail !== null) {
      // Elided rows are announced, never silently dropped: a chain segment that
      // fell off the bottom must still be visibly missing, and the transcript
      // holds the whole subject untruncated.
      const hidden = flat.length - head.length - 1;
      rows.push({
        text: `${DECISION_DITHER} ${hidden} more ${hidden === 1 ? "line" : "lines"} · full text in transcript`,
        fg: UI.inFlight,
      });
      rows.push({ text: tail, fg: UI.textDim });
    }
  }
  rows.push({ text: "", fg: UI.textDim });
  return rows;
}

/**
 * Shape one choice into its single row: the label, marked when active, and
 * ellipsized in the middle when it will not fit. Fixed height keeps the list
 * viewport's index arithmetic a simple multiple.
 */
export function decisionChoiceRows(
  label: string,
  active: boolean,
  width: number,
): OverlayBodyRow[] {
  const fg = active ? UI.text : UI.textDim;
  const inner = Math.max(1, width - stringWidth(CHOICE_INDENT));
  const text = stringWidth(label) > inner ? middleEllipsis(label, inner) : label;
  return [
    {
      text: `${active ? `${DECISION_ACTIVE_MARK} ` : CHOICE_INDENT}${text}`,
      fg,
    },
  ];
}
