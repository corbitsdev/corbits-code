/**
 * URL click-through (CL-7346): Ctrl+click opens http(s) URLs in the
 * transcript's plain and structured text rows, and holding Ctrl over one
 * highlights it first.
 *
 * Markdown prose is out of scope: the library paints it through childless
 * code renderers with no stable text-leaf API to arm or hit-test, so
 * assistant-message links stay terminal business for now (see docs/TUI.md).
 *
 * The gesture is modifier-gated end to end. Without the modifier nothing here
 * runs: rows keep today's expand and selection behavior, and with mouse
 * capture off (Alt+M) the terminal owns every click because OpenTUI never
 * sees one. Only http(s) targets ever open; every other scheme is ignored.
 */
import {
  StyledText,
  TextAttributes,
  TextRenderable,
  bold as boldChunk,
  fg as fgChunk,
  link as linkChunk,
  underline as underlineChunk,
  type CliRenderer,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core";
import { stringWidth } from "./view/height.js";
import { UI } from "./theme.js";

/** A styled text run split so URL runs carry their target. */
export interface LinkSpan {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean | undefined;
  readonly url: string | null;
}

interface LinkHit {
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\]]+/gi;
const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "'",
  '"',
  "]",
  "}",
  ">",
]);

/**
 * Only http(s) targets ever open. Markdown authors can point a link at any
 * scheme (`javascript:`, `file:`, `mailto:`), so the gate parses rather than
 * prefix-matching.
 */
export function isOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** http(s) runs inside plain text, without trailing prose punctuation. */
export function findLinks(text: string): LinkHit[] {
  const hits: LinkHit[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let end = match.index + match[0].length;
    while (end > match.index) {
      const tail = text[end - 1];
      if (tail === undefined || !TRAILING_PUNCTUATION.has(tail)) break;
      end -= 1;
    }
    let depth = 0;
    for (let i = match.index; i < end; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") depth -= 1;
    }
    while (end > match.index && text[end - 1] === ")" && depth < 0) {
      end -= 1;
      depth += 1;
    }
    if (end > match.index)
      hits.push({ url: text.slice(match.index, end), start: match.index, end });
  }
  return hits;
}

/** Split styled segments so URL runs become their own spans. */
export function splitLinkSpans(
  segments: readonly { text: string; fg: string; bold?: boolean | undefined }[],
): LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const segment of segments) {
    const hits = findLinks(segment.text);
    if (hits.length === 0) {
      spans.push({
        text: segment.text,
        fg: segment.fg,
        bold: segment.bold,
        url: null,
      });
      continue;
    }
    let cursor = 0;
    for (const hit of hits) {
      if (hit.start > cursor)
        spans.push({
          text: segment.text.slice(cursor, hit.start),
          fg: segment.fg,
          bold: segment.bold,
          url: null,
        });
      spans.push({
        text: hit.url,
        fg: segment.fg,
        bold: segment.bold,
        url: hit.url,
      });
      cursor = hit.end;
    }
    if (cursor < segment.text.length)
      spans.push({
        text: segment.text.slice(cursor),
        fg: segment.fg,
        bold: segment.bold,
        url: null,
      });
  }
  return spans;
}

/** Native chunks for one span: link spans carry OSC-8 metadata. */
export function linkSpanChunks(
  span: LinkSpan,
  highlighted: boolean,
): TextChunk[] {
  let chunk = fgChunk(span.fg)(span.text);
  if (span.bold === true) chunk = boldChunk(chunk);
  if (span.url !== null) chunk = linkChunk(span.url)(chunk);
  if (highlighted && span.url !== null)
    chunk = underlineChunk(fgChunk(UI.inFlightBright)(chunk));
  return [chunk];
}

/**
 * The open gesture: left press while Ctrl is held. Cmd on macOS is the
 * terminal's own OSC-8 click (it handles Cmd+click itself and the app never
 * sees the press); Ctrl is what SGR mouse reports carry on every platform.
 */
export function isUrlOpenClick(
  event: Pick<MouseEvent, "button" | "modifiers">,
): boolean {
  return event.button === 0 && event.modifiers.ctrl === true;
}

export type UrlOpener = (url: string) => void;

function defaultUrlOpener(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }).unref();
  } catch {
    // Fire-and-forget from a hover/click handler with no status line to
    // report to; a missing opener must not break the transcript.
  }
}

let currentOpener: UrlOpener = defaultUrlOpener;

/** Test seam: swap the browser opener, `resetUrlOpener` restores it. */
export function setUrlOpener(opener: UrlOpener): void {
  currentOpener = opener;
}

export function resetUrlOpener(): void {
  currentOpener = defaultUrlOpener;
}

/** Open an http(s) URL in the default browser; anything else is ignored. */
export function openUrl(url: string): void {
  if (!isOpenableUrl(url)) return;
  try {
    currentOpener(url);
  } catch {
    // Same fire-and-forget contract as the default opener above.
  }
}

/**
 * One painted line's openable-URL column ranges. Every armed text node keeps
 * a single text node shape — retext and selection never see anything else —
 * and resolves clicks through these ranges instead.
 */
export interface LinkColumnHit {
  readonly url: string;
  /** Inclusive column where the URL starts. */
  readonly start: number;
  /** Exclusive column where it ends. */
  readonly end: number;
}

/** Column ranges of the openable URLs across one line's spans. */
export function linkColumnHits(spans: readonly LinkSpan[]): LinkColumnHit[] {
  const hits: LinkColumnHit[] = [];
  let column = 0;
  for (const span of spans) {
    const width = stringWidth(span.text);
    if (span.url !== null && isOpenableUrl(span.url))
      hits.push({ url: span.url, start: column, end: column + width });
    column += width;
  }
  return hits;
}

/** The URL under a column, if the column lands on one. */
export function hitUrlAt(
  hits: readonly LinkColumnHit[],
  column: number,
): string | null {
  for (const hit of hits) {
    if (column >= hit.start && column < hit.end) return hit.url;
  }
  return null;
}

/**
 * One link line's paint node: always a single text node, whether or not it
 * holds URLs, so retext and selection see the shape they always have. URL
 * spans carry OSC-8 metadata, which is also what lets the terminal own
 * Cmd+click on macOS.
 */
export function buildLinkLine(
  ctx: CliRenderer,
  spans: readonly LinkSpan[],
): TextRenderable {
  const node = new TextRenderable(ctx, {
    content: new StyledText(
      spans.flatMap((span) => linkSpanChunks(span, false)),
    ),
  });
  armLinkLine(node, [spans]);
  return node;
}

/**
 * Rewrite a link line's text on its existing node and re-arm it. The node
 * never changes shape, so unlike a span-row split this always succeeds —
 * callers rebuild only when their own layout (line count, arrow presence)
 * changes, exactly as before.
 */
export function paintLinkLine(
  node: TextRenderable,
  lines: readonly (readonly LinkSpan[])[],
): void {
  node.content = new StyledText(linkLinesChunks(lines, null));
  armLinkLine(node, lines);
}

/**
 * Chunks for caller-built per-line spans, joining lines with newlines and
 * marking the highlighted URL underlined while keeping its own color.
 */
function linkLinesChunks(
  lines: readonly (readonly LinkSpan[])[],
  highlighted: string | null,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const [index, spans] of lines.entries()) {
    if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
    for (const span of spans)
      chunks.push(...linkSpanChunks(span, span.url === highlighted));
  }
  return chunks;
}

/**
 * Arm a text node as a link hit target over caller-built per-line spans:
 * Ctrl+hover highlights the URL under the pointer, Ctrl+press and release on
 * the same URL opens it. When no line holds a URL the node is disarmed — any
 * handlers a previous arming installed are cleared — so a retext that drops
 * the last URL leaves no stale hit target behind; handler assignment
 * replaces, so re-arming after a retext never stacks.
 *
 * The press deliberately keeps bubbling — stopping it would break drag-select
 * starting on a URL — and the open fires on release only when the pointer
 * resolves to the same URL it pressed on, so a Ctrl+drag still selects.
 * Columns map over the unwrapped line; on a wrapped line the continuation
 * rows resolve against the same ranges, and the press/release equality check
 * keeps a stray resolution from opening.
 */
export function armLinkLine(
  node: TextRenderable,
  lines: readonly (readonly LinkSpan[])[],
): void {
  const hits = lines.map(linkColumnHits);
  if (!hits.some((line) => line.length > 0)) {
    node.onMouseDown = undefined;
    node.onMouseUp = undefined;
    node.onMouseOver = undefined;
    node.onMouseMove = undefined;
    node.onMouseOut = undefined;
    return;
  }
  const at = (event: MouseEvent): string | null => {
    // Events carry terminal-absolute coordinates with no per-node transform,
    // so map through the node's own screen position (scroll-aware through the
    // translate chain, matching the dispatch hit test).
    const line = Math.max(0, Math.min(hits.length - 1, event.y - node.screenY));
    return hitUrlAt(hits[line] ?? [], event.x - node.screenX);
  };
  const repaint = (highlighted: string | null): void => {
    node.content = new StyledText(linkLinesChunks(lines, highlighted));
  };
  let press: string | null = null;
  let hover: string | null = null;
  node.onMouseDown = (event) => {
    press = isUrlOpenClick(event) ? at(event) : null;
  };
  node.onMouseUp = (event) => {
    const start = press;
    press = null;
    if (start !== null && isUrlOpenClick(event) && at(event) === start)
      openUrl(start);
  };
  node.onMouseOver = (event) => {
    if (event.modifiers.ctrl !== true) return;
    const url = at(event);
    if (url !== hover) {
      hover = url;
      repaint(url);
    }
  };
  node.onMouseMove = (event) => {
    const url = event.modifiers.ctrl === true ? at(event) : null;
    if (url !== hover) {
      hover = url;
      repaint(url);
    }
  };
  node.onMouseOut = () => {
    press = null;
    if (hover !== null) {
      hover = null;
      repaint(null);
    }
  };
}

export function isUnderlined(attributes: number): boolean {
  return (attributes & TextAttributes.UNDERLINE) !== 0;
}
