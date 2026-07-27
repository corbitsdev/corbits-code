import { describe, expect, test } from "bun:test";
import type { StyledLine } from "./index.js";
import {
  advanceTranscriptCommit,
  emptyTranscriptCommitState,
  type TranscriptFrame,
} from "./transcript-commit.js";

type BlockSpec = { id: string; lines: string[]; settled?: boolean };

function line(text: string): StyledLine {
  return [{ text }];
}

function buildFrame(
  banner: string[],
  blocks: BlockSpec[],
  liveRows: number,
  generation = 0,
): TranscriptFrame {
  const blockLines: StyledLine[] = [];
  const blockLineStarts: number[] = [];
  const blockIds: string[] = [];
  const blockRenderLineCounts: number[] = [];
  const blockSettled: boolean[] = [];
  for (const block of blocks) {
    blockLineStarts.push(blockLines.length);
    blockIds.push(block.id);
    blockRenderLineCounts.push(block.lines.length);
    blockSettled.push(block.settled ?? true);
    for (const text of block.lines) blockLines.push(line(text));
  }
  return {
    bannerLines: banner.map(line),
    blockLines,
    blockLineStarts,
    blockIds,
    blockRenderLineCounts,
    blockSettled,
    liveRows,
    generation,
  };
}

function texts(lines: StyledLine[]): string[] {
  return lines.map((l) => l.map((seg) => seg.text).join(""));
}

describe("advanceTranscriptCommit", () => {
  test("keeps everything live and commits nothing while the transcript fits the live window", () => {
    const frame = buildFrame(
      ["banner"],
      [
        { id: "a", lines: ["a1", "a2"] },
        { id: "b", lines: ["b1"] },
      ],
      20,
    );
    const { state, committed, live } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    expect(committed).toEqual([]);
    expect(state.bannerCommitted).toBe(false);
    expect(texts(live)).toEqual(["banner", "a1", "a2", "b1"]);
  });

  test("commits the banner with the first settled block once the tail exceeds the live window", () => {
    const frame = buildFrame(
      ["banner"],
      [
        { id: "a", lines: ["a1", "a2"] },
        { id: "b", lines: ["b1", "b2"] },
        { id: "c", lines: ["c1", "c2"] },
      ],
      3,
    );
    const { state, committed, live } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    // banner + a (3 lines) fits under commitBudget (8 total - 3 live = 5); b
    // straddles the boundary, so its first line commits partially and the rest
    // stays live alongside the streaming block c.
    expect(state.bannerCommitted).toBe(true);
    expect(state.committedBlockIds).toEqual(["a"]);
    expect(state.partialBlockId).toBe("b");
    expect(texts(committed)).toEqual(["banner", "a1", "a2", "b1"]);
    expect(texts(live)).toEqual(["b2", "c1", "c2"]);
  });

  test("commits the stable prefix lines of a tall last block, keeping the live window live", () => {
    const frame = buildFrame(
      [],
      [
        { id: "a", lines: ["a1"] },
        { id: "tall", lines: ["t1", "t2", "t3", "t4", "t5", "t6"] },
      ],
      2,
    );
    const { state, committed, live } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    // The last block may still be streaming, so it never commits as a whole,
    // but its lines above the live window freeze so a long reply scrolls into
    // native scrollback continuously instead of pinning whole in the tail.
    expect(state.committedBlockIds).toEqual(["a"]);
    expect(state.partialBlockId).toBe("tall");
    expect(state.partialLineCount).toBe(4);
    expect(texts(committed)).toEqual(["a1", "t1", "t2", "t3", "t4"]);
    expect(texts(live)).toEqual(["t5", "t6"]);
  });

  test("partial commit of a streaming block advances monotonically as it grows", () => {
    let state = emptyTranscriptCommitState();
    ({ state } = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "a", lines: ["a1"] },
        { id: "s", lines: ["s1", "s2", "s3"] },
      ], 2),
    ));
    expect(state.partialBlockId).toBe("s");
    expect(state.partialLineCount).toBe(1);
    expect(texts(state.committedLines)).toEqual(["a1", "s1"]);

    const grown = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "a", lines: ["a1"] },
        { id: "s", lines: ["s1", "s2", "s3", "s4", "s5"] },
      ], 2),
    );
    expect(grown.state.partialLineCount).toBe(3);
    expect(texts(grown.committed)).toEqual(["a1", "s1", "s2", "s3"]);
    expect(texts(grown.live)).toEqual(["s4", "s5"]);
  });

  test("a partially committed block finishes committing only its remaining lines", () => {
    let state = emptyTranscriptCommitState();
    ({ state } = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "a", lines: ["a1"] },
        { id: "s", lines: ["s1", "s2", "s3"] },
      ], 2),
    ));
    expect(state.partialLineCount).toBe(1);

    // A new block lands after the stream; the partial block commits its
    // remainder exactly once — no duplicated lines in scrollback.
    const after = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "a", lines: ["a1"] },
        { id: "s", lines: ["s1", "s2", "s3"] },
        { id: "n", lines: ["n1", "n2"] },
      ], 2),
    );
    expect(after.state.committedBlockIds).toEqual(["a", "s"]);
    expect(after.state.partialBlockId).toBeNull();
    expect(texts(after.committed)).toEqual(["a1", "s1", "s2", "s3"]);
    expect(texts(after.live)).toEqual(["n1", "n2"]);
  });

  test("settling on abort commits the already-frozen prefix without re-emitting it", () => {
    let state = emptyTranscriptCommitState();
    // A long reply streams while pinned: most of it partial-commits as it grows.
    ({ state } = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "s", lines: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] },
      ], 3),
    ));
    expect(state.partialLineCount).toBe(5);

    // Abort settles everything at once and a trailing error block lands. Only
    // the lines above the live window move — the settle does not dump the
    // whole block into scrollback in one jump.
    const settled = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "s", lines: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] },
        { id: "err", lines: ["Aborted."] },
      ], 3),
    );
    expect(texts(settled.committed)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(texts(settled.live)).toEqual(["s7", "s8", "Aborted."]);
  });

  test("a pending last block never partial-commits", () => {
    const frame = buildFrame(
      [],
      [
        { id: "a", lines: ["a1"] },
        { id: "p", lines: ["p1", "p2", "p3", "p4"], settled: false },
      ],
      1,
    );
    const { state, committed, live } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    // A pending tool row still mutates (clock, merge with its result), so none
    // of its lines may freeze.
    expect(state.partialBlockId).toBeNull();
    expect(texts(committed)).toEqual(["a1"]);
    expect(texts(live)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  test("commit is monotonic and appends only newly settled blocks across frames", () => {
    let state = emptyTranscriptCommitState();
    const blocks: BlockSpec[] = [
      { id: "a", lines: ["a1", "a2"] },
      { id: "b", lines: ["b1"] },
    ];
    ({ state } = advanceTranscriptCommit(state, buildFrame(["banner"], blocks, 10)));
    expect(state.committedLines).toEqual([]);

    blocks.push({ id: "c", lines: ["c1", "c2", "c3"] });
    blocks.push({ id: "d", lines: ["d1"] });
    const second = advanceTranscriptCommit(state, buildFrame(["banner"], blocks, 3));
    expect(second.state.committedBlockIds).toEqual(["a", "b"]);
    expect(texts(second.committed)).toEqual(["banner", "a1", "a2", "b1", "c1"]);
    expect(texts(second.live)).toEqual(["c2", "c3", "d1"]);
  });

  test("a width change re-wraps the live region without re-emitting frozen history", () => {
    let state = emptyTranscriptCommitState();
    const wide: BlockSpec[] = [
      { id: "a", lines: ["a-wide"] },
      { id: "b", lines: ["b-wide"] },
      { id: "c", lines: ["c-wide"] },
    ];
    ({ state } = advanceTranscriptCommit(state, buildFrame(["banner"], wide, 1)));
    const frozen = texts(state.committedLines);
    expect(state.committedBlockIds).toEqual(["a", "b"]);

    // Same blocks, re-wrapped narrower: committed blocks a and b keep their frozen
    // wide lines; the still-live block c reflects the new width, and its lines
    // above the live window commit at the new wrap.
    const narrow: BlockSpec[] = [
      { id: "a", lines: ["a-nar", "row"] },
      { id: "b", lines: ["b-nar", "row"] },
      { id: "c", lines: ["c-nar", "row"] },
    ];
    const after = advanceTranscriptCommit(state, buildFrame(["banner"], narrow, 1));
    expect(texts(after.committed)).toEqual([...frozen, "c-nar"]);
    expect(texts(after.live)).toEqual(["row"]);
  });

  test("front-trimming already-committed blocks leaves scrollback frozen and live correct", () => {
    let state = emptyTranscriptCommitState();
    const blocks: BlockSpec[] = [
      { id: "a", lines: ["a1"] },
      { id: "b", lines: ["b1"] },
      { id: "c", lines: ["c1"] },
      { id: "d", lines: ["d1"] },
    ];
    ({ state } = advanceTranscriptCommit(state, buildFrame(["banner"], blocks, 1)));
    expect(state.committedBlockIds).toEqual(["a", "b", "c"]);
    const frozen = texts(state.committedLines);

    // The oldest committed blocks (a, b) are trimmed from the retained set. The
    // newest committed block (c) is still present, so this is not a reset.
    const trimmed: BlockSpec[] = [
      { id: "c", lines: ["c1"] },
      { id: "d", lines: ["d1"] },
      { id: "e", lines: ["e1"] },
    ];
    const after = advanceTranscriptCommit(state, buildFrame(["banner"], trimmed, 1));
    expect(texts(after.committed)).toEqual([...frozen, "d1"]);
    expect(after.state.committedBlockIds).toEqual(["a", "b", "c", "d"]);
    expect(texts(after.live)).toEqual(["e1"]);
  });

  test("a generation bump resets committed history and remounts via a new epoch", () => {
    let state = emptyTranscriptCommitState();
    ({ state } = advanceTranscriptCommit(
      state,
      buildFrame(["banner"], [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"] },
        { id: "c", lines: ["c1"] },
      ], 1),
    ));
    expect(state.committedBlockIds.length).toBeGreaterThan(0);

    // clear() reset blockSeq, so the fresh session reuses the prior ids (b1...).
    // Only the explicit generation bump marks the transcript as replaced.
    const cleared = advanceTranscriptCommit(
      state,
      buildFrame(["banner"], [{ id: "a", lines: ["fresh"] }], 10, 1),
    );
    expect(cleared.committed).toEqual([]);
    expect(cleared.state.committedBlockIds).toEqual([]);
    expect(cleared.state.epoch).toBe(state.epoch + 1);
    expect(cleared.state.generation).toBe(1);
    expect(texts(cleared.live)).toEqual(["banner", "fresh"]);
  });

  test("reused block ids without a generation bump are not treated as a reset", () => {
    let state = emptyTranscriptCommitState();
    ({ state } = advanceTranscriptCommit(
      state,
      buildFrame(["banner"], [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"] },
        { id: "c", lines: ["c1"] },
      ], 1),
    ));
    const epochBefore = state.epoch;

    // A front-trim recycles no ids here; the point is that even a fully disjoint
    // id set at the same generation must not bump the epoch or drop scrollback.
    const after = advanceTranscriptCommit(
      state,
      buildFrame(["banner"], [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"] },
        { id: "c", lines: ["c1"] },
        { id: "d", lines: ["d1"] },
      ], 1),
    );
    expect(after.state.epoch).toBe(epochBefore);
    expect(after.state.committedBlockIds).toEqual(["a", "b", "c"]);
  });

  test("a block with a pending tool call is never committed", () => {
    const frame = buildFrame(
      [],
      [
        { id: "a", lines: ["a1"] },
        { id: "pending", lines: ["p1"], settled: false },
        { id: "c", lines: ["c1"] },
        { id: "d", lines: ["d1"] },
      ],
      1,
    );
    const { state, committed, live } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    // "a" settles and fits under budget, but the pending block halts the commit
    // walk, so it and everything after it stay live.
    expect(state.committedBlockIds).toEqual(["a"]);
    expect(texts(committed)).toEqual(["a1"]);
    expect(texts(live)).toEqual(["p1", "c1", "d1"]);
  });

  test("a pending block commits once its tool call settles", () => {
    let state = emptyTranscriptCommitState();
    const pendingFrame = buildFrame(
      [],
      [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"], settled: false },
        { id: "c", lines: ["c1"] },
      ],
      1,
    );
    ({ state } = advanceTranscriptCommit(state, pendingFrame));
    expect(state.committedBlockIds).toEqual(["a"]);

    const settledFrame = buildFrame(
      [],
      [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"] },
        { id: "c", lines: ["c1"] },
      ],
      1,
    );
    const after = advanceTranscriptCommit(state, settledFrame);
    expect(after.state.committedBlockIds).toEqual(["a", "b"]);
    expect(texts(after.committed)).toEqual(["a1", "b1"]);
    expect(texts(after.live)).toEqual(["c1"]);
  });

  test("committedLines grows in place across commits without re-copying the backbuffer", () => {
    let state = emptyTranscriptCommitState();
    ({ state } = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"] },
        { id: "c", lines: ["c1"] },
      ], 1),
    ));
    expect(state.committedBlockIds).toEqual(["a", "b"]);
    const backbuffer = state.committedLines;

    const after = advanceTranscriptCommit(
      state,
      buildFrame([], [
        { id: "a", lines: ["a1"] },
        { id: "b", lines: ["b1"] },
        { id: "c", lines: ["c1"] },
        { id: "d", lines: ["d1"] },
      ], 1),
    );
    // The same backing array is extended, not rebuilt, so a commit costs the new
    // block's height rather than the whole committed history.
    expect(after.state.committedLines).toBe(backbuffer);
    expect(after.state.committedBlockIds).toEqual(["a", "b", "c"]);
    expect(texts(after.committed)).toEqual(["a1", "b1", "c1"]);
  });

  test("committed history is exactly the banner followed by committed blocks in order", () => {
    const frame = buildFrame(
      ["b1", "b2"],
      [
        { id: "a", lines: ["a1", "a2", "a3"] },
        { id: "b", lines: ["b1", "b2"] },
        { id: "c", lines: ["c1"] },
      ],
      2,
    );
    const { committed } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    expect(texts(committed)).toEqual(["b1", "b2", "a1", "a2", "a3", "b1"]);
  });
});
