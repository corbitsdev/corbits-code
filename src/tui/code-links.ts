/**
 * Transcript link targets: painted-line geometry plus markdown resolution
 * through childless library renderers. Span scanning and wrapped-URL fusion
 * live in link-spans; the open gate lives in link-open. Fenced code gets
 * bare URLs from Code `onHighlight` / `onChunks` (`detectLinks`).
 */
import {
  CodeRenderable,
  Renderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  bold as boldChunk,
  detectLinks,
  fg as fgChunk,
  link as linkChunk,
  underline as underlineChunk,
  type CliRenderer,
  type LineInfo,
  type MouseEvent,
  type SimpleHighlight,
  type TextChunk,
} from "@opentui/core";
import { stringWidth } from "./view/height.js";
import { isOpenableUrl, isUrlOpenClick, openUrl } from "./link-open.js";
import {
  findLinks,
  linkHits,
  trimUrlEnd,
  type LinkSpan,
} from "./link-spans.js";
import { UI } from "./theme.js";

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

/** Column ranges of the openable URLs on one painted line (armed nodes
 * resolve clicks through these instead). */
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
 * Paint one link line as a single text node so retext and selection see
 * one shape; OSC-8 metadata keeps the terminal's Cmd+click.
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

/** Rewrite a link line's text in place and re-arm; callers rebuild only
 * when their own layout (line count, arrow presence) changes. */
export function paintLinkLine(
  node: TextRenderable,
  lines: readonly (readonly LinkSpan[])[],
): void {
  node.content = new StyledText(linkLinesChunks(lines, null));
  armLinkLine(node, lines);
}

/**
 * Chunks for caller-built per-line spans: join lines with newlines and
 * underline the highlighted URL without changing its color.
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
 * Arm a text node over caller-built per-line spans: Ctrl+hover highlights
 * the URL; Ctrl+press and release on the same URL opens it. Disarms when
 * no line holds a URL; re-arming replaces handlers rather than stacking.
 * Press keeps bubbling so drag-select still works; release opens only on
 * the pressed URL, so Ctrl+drag selects instead.
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
    // Map terminal-absolute coordinates through the node's own screen
    // position.
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
      // Stop the bubbled release from reaching the transcript-root
      // markdown handler: one open per gesture.
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
 * Markup characters whose painted width the resolver cannot know: the
 * renderer conceals them (`[guide](…)` paints as `guide (…)`), so each
 * is modeled at width 0 or 1.
 */
const CONCEALABLE = new Set(["[", "]", "(", ")"]);

/**
 * Inline `[label](target)` and bare http(s) ranges, resolved by
 * `detectLinks`. Images are `markup.raw` so neither the label nor the
 * destination opens. A label that is itself a URL stays a bare hit (it
 * opens the label text, not the markdown target).
 */
function markdownHighlights(line: string): SimpleHighlight[] {
  const highlights: SimpleHighlight[] = [];
  for (const match of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const start = match.index ?? 0;
    highlights.push([start, start + match[0].length, "markup.raw"]);
  }
  for (const match of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const index = match.index ?? 0;
    if (index > 0 && line[index - 1] === "!") continue;
    const url = match[2] ?? "";
    const rawStart = index + match[0].lastIndexOf(url);
    const end = trimUrlEnd(line, rawStart, rawStart + url.length);
    if (end <= rawStart) continue;
    const label = match[1] ?? "";
    if (label.length > 0 && !labelIsBareUrl(label)) {
      highlights.push([
        index + 1,
        index + 1 + label.length,
        "markup.link.label",
      ]);
    }
    highlights.push([rawStart, end, "markup.link.url"]);
  }
  return highlights;
}

/** True when the label text is exactly one bare http(s) URL. */
function labelIsBareUrl(label: string): boolean {
  const hits = findLinks(label);
  return (
    hits.length === 1 && hits[0]?.start === 0 && hits[0].end === label.length
  );
}

/**
 * Link target under one source offset. `detectLinks` applies bare URLs and
 * the markdown label/destination highlights above; image raw ranges are
 * omitted.
 */
function markdownUrlAt(line: string, offset: number): string | null {
  for (const hit of linkHits(line, markdownHighlights(line))) {
    if (offset >= hit.start && offset < hit.end) return hit.url;
  }
  return null;
}

/**
 * Source offsets a painted column can mean in one rendered row: each
 * offset starts in [min, max] (concealable markup spreads the range) and
 * paints up to wMax wide; the column hits the offset when it falls in
 * that range.
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
 * Link target under terminal-absolute (x, y) inside one painted code
 * block: the block's line info maps the row to a source line and the
 * column to plausible offsets; the click opens only when every plausible
 * offset agrees on one URL.
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
 * Markdown click target under terminal-absolute (x, y), or null when the
 * cell paints no link. Walks from the hit leaf up to the nearest painted
 * code block (assistant markdown paints through library CodeRenderables);
 * that first block decides — a wider ancestor may pair the column
 * differently. Text rows resolve in their own armed handlers; this never
 * throws.
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
 * Arm a transcript ancestor as the markdown click target: markdown blocks
 * paint through childless library renderers, so only a bubbling ancestor
 * handler sees their clicks. Press and release must land on the same URL
 * to open; openUrl gates to http(s), since markdown can carry any scheme.
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
  target.onMouseOut = (event) => {
    // 0.6.x refreshes over/out lazily, so an out earned by an earlier
    // pointer position can land between a press and its release although
    // the pointer never moved. An out whose coordinates still resolve to a
    // descendant of target means the pointer stayed inside the transcript —
    // only an actual departure clears the press.
    try {
      let current: Renderable | null | undefined =
        Renderable.renderablesByNumber.get(renderer.hitTest(event.x, event.y));
      while (current) {
        if (current === target) return;
        current = current.parent;
      }
    } catch {
      // Unresolvable hit: treat as departed, like pre-0.6 did implicitly.
    }
    press = null;
  };
}

const armedChildCounts = new WeakMap<Renderable, number>();
let codeLinkWalkCount = 0;

/** Subtree walks `armCodeLinks` actually performed. Equal child counts do not count. */
export function codeLinkArmWalks(): number {
  return codeLinkWalkCount;
}

/**
 * Fenced code is a Code renderable without markdown's link callbacks.
 * `onHighlight` keeps the tree-sitter groups; `onChunks` is `detectLinks`,
 * so a bare URL becomes an OSC-8 span and survives native wrap. Markdown
 * prose already sets both — do not replace those, or conceal regresses.
 * A retext whose child count did not grow has no new code block to arm.
 */
export function armCodeLinks(node: Renderable): void {
  const count = node.getChildrenCount();
  const previous = armedChildCounts.get(node);
  if (previous !== undefined && count <= previous) {
    if (count < previous) armedChildCounts.set(node, count);
    return;
  }
  codeLinkWalkCount += 1;
  const walk = (current: Renderable): void => {
    if (current instanceof CodeRenderable) {
      if (current.onHighlight === undefined) {
        current.onHighlight = (highlights) => highlights;
      }
      if (current.onChunks === undefined) {
        current.onChunks = (chunks, context) => detectLinks(chunks, context);
      }
    }
    for (const child of current.getChildren()) walk(child);
  };
  walk(node);
  armedChildCounts.set(node, count);
}
