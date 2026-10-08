/**
 * Text shaping for the decision overlay (permission approval, operator
 * question): the one framed surface shown when a human is asked to
 * authorize. A dithered header carries the subject, air separates it from
 * the context rows, and a trailing blank row keeps the choices off the
 * question. Consequence text lives here; the choices are bare action names
 * painted by the overlay list. Wrapping is on word boundaries; an over-long
 * token (path, URL) breaks at a separator, never blind at the column.
 */

import { prefixIndexForWidth, stringWidth } from "./view/height.js";
import { UI } from "./theme.js";

/** House ordered-dither ramp, sparsest-first, leading the header. */
export const DECISION_DITHER = "░▒▓";

/**
 * Rows each choice occupies: label plus air, so list index arithmetic stays
 * a simple multiple.
 */
export const DECISION_CHOICE_ROWS = 2;

/** Narrowest line this module will shape text into. */
const MIN_WRAP_WIDTH = 4;

const HEADER_PREFIX = `${DECISION_DITHER} `;

/** Hanging indent on a wrapped continuation row. */
const CONTINUATION = "  ";

/**
 * Break points inside an over-long token, best first: separators a reader
 * parses as boundaries, then URL/flag-ish characters, then a blind cut.
 */
const PREFERRED_BREAKS = ["/", "\\"] as const;
const FALLBACK_BREAKS = ["-", "_", ".", ":", "=", "&", "?"] as const;

function splitLongToken(token: string, width: number): [string, string] {
  const limit = Math.max(1, Math.floor(width));
  // The window is the code-unit index where the column budget runs out.
  const window = prefixIndexForWidth(token, limit);
  for (const candidates of [PREFERRED_BREAKS, FALLBACK_BREAKS]) {
    let best = -1;
    for (const ch of candidates) {
      const idx = token.lastIndexOf(ch, Math.max(0, window - 1));
      if (idx > best) best = idx;
    }
    // Keep the separator on the leading half so every break makes progress.
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
 * Wrap one logical line at word boundaries. Continuation rows keep the
 * source line's leading indent so payload lines stay attached to their line.
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
 * Shape a decision body: the first non-empty line is the subject (tool or
 * operator question), the only row in the action color; the rest is context,
 * and a trailing blank row keeps the choices off the question. `contextLines`
 * budgets only context rows — header and air charge on top, so shaping never
 * costs a row of the command being approved.
 */
export function composeDecisionBody(
  text: string,
  width: number,
  contextLines: number,
): OverlayBodyRow[] {
  // Zero is valid: a very short terminal drops the context to save the choices.
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
    // Indent continuations so a wrapped segment is not read as another
    // command segment.
    const wrapped = rest.map((line) =>
      wrapWords(line, width - CONTINUATION.length).map((part, i) =>
        i === 0 ? part : `${CONTINUATION}${part}`,
      ),
    );
    const flat = wrapped.flat();
    // Keep the last source line (notice + expand affordance): dropping it
    // hides that more is left to inspect.
    const truncated = flat.length > budget && rest.length > 1 && budget >= 3;
    const tail = truncated ? (wrapped[wrapped.length - 1]?.[0] ?? null) : null;
    const head = flat.slice(0, tail === null ? budget : budget - 2);
    for (const line of head) rows.push({ text: line, fg: UI.text });
    if (tail !== null) {
      // Announce elided rows; a silent drop would hide that the body was cut.
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

/** Below this width the description zone cannot say anything legible. */
const DESCRIPTION_ZONE_MIN_WIDTH = 16;
/** Below this width the zone keeps `what` only. */
const DESCRIPTION_ZONE_IMPACT_MIN_WIDTH = 32;

/** Content lines the description zone paints below the rule (what, impact). */
export const DESCRIPTION_ZONE_LINES = 2;

/**
 * Shape a description into its fixed two content rows. `what` fills the
 * budget first; `impact` gets what is left, so a wrapping `what` drops
 * `impact` — one budget, one degrade path. Null still renders two blank
 * rows: the reservation is fixed whenever `describe` is set.
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
 * Context rows a decision body may use on a tall terminal; header and air
 * charge on top.
 */
const DECISION_CONTEXT_ROWS = 8;

/**
 * Rows the body always spends, budget or not: header plus trailing blank.
 * Approximate — an underestimate just makes the context budget more generous.
 */
const DECISION_HEADER_AND_TRAILER_ROWS = 2;

/**
 * Air row a non-zero context budget costs between header and context lines.
 */
const DECISION_CONTEXT_BLANK_ROWS = 1;

/**
 * Shrink the context budget so the chrome never crowds the choices or the
 * prompt floor down to a 10-row terminal: context shrinks first and drops
 * entirely on the shortest terminals, since an approval cannot render
 * without header and choices. Below 10 rows the resolver falls back to best
 * effort and may take rows from below the prompt floor.
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
  // The resolver caps the host by fraction even after every zone gave up its
  // rows, so that cap — not the prompt floor — bounds the safe context.
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
 * Plain-English echo of an accepted choice. Cycled settings pass the winning
 * value via `itemValues` — parsing the label would break on `‹ ›` markers or
 * spacing changes. A plain list item has no value, so it is quoted as-is.
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
