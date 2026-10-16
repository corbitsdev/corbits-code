/** URL spans: bare http(s) scanning plus splitting styled runs on hits. */
import {
  detectLinks,
  type SimpleHighlight,
  type TextChunk,
} from "@opentui/core";
import { stringWidth } from "./view/height.js";
import { isOpenableUrl } from "./link-open.js";

export interface LinkSpan {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean | undefined;
  readonly url: string | null;
}

export interface LinkHit {
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

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
 * http(s) runs inside plain text. Bare detection is OpenTUI `detectLinks`
 * so a painted fragment and a Code chunk agree on the same target.
 */
export function findLinks(text: string): LinkHit[] {
  return linkHits(text, []);
}

/** Linked ranges `detectLinks` reports for one string. */
export function linkHits(
  text: string,
  highlights: readonly SimpleHighlight[],
): LinkHit[] {
  if (text.length === 0) return [];
  const chunk: TextChunk = { __isChunk: true, text };
  const linked = detectLinks([chunk], {
    content: text,
    highlights: [...highlights],
    sourceRanges: [{ start: 0, end: text.length }],
  });
  const hits: LinkHit[] = [];
  let offset = 0;
  for (const part of linked) {
    const url = part.link?.url;
    if (url !== undefined && part.text.length > 0) {
      hits.push({ url, start: offset, end: offset + part.text.length });
    }
    offset += part.text.length;
  }
  return hits;
}

/**
 * End of a URL match once prose punctuation is out: sentence punctuation
 * never belongs to the link; a closing paren only does when the match
 * opened one to balance it.
 */
export function trimUrlEnd(text: string, start: number, end: number): number {
  let trimmed = end;
  while (trimmed > start) {
    const tail = text[trimmed - 1];
    if (tail === undefined || !TRAILING_PUNCTUATION.has(tail)) break;
    trimmed -= 1;
  }
  let depth = 0;
  for (let i = start; i < trimmed; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") depth -= 1;
  }
  while (trimmed > start && text[trimmed - 1] === ")" && depth < 0) {
    trimmed -= 1;
    depth += 1;
  }
  return trimmed;
}

/** Split styled segments so URL runs become their own spans. */
export function splitLinkSpans(
  segments: readonly { text: string; fg: string; bold?: boolean | undefined }[],
): LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const segment of segments) {
    spans.push(
      ...sliceSpans(
        segment,
        findLinks(segment.text).map((hit): SliceHit => ({
          ...hit,
          text: hit.url,
        })),
      ),
    );
  }
  return spans;
}

/** A hit with the exact text its span paints (trimmed of prose punctuation). */
export interface SliceHit extends LinkHit {
  readonly text: string;
}

/** Cut one segment on explicit hits; a hitless segment stays one null span. */
export function sliceSpans(
  segment: { text: string; fg: string; bold?: boolean | undefined },
  hits: readonly SliceHit[],
): LinkSpan[] {
  if (hits.length === 0) {
    return [
      { text: segment.text, fg: segment.fg, bold: segment.bold, url: null },
    ];
  }
  const spans: LinkSpan[] = [];
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
      text: hit.text,
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
  return spans;
}

/**
 * Rejoin URL fragments split across continuation lines so every fragment
 * highlights and opens the full URL.
 *
 * `wrapWidth` is the painted width the row was wrapped at. A chain starts
 * on a full line ending in a URL run and continues through full lines; a
 * short line ends it unless no text follows (then a natural break, not a
 * wrap). A chain is accepted when its fragments reassemble to one of
 * `sourceUrls`, the row's real links: wrap can orphan a short fragment
 * with text after it, indistinguishable from a natural break by geometry.
 * Without known source URLs the joined candidate must still scan as
 * exactly one clean http(s) URL, so a break cannot fuse two unrelated
 * runs. The scan is `detectLinks` via `findLinks`.
 */
export function splitWrappedLinkSpans(
  lines: readonly { text: string; fg: string }[],
  wrapWidth: number,
  sourceUrls: readonly string[] = [],
): LinkSpan[][] {
  const hits = lines.map((line) =>
    findLinks(line.text).map((hit): SliceHit => ({ ...hit, text: hit.url })),
  );
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const seed = line === undefined ? null : wrapSeed(line.text, wrapWidth);
    if (line === undefined || seed === null) {
      index += 1;
      continue;
    }
    const chain = followWrapChain(
      lines,
      index + 1,
      seed,
      (hits[index] ?? []).some((hit) => hit.end >= seed.end),
      wrapWidth,
      sourceUrls,
    );
    if (chain === null) {
      index += 1;
      continue;
    }
    hits[index] = (hits[index] ?? []).filter((hit) => hit.start < seed.start);
    hits[index]?.push({
      url: chain.full,
      start: seed.start,
      end: seed.end,
      text: seed.text,
    });
    for (const run of chain.runs) {
      hits[run.line] = (hits[run.line] ?? []).filter(
        (hit) => hit.end <= run.start || hit.start >= run.end,
      );
      hits[run.line]?.push({
        url: chain.full,
        start: run.start,
        end: run.end,
        text: lines[run.line]?.text.slice(run.start, run.end) ?? "",
      });
    }
    index = chain.endLine + 1;
  }
  return lines.map((line, i) =>
    sliceSpans(
      line,
      [...(hits[i] ?? [])].sort((a, b) => a.start - b.start),
    ),
  );
}

/** A full line's trailing URL run seeds a wrapped chain, if URL-shaped. */
function wrapSeed(
  text: string,
  wrapWidth: number,
): {
  readonly start: number;
  readonly end: number;
  readonly text: string;
} | null {
  if (stringWidth(text) !== wrapWidth) return null;
  const run = text.match(/[^\s]+$/)?.[0] ?? "";
  // The :// marks the run as URL-shaped even when a hard split inside the
  // scheme or host leaves no detectable hit; the joined candidate still
  // has to scan as one clean URL before anything merges. Prose punctuation
  // at the wrap edge is not part of the seed.
  if (!run.includes("://")) return null;
  const start = text.length - run.length;
  const end = trimUrlEnd(text, start, text.length);
  if (end <= start) return null;
  return { start, end, text: text.slice(start, end) };
}

/** Fragments a chain picks up past its seed line, through its final line. */
interface WrapChain {
  readonly full: string;
  readonly runs: readonly {
    readonly line: number;
    readonly start: number;
    readonly end: number;
  }[];
  readonly endLine: number;
}

/**
 * Walk continuation lines past their indent, fusing leading runs onto the
 * seed under the module's chain rules. A hitless seed continues only
 * through a full first line — a short line behind a bare scheme reads as
 * prose.
 */
function followWrapChain(
  lines: readonly { text: string; fg: string }[],
  from: number,
  seed: { readonly start: number; readonly end: number; readonly text: string },
  seedAnchored: boolean,
  wrapWidth: number,
  sourceUrls: readonly string[],
): WrapChain | null {
  let full = seed.text;
  const runs: { line: number; start: number; end: number }[] = [];
  let line = from;
  for (;;) {
    const text = lines[line]?.text;
    if (text === undefined) break;
    const start = text.match(/^[\s▍]*/)?.[0].length ?? 0;
    const raw = text.slice(start).match(/^[^\s]+/)?.[0] ?? "";
    if (raw.length === 0) {
      if (runs.length === 0 || !isWrapEndLine(text)) return null;
      break;
    }
    const end = trimUrlEnd(text, start, start + raw.length);
    if (end <= start) return null;
    full += text.slice(start, end);
    runs.push({ line, start, end });
    if (sourceUrls.includes(full)) return { full, runs, endLine: line };
    if (runs.length === 1 && !seedAnchored && stringWidth(text) !== wrapWidth)
      return null;
    if (end !== text.length) break;
    if (stringWidth(text) === wrapWidth) {
      line += 1;
      continue;
    }
    if (!isWrapEndLine(lines[line + 1]?.text)) return null;
    break;
  }
  if (runs.length === 0) return null;
  if (sourceUrls.length > 0) return null;
  if (!isOpenableUrl(full)) return null;
  const check = findLinks(full);
  if (check.length !== 1 || check[0]?.url !== full) return null;
  return { full, runs, endLine: runs[runs.length - 1]?.line ?? from };
}

/**
 * A line nothing textual follows on: the end of the text, or a user-bubble
 * pad row (a bare `▍`). A blank source line is a natural break, not one.
 * Paint trims trailing space, so the pad compares exactly.
 */
function isWrapEndLine(text: string | undefined): boolean {
  if (text === undefined) return true;
  return text.trimEnd() === "▍";
}
