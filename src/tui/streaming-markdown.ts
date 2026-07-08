import type { StyledLine } from "./view/lines.js";

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
  // Start index of the newest blank line seen with all fences closed. -1 when
  // no boundary beyond tailStart has been found yet.
  boundary: number;
};

const FENCE_RE = /^\s*(```|~~~)/;

// Incremental renderer for the one block that is still streaming: the render
// callback (a full markdown parse + wrap) is expensive and the transcript
// drains up to ten times a second, so re-rendering the whole accumulated block
// each drain makes long replies progressively laggier. parseMarkdown is
// line-based and its only cross-line state is fence parity, so any blank line
// outside a fence is a safe split point: lines before it are rendered once and
// cached, and only the trailing paragraph is re-rendered per drain. A width
// change or non-append content mutation resets the cache.
export function createIncrementalMarkdown(
  render: (content: string, width: number) => StyledLine[],
): (content: string, width: number) => StyledLine[] {
  let state: ScanState | null = null;

  return (content, width) => {
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
      };
    }
    state.content = content;

    let lineStart = state.scanPos;
    for (let i = content.indexOf("\n", lineStart); i !== -1; i = content.indexOf("\n", lineStart)) {
      if (i === lineStart) {
        if (!state.fenceOpen) state.boundary = lineStart;
      } else if (FENCE_RE.test(content.slice(lineStart, i))) {
        state.fenceOpen = !state.fenceOpen;
      }
      lineStart = i + 1;
    }
    state.scanPos = lineStart;

    if (state.boundary >= state.tailStart) {
      // The stable region ends just before the blank line; the blank line's
      // own newline is skipped so prefix + tail line counts match a whole
      // parse exactly.
      const region = content.slice(state.tailStart, state.boundary);
      state.stableLines = state.stableLines.concat(render(region, width));
      state.tailStart = state.boundary + 1;
      state.boundary = -1;
    }

    const tail = render(content.slice(state.tailStart), width);
    return state.tailStart === 0 ? tail : state.stableLines.concat(tail);
  };
}
