import type { StyledLine } from "./index.js";

// Differential-inline transcript model (pi/omp style). The transcript splits
// into two regions:
//
//   - committed: settled turns that have scrolled past the live window. They are
//     emitted append-only into the terminal's native scrollback (via Ink
//     <Static>) exactly once and are never rewritten — native scroll, copy, and
//     find operate on them directly.
//   - live: the recent tail (streaming block plus whatever else sits within the
//     live window). It is re-rendered every frame in Ink's dynamic region, which
//     diffs against the previous frame and rewrites only changed lines.
//
// This module owns the commit boundary: the backbuffer of already-committed
// lines plus the accounting that decides when a whole block has settled far
// enough above the live window to move into scrollback. Commits happen at block
// granularity so a resize (which re-wraps the live region at the new width)
// never re-emits or double-counts a block already frozen in scrollback — the
// accepted tradeoff being that committed history keeps its original width.

export type TranscriptCommitState = {
  // Lines already emitted to native scrollback, in commit order. Only ever
  // appended to within a layout epoch; the leading entries are immutable because
  // the terminal already owns them.
  committedLines: StyledLine[];
  // Block ids whose lines are in committedLines, oldest first.
  committedBlockIds: string[];
  committedBlockIdSet: Set<string>;
  // The resource banner leads the first committed block into scrollback; once
  // committed it is frozen with the rest of the history.
  bannerCommitted: boolean;
  // Bumped whenever the transcript is replaced (a fresh session). Ink's <Static>
  // never rewrites already-emitted items, so its host must remount on a bump to
  // reset the write cursor — otherwise a cleared session's new scrollback would
  // not appear until it grew past the old length.
  epoch: number;
  // The session generation this state was last advanced against. A change means
  // clear() replaced the transcript, which triggers the epoch bump and reset.
  generation: number;
};

export function emptyTranscriptCommitState(): TranscriptCommitState {
  return {
    committedLines: [],
    committedBlockIds: [],
    committedBlockIdSet: new Set(),
    bannerCommitted: false,
    epoch: 0,
    generation: 0,
  };
}

export type TranscriptFrame = {
  // Static session banner (brand, workspace, skills/plugins). Committed with the
  // first block that settles.
  bannerLines: StyledLine[];
  // Assembled lines for every retained block, banner excluded.
  blockLines: StyledLine[];
  // Start index into blockLines for each retained block (length === blockIds.length).
  blockLineStarts: number[];
  // Stable id per retained block, aligned with blockLineStarts.
  blockIds: string[];
  // Visual line height per block, aligned with blockIds. Reused from
  // buildLinesIncremental so a commit never re-derives block heights.
  blockRenderLineCounts: number[];
  // Whether each block is settled enough to freeze, aligned with blockIds. A
  // block with a pending or running tool call still mutates (duration, spinner,
  // merge with its result), so it must stay live even after it scrolls above the
  // window. Commits stop at the first unsettled block.
  blockSettled: boolean[];
  // Height of the live window in rows — the tail kept dynamic. Everything above
  // it (at whole-block boundaries) may commit.
  liveRows: number;
  // Monotonic session epoch. A change means clear() replaced the transcript.
  generation: number;
};

export type TranscriptSplit = {
  state: TranscriptCommitState;
  // Cumulative frozen scrollback lines to hand to <Static>.
  committed: StyledLine[];
  // The dynamic tail to render this frame.
  live: StyledLine[];
};

export function advanceTranscriptCommit(
  prev: TranscriptCommitState,
  frame: TranscriptFrame,
): TranscriptSplit {
  const { bannerLines, blockLines, blockLineStarts, blockIds, blockRenderLineCounts, blockSettled, liveRows, generation } = frame;

  // A fresh session (clear/new) is signalled explicitly by a generation bump.
  // Reset the committed set and backbuffer and remount <Static> via a new epoch.
  // A front-trim keeps the same generation, so dropping already-committed blocks
  // off the top is never mistaken for a reset.
  const base = generation !== prev.generation
    ? { ...emptyTranscriptCommitState(), epoch: prev.epoch + 1, generation }
    : prev;

  // Retained blocks that are already committed form a front prefix (commits
  // happen oldest-first; a front-trim only drops already-committed blocks).
  let firstUncommitted = 0;
  while (
    firstUncommitted < blockIds.length
    && base.committedBlockIdSet.has(blockIds[firstUncommitted]!)
  ) {
    firstUncommitted++;
  }

  const uStart = blockLineStarts[firstUncommitted] ?? blockLines.length;
  const bannerLead = base.bannerCommitted ? 0 : bannerLines.length;
  const uncommittedLineCount = bannerLead + (blockLines.length - uStart);
  const commitBudget = uncommittedLineCount - Math.max(0, liveRows);

  // Walk whole blocks off the top while they fit under the commit budget. The
  // last block is never committed: it may still be streaming, so its lines are
  // not yet final.
  const lastIndex = blockIds.length - 1;
  let consumed = bannerLead;
  let newCommitted = firstUncommitted;
  for (let i = firstUncommitted; i < lastIndex; i++) {
    // A block with a pending/running tool call still mutates, so it (and every
    // block after it, to keep scrollback append-only in order) stays live.
    if (!blockSettled[i]) break;
    const height = blockRenderLineCounts[i] ?? 0;
    if (consumed + height > commitBudget) break;
    consumed += height;
    newCommitted = i + 1;
  }

  let state = base;
  if (newCommitted > firstUncommitted) {
    // Append only the newly settled lines. committedLines is never re-copied, so
    // freezing a block into scrollback stays O(block height) rather than O(total
    // committed) — the axis this renderer exists to keep flat over a long session.
    const committedLines = base.committedLines;
    let bannerCommitted = base.bannerCommitted;
    if (!bannerCommitted) {
      for (const line of bannerLines) committedLines.push(line);
      bannerCommitted = true;
    }
    const uEnd = blockLineStarts[newCommitted] ?? blockLines.length;
    for (let li = uStart; li < uEnd; li++) committedLines.push(blockLines[li]!);
    const committedBlockIds = base.committedBlockIds;
    const committedBlockIdSet = base.committedBlockIdSet;
    for (let i = firstUncommitted; i < newCommitted; i++) {
      committedBlockIds.push(blockIds[i]!);
      committedBlockIdSet.add(blockIds[i]!);
    }
    state = {
      committedLines,
      committedBlockIds,
      committedBlockIdSet,
      bannerCommitted,
      epoch: base.epoch,
      generation: base.generation,
    };
  } else if (base !== prev) {
    state = base;
  }

  const liveStart = blockLineStarts[newCommitted] ?? blockLines.length;
  const live: StyledLine[] = state.bannerCommitted
    ? blockLines.slice(liveStart)
    : [...bannerLines, ...blockLines.slice(liveStart)];

  return { state, committed: state.committedLines, live };
}
