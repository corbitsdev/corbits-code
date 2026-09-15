/** URL spans: bare http(s) scanning plus splitting styled runs on hits. */
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

/** http(s) runs inside plain text, without trailing prose punctuation. */
export function findLinks(text: string): LinkHit[] {
  const hits: LinkHit[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const end = trimUrlEnd(text, match.index, match.index + match[0].length);
    if (end > match.index)
      hits.push({ url: text.slice(match.index, end), start: match.index, end });
  }
  return hits;
}

/**
 * The end of a URL match once prose punctuation is out: trailing sentence
 * punctuation never belongs to the link, and a closing paren only does when
 * the match opened one to balance it.
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
