import type { StyledLine } from "./view/lines.js";
import { looksLikeTableRow, isTableSeparator } from "./markdown-parser.js";

type ScanState = {
  width: number;
  content: string;
  // Character index where the unrendered tail begins; everything before it is
  // covered by stableLines.
  tailStart: number;
  stableLines: StyledLine[];
  // Line-scanner cursor: start of the first line not yet fully scanned, and
  // whether a fenced code block is open at that point.
  scanPos: number;
  fenceOpen: boolean;
  // Exclusive end of the next stable region, or -1 when none is pending.
  boundary: number;
  // Extra characters to skip after boundary when advancing tailStart.
  // Blank-line boundaries point at the blank newline itself (skip 1) so the
  // blank is not re-parsed as a leading empty line of the tail; line-cut
  // boundaries already sit past the completed newline (skip 0).
  boundarySkip: 0 | 1;
  // Last output returned, keyed by the (content, width) that produced it. A
  // resize-free re-render with unchanged content is then a cache hit rather
  // than re-running the tail render callback.
  lastResult: StyledLine[];
};

// Matches parseMarkdown's fence detection so blank-line split points stay in
// sync with fence parity: a boundary is only taken when no fenced block is open,
// which keeps a code block (and its incremental highlighting) whole in the tail.
const FENCE_RE = /^\s*(```+|~~~+)/;
// Table freeze uses looksLikeTableRow / isTableSeparator from markdown-parser
// (not open-table state): never carve on a table-looking line so the whole open
// table stays in the re-rendered tail and shares one column-width set.

// When a single paragraph grows without blank-line boundaries, still carve stable
// prefix at completed newlines so streaming re-highlight stays bounded.
const MAX_TAIL_CHARS = 480;

function preferBoundary(state: ScanState, at: number, skip: 0 | 1): void {
  // Keep the boundary that consumes the most content into the stable prefix.
  const nextConsumed = at + skip;
  const prevConsumed = state.boundary < 0 ? -1 : state.boundary + state.boundarySkip;
  if (nextConsumed > prevConsumed) {
    state.boundary = at;
    state.boundarySkip = skip;
  }
}

// Incremental renderer for the one block that is still streaming: the render
// callback (a full markdown parse + wrap) is expensive and the transcript
// drains up to ten times a second, so re-rendering the whole accumulated block
// each drain makes long replies progressively laggier. parseMarkdown is
// line-based and its only cross-line state is fence parity and open tables, so
// any blank line outside a fence is a safe split point: lines before it are
// rendered once and cached, and only the trailing paragraph is re-rendered per
// drain. Table-looking lines never take a MAX_TAIL carve (they must stay with
// later rows for whole-table column widths). When no blank line appears,
// completed newlines past MAX_TAIL_CHARS outside fences are also safe. A width
// change or non-append content mutation resets the cache.
export function createIncrementalMarkdown(
  render: (content: string, width: number) => StyledLine[],
): (content: string, width: number) => StyledLine[] {
  let state: ScanState | null = null;

  return (content, width) => {
    if (state !== null && state.width === width && state.content === content) {
      return state.lastResult;
    }

    if (
      state === null
      || state.width !== width
      || !content.startsWith(state.content)
    ) {
      state = {
        width,
        content,
        tailStart: 0,
        stableLines: [],
        scanPos: 0,
        fenceOpen: false,
        boundary: -1,
        boundarySkip: 0,
        lastResult: [],
      };
    }
    state.content = content;

    let lineStart = state.scanPos;
    for (let i = content.indexOf("\n", lineStart); i !== -1; i = content.indexOf("\n", lineStart)) {
      if (i === lineStart) {
        // Blank line ends a pipe table and is a safe freeze point outside fences.
        if (!state.fenceOpen) preferBoundary(state, lineStart, 1);
      } else {
        const line = content.slice(lineStart, i);
        if (FENCE_RE.test(line)) {
          state.fenceOpen = !state.fenceOpen;
        } else if (!state.fenceOpen) {
          // Do not carve on table rows/separators — keep the open table in the tail.
          if (
            !looksLikeTableRow(line)
            && !isTableSeparator(line)
            && content.length - state.tailStart > MAX_TAIL_CHARS
          ) {
            // Same geometry as a blank-line cut: region ends before this line's
            // trailing newline, then skip it so stable+tail never invents an
            // extra empty row the whole-parse path does not have.
            preferBoundary(state, i, 1);
          }
        }
      }
      lineStart = i + 1;
    }
    state.scanPos = lineStart;

    if (state.boundary >= state.tailStart) {
      const region = content.slice(state.tailStart, state.boundary);
      state.stableLines = state.stableLines.concat(render(region, width));
      state.tailStart = state.boundary + state.boundarySkip;
      state.boundary = -1;
      state.boundarySkip = 0;
    }

    const tail = render(content.slice(state.tailStart), width);
    const result = state.tailStart === 0 ? tail : state.stableLines.concat(tail);
    state.lastResult = result;
    return result;
  };
}
