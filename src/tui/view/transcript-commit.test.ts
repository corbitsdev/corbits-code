import { describe, expect, test } from "bun:test";
import type { StyledLine } from "./index.js";
import {
  advanceTranscriptCommit,
  emptyTranscriptCommitState,
  type TranscriptFrame,
} from "./transcript-commit.js";

type BlockSpec = { id: string; lines: string[] };

function line(text: string): StyledLine {
  return [{ text }];
}

function buildFrame(
  banner: string[],
  blocks: BlockSpec[],
  liveRows: number,
): TranscriptFrame {
  const blockLines: StyledLine[] = [];
  const blockLineStarts: number[] = [];
  const blockIds: string[] = [];
  for (const block of blocks) {
    blockLineStarts.push(blockLines.length);
    blockIds.push(block.id);
    for (const text of block.lines) blockLines.push(line(text));
  }
  return {
    bannerLines: banner.map(line),
    blockLines,
    blockLineStarts,
    blockIds,
    liveRows,
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
    // straddles the boundary so it stays live alongside the streaming block c.
    expect(state.bannerCommitted).toBe(true);
    expect(state.committedBlockIds).toEqual(["a"]);
    expect(texts(committed)).toEqual(["banner", "a1", "a2"]);
    expect(texts(live)).toEqual(["b1", "b2", "c1", "c2"]);
  });

  test("never commits the last block even when it is taller than the live window", () => {
    const frame = buildFrame(
      [],
      [
        { id: "a", lines: ["a1"] },
        { id: "tall", lines: ["t1", "t2", "t3", "t4", "t5", "t6"] },
      ],
      2,
    );
    const { state, committed, live } = advanceTranscriptCommit(emptyTranscriptCommitState(), frame);
    expect(state.committedBlockIds).toEqual(["a"]);
    expect(texts(committed)).toEqual(["a1"]);
    expect(texts(live)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
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
    expect(texts(second.committed)).toEqual(["banner", "a1", "a2", "b1"]);
    expect(texts(second.live)).toEqual(["c1", "c2", "c3", "d1"]);
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
    // wide lines; only the still-live block c reflects the new width.
    const narrow: BlockSpec[] = [
      { id: "a", lines: ["a-nar", "row"] },
      { id: "b", lines: ["b-nar", "row"] },
      { id: "c", lines: ["c-nar", "row"] },
    ];
    const after = advanceTranscriptCommit(state, buildFrame(["banner"], narrow, 1));
    expect(texts(after.committed)).toEqual(frozen);
    expect(texts(after.live)).toEqual(["c-nar", "row"]);
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

  test("a fresh transcript resets committed history", () => {
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

    // All-new ids: a /clear replaced the transcript.
    const cleared = advanceTranscriptCommit(
      state,
      buildFrame(["banner"], [{ id: "x", lines: ["x1"] }], 10),
    );
    expect(cleared.committed).toEqual([]);
    expect(cleared.state.committedBlockIds).toEqual([]);
    expect(cleared.state.epoch).toBe(state.epoch + 1);
    expect(texts(cleared.live)).toEqual(["banner", "x1"]);
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
    expect(texts(committed)).toEqual(["b1", "b2", "a1", "a2", "a3"]);
  });
});
