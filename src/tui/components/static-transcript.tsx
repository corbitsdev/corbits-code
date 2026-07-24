import { Box, Static } from "ink";
import { memo, useMemo, type ReactNode } from "react";
import type { ContentBlock } from "../use-stream.js";
import {
  buildLines,
  RenderedLine,
  RunningToolRow,
  runningStartOfLine,
  type PlanContext,
} from "./event-log.js";

// CL-4358 spike: prototype committing settled turns to Ink's <Static> so they
// land in native terminal scrollback, while the in-flight turn keeps rendering
// through the same block-to-lines pipeline in a plain, uncommitted region.
// Gated behind an off-by-default flag; see ink-static-spike.md for the
// adopt/keep recommendation and the tradeoffs this prototype was built to
// measure.

/**
 * Splits the flat content-block stream into per-turn groups, then separates
 * the turn currently being produced (the "tail") from turns that have
 * finished (the "settled" turns). A turn starts at a "user" block; blocks
 * before the first user block form their own leading turn (e.g. a resumed
 * session's saved history).
 */
export function partitionSettledTurns(
  contentBlocks: readonly ContentBlock[],
  turnInFlight: boolean,
): { settled: ContentBlock[][]; tail: ContentBlock[] } {
  const turns: ContentBlock[][] = [];
  let current: ContentBlock[] = [];

  for (const block of contentBlocks) {
    if (block.type === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) turns.push(current);

  if (!turnInFlight || turns.length === 0) {
    return { settled: turns, tail: [] };
  }

  return { settled: turns.slice(0, -1), tail: turns[turns.length - 1]! };
}

function turnKey(group: readonly ContentBlock[], index: number): string {
  return group[0]?.id ?? `turn-${index}`;
}

type SettledTurnProps = {
  group: readonly ContentBlock[];
  width: number;
  thinkingExpanded: boolean;
  planCtx?: PlanContext;
};

const neverExpanded = () => false;

// One turn's committed lines, built once and handed to <Static>. Ink never
// re-invokes this renderer for a turn once it has been painted, so this
// component's own re-renders (if any) do not repaint scrollback.
const SettledTurn = memo(function SettledTurn({
  group,
  width,
  thinkingExpanded,
  planCtx,
}: SettledTurnProps): ReactNode {
  const lines = useMemo(
    () => buildLines(group as ContentBlock[], width, thinkingExpanded, neverExpanded, undefined, planCtx),
    [group, width, thinkingExpanded, planCtx],
  );

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <RenderedLine key={i} line={line} width={width} />
      ))}
    </Box>
  );
});

export type StaticTranscriptProps = {
  /** Completed turns, oldest first. Committed to native scrollback via <Static>. */
  settledGroups: ContentBlock[][];
  /** Blocks belonging to the turn still being produced, if any. */
  tailBlocks: ContentBlock[];
  width: number;
  thinkingExpanded: boolean;
  planCtx?: PlanContext;
};

/**
 * Spike prototype for CL-4358: renders settled turns through Ink's <Static> —
 * each turn is written once and becomes part of real terminal scrollback,
 * unlike the app-managed viewport in event-log.tsx — and keeps the streaming
 * tail in a normal, repeatedly-rendered region below it.
 */
export function StaticTranscript({
  settledGroups,
  tailBlocks,
  width,
  thinkingExpanded,
  planCtx,
}: StaticTranscriptProps): ReactNode {
  const tailLines = useMemo(
    () => buildLines(tailBlocks as ContentBlock[], width, thinkingExpanded, neverExpanded, undefined, planCtx),
    [tailBlocks, width, thinkingExpanded, planCtx],
  );

  return (
    <Box flexDirection="column">
      <Static items={settledGroups}>
        {(group, index) => (
          <SettledTurn
            key={turnKey(group, index)}
            group={group}
            width={width}
            thinkingExpanded={thinkingExpanded}
            {...(planCtx !== undefined ? { planCtx } : {})}
          />
        )}
      </Static>
      <Box flexDirection="column">
        {tailLines.map((line, i) => {
          const startedAt = runningStartOfLine(line);
          return startedAt !== undefined
            ? <RunningToolRow key={`tail-${i}`} line={line} width={width} startedAt={startedAt} />
            : <RenderedLine key={`tail-${i}`} line={line} width={width} />;
        })}
      </Box>
    </Box>
  );
}
