import { describe, expect, test } from "bun:test";
import { useRef, type ReactNode } from "react";
import { render } from "ink-testing-library";
import { EventLog } from "./event-log.js";
import {
  advanceTranscriptCommit,
  emptyTranscriptCommitState,
  type TranscriptCommitState,
  type TranscriptFrame,
} from "../view/transcript-commit.js";

type Spec = { id: string; lines: string[]; settled?: boolean };

function frameFrom(
  banner: string[],
  blocks: Spec[],
  liveRows: number,
  generation: number,
): TranscriptFrame {
  const blockLines: { text: string }[][] = [];
  const blockLineStarts: number[] = [];
  const blockIds: string[] = [];
  const blockRenderLineCounts: number[] = [];
  const blockSettled: boolean[] = [];
  for (const block of blocks) {
    blockLineStarts.push(blockLines.length);
    blockIds.push(block.id);
    blockRenderLineCounts.push(block.lines.length);
    blockSettled.push(block.settled ?? true);
    for (const text of block.lines) blockLines.push([{ text }]);
  }
  return {
    bannerLines: banner.map((text) => [{ text }]),
    blockLines,
    blockLineStarts,
    blockIds,
    blockRenderLineCounts,
    blockSettled,
    liveRows,
    generation,
  };
}

// Mirrors app.tsx's transcript wiring: the commit state lives in a ref across
// renders, advances against the incoming frame, and the epoch keys <EventLog> so
// a reset remounts the <Static> host.
function Harness({ frame }: { frame: TranscriptFrame }): ReactNode {
  const ref = useRef<TranscriptCommitState>(emptyTranscriptCommitState());
  const split = advanceTranscriptCommit(ref.current, frame);
  ref.current = split.state;
  return (
    <EventLog
      key={split.state.epoch}
      committedLines={split.committed}
      liveLines={split.live}
      visibleRows={frame.liveRows}
      width={40}
    />
  );
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("EventLog transcript rendering", () => {
  test("renders both the committed scrollback and the live tail", () => {
    // banner + a (3 lines) fit under the budget; b and the streaming tail stay live.
    const frame = frameFrom(
      ["BANNER"],
      [
        { id: "a", lines: ["ALPHA1", "ALPHA2"] },
        { id: "b", lines: ["BETA1", "BETA2"] },
        { id: "c", lines: ["GAMMA1", "GAMMA2"] },
      ],
      3,
      0,
    );
    const { lastFrame } = render(<Harness frame={frame} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("BANNER");
    expect(out).toContain("ALPHA1");
    expect(out).toContain("BETA1");
    expect(out).toContain("GAMMA1");
  });

  test("a generation bump shows the new session even when block ids collide", () => {
    // clear() resets blockSeq, so the fresh session reuses id "a". Without the
    // explicit generation reset the renderer treats "a" as already committed and
    // the new session renders nothing.
    const first = frameFrom(
      ["BANNER"],
      [
        { id: "a", lines: ["OLD1"] },
        { id: "b", lines: ["OLD2"] },
        { id: "c", lines: ["OLD3"] },
      ],
      1,
      0,
    );
    const { lastFrame, rerender } = render(<Harness frame={first} />);
    expect(lastFrame() ?? "").toContain("OLD1");

    const cleared = frameFrom(["BANNER"], [{ id: "a", lines: ["FRESH"] }], 3, 1);
    rerender(<Harness frame={cleared} />);
    expect(lastFrame() ?? "").toContain("FRESH");
  });

  test("a front-trim does not re-emit the banner", () => {
    const seeded = frameFrom(
      ["BANNER"],
      [
        { id: "a", lines: ["A1"] },
        { id: "b", lines: ["B1"] },
        { id: "c", lines: ["C1"] },
        { id: "d", lines: ["D1"] },
      ],
      1,
      0,
    );
    const { lastFrame, rerender } = render(<Harness frame={seeded} />);
    expect(occurrences(lastFrame() ?? "", "BANNER")).toBe(1);

    // The oldest committed blocks drop off the front; c is still retained, so the
    // same generation continues and the banner is not committed a second time.
    const trimmed = frameFrom(
      ["BANNER"],
      [
        { id: "c", lines: ["C1"] },
        { id: "d", lines: ["D1"] },
        { id: "e", lines: ["E1"] },
      ],
      1,
      0,
    );
    rerender(<Harness frame={trimmed} />);
    expect(occurrences(lastFrame() ?? "", "BANNER")).toBe(1);
  });

  test("a pending tool call is never frozen into committed scrollback", () => {
    // "PENDROW" belongs to a block with an unsettled tool call. It renders in the
    // live tail, so when it later leaves the block set it disappears — a committed
    // line would have been frozen into static output and persisted instead.
    const pending = frameFrom(
      [],
      [
        { id: "a", lines: ["SETTLED"] },
        { id: "p", lines: ["PENDROW"], settled: false },
        { id: "tail", lines: ["TAIL"] },
      ],
      1,
      0,
    );
    const { lastFrame, rerender } = render(<Harness frame={pending} />);
    expect(lastFrame() ?? "").toContain("PENDROW");

    const withoutPending = frameFrom(
      [],
      [
        { id: "a", lines: ["SETTLED"] },
        { id: "tail", lines: ["TAIL"] },
      ],
      1,
      0,
    );
    rerender(<Harness frame={withoutPending} />);
    expect(lastFrame() ?? "").not.toContain("PENDROW");
  });

  test("a block hands off from live to committed once it settles", () => {
    const pending = frameFrom(
      [],
      [
        { id: "a", lines: ["AAA"] },
        { id: "b", lines: ["BBB"], settled: false },
        { id: "c", lines: ["CCC"] },
      ],
      1,
      0,
    );
    const { lastFrame, rerender } = render(<Harness frame={pending} />);
    // While b is pending only a can commit; b renders in the live tail.
    expect(lastFrame() ?? "").toContain("BBB");

    const settled = frameFrom(
      [],
      [
        { id: "a", lines: ["AAA"] },
        { id: "b", lines: ["BBB"] },
        { id: "c", lines: ["CCC"] },
      ],
      1,
      0,
    );
    rerender(<Harness frame={settled} />);
    // b has now settled and committed; the whole transcript remains on screen.
    const out = lastFrame() ?? "";
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
    expect(out).toContain("CCC");
  });
});
