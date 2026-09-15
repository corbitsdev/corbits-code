/**
 * Transcript links: painted-line geometry (armed rows) plus markdown
 * resolution (childless library renderers). Span scanning lives in
 * link-spans, wrapped-URL fusion in link-wrap, the open gate in link-open.
 */
import {
  CodeRenderable,
  Renderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  bold as boldChunk,
  fg as fgChunk,
  link as linkChunk,
  underline as underlineChunk,
  type CliRenderer,
  type LineInfo,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core";
import { stringWidth } from "./view/height.js";
import { isOpenableUrl, isUrlOpenClick, openUrl } from "./link-open.js";
import {
  findLinks,
  trimUrlEnd,
  type LinkHit,
  type LinkSpan,
} from "./link-spans.js";
import { UI } from "./theme.js";

/** Moved siblings, re-exported so existing url-links importers keep working. */
export {
  isOpenableUrl,
  isUrlOpenClick,
  openUrl,
  platformUrlCommand,
  resetUrlOpener,
  setUrlOpener,
} from "./link-open.js";
export { findLinks, splitLinkSpans, type LinkSpan } from "./link-spans.js";
export { splitWrappedLinkSpans } from "./link-wrap.js";

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
    if (start !== null && isUrlOpenClick(event) && at(event) === start) {
      openUrl(start);
      // The bubbled release would otherwise be resolved again by the
      // transcript-root armMarkdownLinks handler. This handler runs
      // first in the bubble; stopping propagation starves the root of the
      // release and keeps exactly one open per gesture. The press
      // deliberately keeps bubbling so drag-select still works.
      event.stopPropagation();
    }
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

/**
 * Link-markup characters whose painted width the resolver cannot know. The
 * renderer conceals markdown link markup — observed: `[guide](…)` paints as
 * `guide (…)` — and highlight state is not readable from here, so each of
 * these characters is modeled as taking painted width 0 or 1. Every other
 * character paints at its measured width.
 */
const CONCEALABLE = new Set(["[", "]", "(", ")"]);

/**
 * Inline `[label](target)` links in one source line. The label and the
 * target both open the target. Images (`![alt](target)`) are skipped:
 * nothing specifies their click behavior, and a missed click is safer
 * than a wrong open.
 */
function findMarkdownLinks(line: string): LinkHit[] {
  const spans: LinkHit[] = [];
  const pattern = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > 0 && line[index - 1] === "!") continue;
    const url = match[2] ?? "";
    const rawStart = index + match[0].lastIndexOf(url);
    const end = trimUrlEnd(line, rawStart, rawStart + url.length);
    if (end <= rawStart) continue;
    const target = line.slice(rawStart, end);
    const label = match[1] ?? "";
    if (label.length > 0)
      spans.push({
        url: target,
        start: index + 1,
        end: index + 1 + label.length,
      });
    spans.push({ url: target, start: rawStart, end });
  }
  return spans;
}

/**
 * Whole `![label](target)` ranges: bare-URL scanning cannot tell image markup
 * from links, so the resolver discards bare matches touching these ranges and
 * the spans above already skip them. Images stay non-openable by policy.
 */
function findImageRanges(line: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const match of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

/**
 * The link target under one source offset: bare URLs first (fidelity for
 * URL-shaped link labels), then inline `[label](target)` spans. A bare match
 * fused across a link span's boundary (`[a](u1)[b](u2)` scans as one run) or
 * inside image markup is the matcher's artifact, not a link the line holds,
 * so only a bare match one span fully contains — or no span touches — counts.
 */
function markdownUrlAt(line: string, offset: number): string | null {
  const spans = findMarkdownLinks(line);
  const images = findImageRanges(line);
  for (const hit of findLinks(line)) {
    if (offset >= hit.start && offset < hit.end) {
      const fused = spans.some(
        (span) =>
          hit.start < span.end &&
          hit.end > span.start &&
          (hit.start < span.start || hit.end > span.end),
      );
      const imaged = images.some(
        (image) => hit.start < image.end && hit.end > image.start,
      );
      if (!fused && !imaged) return hit.url;
    }
  }
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) return span.url;
  }
  return null;
}

/**
 * Source offsets a painted column can mean within one rendered row. Each
 * offset starts painting somewhere in [min, max] (the spread comes from
 * concealable markup before it) and paints up to wMax wide; the column hits
 * the offset when it falls in that range. Columns before any markup map
 * exactly; around markup the set holds neighbors too — the caller opens
 * only when every plausible offset agrees on one URL.
 */
function paintedColumnToSource(
  line: string,
  base: number,
  length: number,
  column: number,
): number[] {
  if (column < 0) return [];
  const plausible: number[] = [];
  let min = 0;
  let max = 0;
  let offset = base;
  const end = Math.min(line.length, base + length);
  while (offset < end) {
    const char = line[offset] ?? "";
    const codePoint = line.codePointAt(offset) ?? 0;
    const wMax = CONCEALABLE.has(char)
      ? 1
      : stringWidth(String.fromCodePoint(codePoint));
    if (min <= column && column < max + wMax) plausible.push(offset);
    min += CONCEALABLE.has(char) ? 0 : wMax;
    max += wMax;
    if (min > column) break;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return plausible;
}

/**
 * The link target under terminal-absolute (x, y) inside one painted code
 * block: the row maps through the block's own line info to a source line,
 * the column maps to plausible source offsets, and the click opens only
 * when every plausible offset agrees on one URL — concealment ambiguity
 * misses rather than opening wrong. Stale layout or an unexpected library
 * shape resolves to null, never throws.
 */
function codeBlockLinkAt(
  block: CodeRenderable,
  x: number,
  y: number,
): string | null {
  let content: string;
  let info: LineInfo;
  try {
    content = block.content;
    info = block.lineInfo;
  } catch {
    return null;
  }
  const row = y - block.screenY;
  const column = x - block.screenX;
  if (row < 0 || column < 0) return null;
  const source = info.lineSources[row];
  const base = info.lineStartCols[row];
  const length = info.lineWidthCols[row];
  if (
    source === undefined ||
    base === undefined ||
    length === undefined ||
    !Number.isInteger(source) ||
    !Number.isInteger(base) ||
    !Number.isInteger(length)
  )
    return null;
  const line = content.split("\n")[source];
  if (typeof line !== "string") return null;
  let found: string | null = null;
  for (const offset of paintedColumnToSource(line, base, length, column)) {
    const url = markdownUrlAt(line, offset);
    if (url === null) continue;
    if (found === null) found = url;
    else if (found !== url) return null;
  }
  return found;
}

/**
 * The markdown click target: the raw link target under terminal-absolute
 * (x, y), or null when the cell paints no link. Walks from the hit leaf up to
 * the nearest painted code block (assistant markdown paints through library
 * CodeRenderables, one per block), and that first block decides: its answer
 * stands, with no retry at an ancestor, so a miss inside one block never
 * falls through to a wider ancestor that pairs the same column with a link
 * the narrower block already rejected. Clicks landing outside any block miss.
 * TextRenderable rows never resolve here — their own armed node handlers own
 * those clicks. Never throws: anything unexpected resolves to null so a
 * missed click stays a missed click.
 */
export function markdownLinkAt(
  renderer: CliRenderer,
  x: number,
  y: number,
): string | null {
  try {
    let current: Renderable | null | undefined;
    try {
      current = Renderable.renderablesByNumber.get(renderer.hitTest(x, y));
    } catch {
      return null;
    }
    while (current) {
      if (current instanceof CodeRenderable) {
        return codeBlockLinkAt(current, x, y);
      }
      current = current.parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Arm a transcript ancestor as the markdown click target: mouse events bubble
 * up from the hit leaf, and markdown blocks paint through childless library
 * renderers with no node of ours to arm, so this ancestor handler is the only
 * hook that sees their clicks. Ctrl+press stores the link under the pointer
 * (markdownLinkAt reads the same terminal-absolute coordinates events carry);
 * the open fires on release only over the same URL, so a press on a link that
 * drags away never opens. Armed rows stop propagation after opening
 * themselves, so a click there still opens exactly once; everything goes
 * through openUrl, which gates to http(s) — markdown links can carry any
 * scheme and markdownLinkAt hands the raw target back.
 */
export function armMarkdownLinks(
  target: Renderable,
  renderer: CliRenderer,
): void {
  let press: string | null = null;
  target.onMouseDown = (event) => {
    press = isUrlOpenClick(event)
      ? markdownLinkAt(renderer, event.x, event.y)
      : null;
  };
  target.onMouseUp = (event) => {
    const start = press;
    press = null;
    if (start === null || !isUrlOpenClick(event)) return;
    if (markdownLinkAt(renderer, event.x, event.y) === start) openUrl(start);
  };
  target.onMouseOut = () => {
    press = null;
  };
}
