/**
 * Wrapped links: fuse a URL broken across continuation lines into one target.
 */
import { stringWidth } from "./view/height.js";
import { isOpenableUrl } from "./link-open.js";
import {
  findLinks,
  sliceSpans,
  trimUrlEnd,
  type LinkSpan,
  type SliceHit,
} from "./link-spans.js";

/**
 * Split pre-wrapped plain-row lines so a URL broken across continuation lines
 * resolves to one target: every fragment highlights and opens the full URL.
 *
 * `wrapWidth` is the painted width the row was wrapped at. Only a full line
 * ending in a URL run can start a chain, and only a full line the run
 * reaches the end of continues one — a short line ends the chain unless
 * nothing textual follows it (end of text, bubble padding), because a short
 * line with text after it is a natural break, not a wrap. A chain is accepted
 * when its fragments reassemble to one of `sourceUrls`, the links the row's
 * pre-wrap text actually holds: word wrap can orphan a short fragment line
 * with wrapped text after it (indistinguishable from a natural break by
 * geometry alone), and the source is what tells the two apart. Without known
 * source URLs the joined candidate still has to scan as exactly one clean
 * http(s) URL, which keeps an unfortunate line break (a full line that
 * happens to end in a URL, followed by a word) from fusing two unrelated
 * runs. That coincidence is indistinguishable from a real wrap after the
 * fact, so it stays a documented approximation: it needs a URL ending
 * exactly at the wrap edge. A seed with no detectable hit on its own line
 * (a hard split inside the scheme or host) only continues through a full
 * first line: the full line broke at a wrap edge, while a short next line
 * behind a bare scheme reads as prose that happens to scan, not a wrap —
 * unless the fragments reassemble to a known source URL, which settles it.
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
  // scheme or host leaves no detectable hit; the joined candidate still has
  // to scan as one clean URL before anything merges. Prose punctuation the
  // wrap left at the edge is not part of the seed, same as for a hit.
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
 * seed. A run ending mid-line ends the chain; a run reaching its line's end
 * continues it only through a full line, and a short line ends the chain
 * unless nothing textual follows it (end of text, bubble padding) — a short
 * line with text after it is a natural break, not a wrap. A hitless seed
 * only continues through a full first line, because a short next line behind
 * a bare scheme reads as prose that happens to scan. Against known source
 * URLs the chain also ends the moment its fragments reassemble to one of
 * them, which is what resolves a wrap the geometry alone cannot see: a
 * short fragment line with wrapped text after it. Without source URLs the
 * joined candidate has to scan as one clean URL instead.
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
 * pad row (the bare bar with no body). A blank source line is not one — it
 * is a natural break. Paint trims each line's trailing space, so the pad
 * compares exactly.
 */
function isWrapEndLine(text: string | undefined): boolean {
  if (text === undefined) return true;
  return text.trimEnd() === "▍";
}
