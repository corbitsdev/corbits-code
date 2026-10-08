/**
 * Text shaping for the decision overlay — the permission approval and the
 * operator question.
 *
 * It is the one framed surface in the shell, shown exactly when a human is
 * asked to authorize something, so the body is shaped rather than listed: a
 * dithered header carries the subject, air separates it from the context
 * rows, and a trailing blank row keeps the choices off the question. All
 * consequence text lives in the body; the choices are bare action names
 * painted by the overlay list.
 *
 * Wrapping is on word boundaries. An over-long token (a path, a URL) breaks
 * at a separator the reader already parses as a boundary, never blind at
 * the column.
 */

import { prefixIndexForWidth, stringWidth } from "./view/height.js";
import { UI } from "./theme.js";

/** House ordered-dither ramp, sparsest-first, leading the header. */
export const DECISION_DITHER = "░▒▓";

/**
 * Display rows every choice occupies, wrapped or not: one label row plus one
 * row of air, so the list breathes and list index arithmetic stays a simple
 * multiple.
 */
export const DECISION_CHOICE_ROWS = 2;

/** Narrowest line this module will shape text into. */
const MIN_WRAP_WIDTH = 4;

const HEADER_PREFIX = `${DECISION_DITHER} `;

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
  const cut =
    window > 0
      ? window
      : String.fromCodePoint(token.codePointAt(0) ?? 32).length;
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
export function wrapOverlayText(
  text: string,
  width: number,
  maxLines: number,
): string[] {
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
 * about, or the operator's question — and the only thing wearing the action
 * color; everything below it is context. A trailing blank row keeps the
 * choice list off the question.
 *
 * `contextLines` budgets the context rows only; the header and air rows are
 * charged on top of it, so shaping never costs a row of the command being
 * approved.
 */
export function composeDecisionBody(
  text: string,
  width: number,
  contextLines: number,
): OverlayBodyRow[] {
  // Zero is a valid budget: on a terminal too short for air plus context
  // above the header, the context drops entirely — the choices win the row.
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
      text:
        i === 0
          ? `${HEADER_PREFIX}${line}`
          : `${" ".repeat(prefixWidth)}${line}`,
      fg: UI.action,
    });
  });

  const rest =
    budget > 0
      ? lines.slice(headIndex + 1).filter((l) => l.trim().length > 0)
      : [];
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
    // The last source line carries the notice and the expand affordance, so
    // when the budget cannot hold everything it keeps a row — dropping it
    // would hide that there is more to inspect before approving.
    const truncated = flat.length > budget && rest.length > 1 && budget >= 3;
    const tail = truncated ? (wrapped[wrapped.length - 1]?.[0] ?? null) : null;
    const head = flat.slice(0, tail === null ? budget : budget - 2);
    for (const line of head) rows.push({ text: line, fg: UI.text });
    if (tail !== null) {
      // Elided rows are announced, never silent: a segment that fell off the
      // bottom must stay visibly missing (the transcript holds it whole).
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

/** Below this overlay width the description zone has no room to say anything legible. */
const DESCRIPTION_ZONE_MIN_WIDTH = 16;
/** Below this overlay width the zone keeps `what` only and drops `impact`. */
const DESCRIPTION_ZONE_IMPACT_MIN_WIDTH = 32;

/** Content lines the description zone paints below the rule (what, impact). */
export const DESCRIPTION_ZONE_LINES = 2;

/**
 * Shape a description into its fixed two content rows.
 *
 * `what` fills the budget first; `impact` gets whatever is left, so a `what`
 * that wraps to both lines drops `impact` the same way a narrow overlay
 * does — one budget, one degrade path. `null` (no description, or too
 * narrow) still renders two blank rows: the reservation is fixed whenever
 * `describe` is set, whether or not this item has anything to say.
 */
export function describeZoneLines(
  desc: {
    readonly what: string;
    readonly impact?: string;
    readonly tone?: "plain" | "consequence";
  } | null,
  width: number,
): { readonly lines: readonly string[]; readonly fgs: readonly string[] } {
  const lines: string[] = [];
  const fgs: string[] = [];
  if (desc !== null && width >= DESCRIPTION_ZONE_MIN_WIDTH) {
    for (const line of wrapWords(desc.what, width)) {
      if (lines.length >= DESCRIPTION_ZONE_LINES) break;
      lines.push(line);
      fgs.push(UI.textDim);
    }
    if (
      desc.impact !== undefined &&
      width >= DESCRIPTION_ZONE_IMPACT_MIN_WIDTH
    ) {
      const impactFg = desc.tone === "consequence" ? UI.warning : UI.textFaint;

      for (const line of wrapWords(desc.impact, width)) {
        if (lines.length >= DESCRIPTION_ZONE_LINES) break;
        lines.push(line);
        fgs.push(impactFg);
      }
    }
  }
  while (lines.length < DESCRIPTION_ZONE_LINES) {
    lines.push("");
    fgs.push(UI.textFaint);
  }
  return { lines, fgs };
}

/**
 * Context rows a decision overlay's body may occupy on a terminal with room
 * to spare. The shaped body charges its header and its two rows of air on
 * top of this (see composeDecisionBody).
 */
const DECISION_CONTEXT_ROWS = 8;

/**
 * Rows the shaped body always spends, budget or not: one header line plus
 * the trailing blank row. Approximate (a wrapping header costs one more);
 * an underestimate only makes `decisionContextBudget` more generous, and
 * the fraction cap downstream catches overshoot.
 */
const DECISION_HEADER_AND_TRAILER_ROWS = 2;

/**
 * Extra rows a non-zero context budget costs on top of the header/trailer:
 * the blank row of air between the header and the context lines themselves.
 */
const DECISION_CONTEXT_BLANK_ROWS = 1;

/**
 * Shrink the decision body's context budget so its chrome never crowds out
 * what this guarantees down to a 10-row terminal: at least one choice row,
 * with the prompt box still seated at its floor. A generous fixed budget
 * reads fine on a tall terminal but can consume the whole overlay host on a
 * short one — so the context shrinks first, dropping entirely on the
 * shortest terminals, since an approval cannot render without the header
 * and the choices.
 *
 * Below 10 rows this budget cannot save the frame: the resolver falls back
 * to best effort (`resolveGeometry` in geometry/resolve.ts) and may take
 * rows from below the prompt floor.
 */
export function decisionContextBudget(input: {
  readonly terminalHeight: number;
  readonly overlayRowsPerItem: number;
  readonly overlayTitleRows: number;
  readonly overlayHostBorderRows: number;
  readonly overlayMaxFraction: number;
  readonly promptBaseRows: number;
}): number {
  const fixedChrome =
    input.overlayHostBorderRows +
    input.overlayTitleRows +
    DECISION_HEADER_AND_TRAILER_ROWS;
  // The resolver never lets the overlay host past the fraction cap even when
  // the transcript floor and every other zone have already given up their
  // rows, so that cap — not just the prompt floor — bounds how much context
  // this budget can safely ask for.
  const fracCap = Math.floor(input.terminalHeight * input.overlayMaxFraction);
  const maxOverlayRows = Math.min(
    input.terminalHeight - input.promptBaseRows,
    fracCap,
  );
  const baseline =
    maxOverlayRows -
    input.overlayRowsPerItem -
    fixedChrome -
    DECISION_CONTEXT_BLANK_ROWS;
  return Math.max(0, Math.min(DECISION_CONTEXT_ROWS, baseline));
}

/**
 * Plain-English echo of an accepted choice. A cycled settings field's label
 * carries every option with `‹ ›` around the active one, so the caller
 * passes the winning value via `itemValues` rather than parsing the label —
 * a marker or spacing change, or a label containing `‹`/`›`, would corrupt
 * the echo. A plain list item has no separate value, so it is quoted as-is.
 */
export function overlayChoiceText(
  label: string,
  id: string | undefined,
  value: string | undefined,
): string {
  if (value === undefined) return `Chose ${label.trim()}.`;
  const field = id === undefined ? "setting" : id.replace(/[-_]/g, " ");
  return `Set ${field} to ${value}.`;
}

/** Internal overlay kinds read as words in the transcript, not identifiers. */
export function overlayKindWord(kind: string): string {
  return kind.replace(/_/g, " ");
}
