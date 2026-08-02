import { Box, Text } from "ink";
import { memo, useMemo, type ReactNode } from "react";
import { formatElapsed } from "./in-flight-indicator.js";
import { elapsedMsFromAnchor } from "../hooks/use-spinner.js";
import type { StyledSegment } from "../markdown-parser.js";
import type { StyledLine } from "../view/index.js";
import { stringWidth } from "../view/height.js";
import { color } from "../theme.js";
import { inkPropsForSegment } from "../styled-segment-props.js";
import { osc8Hyperlink } from "../osc8.js";
import {
  RUNNING_ELAPSED_RESERVE,
  lineWindow,
  mergeAdjacentSegments,
  runningStartOfLine,
  uniformBackground,
} from "./event-log-assembly.js";

export {
  buildLines,
  buildLinesIncremental,
  buildResourceBanner,
  capViewportToolIds,
  blockIdsInLineRange,
  clearMarkdownLineCache,
  DEFAULT_MAX_RENDERED_LOG_LINES,
  DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS,
  isRenderable,
  lineWindow,
  maxLineOffset,
  renderableBlocks,
  resolveViewportExpandIds,
  RUNNING_ELAPSED_RESERVE,
  TEXT_GUTTER,
  viewportToolIds,
  type IncrementalLinesState,
  type PlanContext,
  type RenderableBlock,
  type ResolveViewportExpandIdsArgs,
  type ViewportToolIdsArgs,
} from "./event-log-assembly.js";

export type EventLogProps = {
  lines: StyledLine[];
  scrollOffset: number;
  visibleRows: number;
  width: number;
};

function segmentProps(seg: StyledSegment) {
  return inkPropsForSegment(seg);
}

type RenderedLineProps = {
  line: StyledLine;
  width: number;
};

const RenderedLine = memo(function RenderedLine({ line, width }: RenderedLineProps): ReactNode {
  const segments = useMemo(() => {
    const textWidth = line.reduce((n, s) => n + stringWidth(s.text), 0);
    const pad = Math.max(0, width - textWidth);
    const rowBg = uniformBackground(line);
    const padSeg: StyledSegment = { text: " ".repeat(pad), ...(rowBg !== undefined ? { backgroundColor: rowBg } : {}) };
    const padded = pad > 0 ? [...line, padSeg] : line;
    return mergeAdjacentSegments(padded);
  }, [line, width]);

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} {...segmentProps(seg)}>
          {seg.linkUrl !== undefined && seg.linkUrl.length > 0 ? osc8Hyperlink(seg.linkUrl, seg.text) : seg.text}
        </Text>
      ))}
    </Text>
  );
}, (prev, next) => prev.line === next.line && prev.width === next.width);

type RunningToolRowProps = {
  line: StyledLine;
  width: number;
  startedAt: number;
};

// The session's single live spinner lives in the bottom status row
// (InFlightIndicator); a pending transcript row must not animate a second one.
// This glyph is fixed rather than driven by a ticking interval, so the row
// never re-renders on its own — it only repaints when the shared lines change.
const PENDING_GLYPH = "○";

// A pending tool row shows a static "still running" marker — glyph plus
// elapsed-so-far clock — without a repaint interval of its own, since that
// would draw a second animated spinner alongside the status row's.
const RunningToolRow = memo(function RunningToolRow({ line, width, startedAt }: RunningToolRowProps): ReactNode {
  const hasSpinner = line[0]?.toolRunningSince !== undefined;
  const hasElapsed = line[line.length - 1]?.toolRunningSince !== undefined;
  const segments = useMemo(() => {
    // The glyph occupies the indent gutter the anchor seg held (glyph + space),
    // so the headline text keeps its column and the row width stays stable.
    // The glyph and clock replace/extend the anchor segments, which may carry
    // a status-card backgroundColor (pending wash) — preserve it so the wash
    // does not break at the glyph or clock boundary.
    const rowBg = line[0]?.backgroundColor;
    const bgProp = rowBg !== undefined ? { backgroundColor: rowBg } : {};
    const head: StyledLine = hasSpinner
      ? [{ text: `${PENDING_GLYPH} `, color: color("live"), ...bgProp }, ...line.slice(1)]
      : [...line];
    // The clock is the one datum this row exists to show. Trim it to the
    // reserved width so an hour-plus elapsed can never soft-wrap the row.
    const elapsedMs = elapsedMsFromAnchor(startedAt);
    const clock = ` · ${formatElapsed(elapsedMs)}`.slice(0, RUNNING_ELAPSED_RESERVE);
    const composed: StyledLine = hasElapsed
      ? [...head, { text: clock, color: color("text"), ...bgProp }]
      : head;
    const textWidth = composed.reduce((n, s) => n + stringWidth(s.text), 0);
    const pad = Math.max(0, width - textWidth);
    const composedBg = uniformBackground(composed);
    const padSeg: StyledSegment = {
      text: " ".repeat(pad),
      ...(composedBg !== undefined ? { backgroundColor: composedBg } : {}),
    };
    const padded = pad > 0 ? [...composed, padSeg] : composed;
    return mergeAdjacentSegments(padded);
  }, [line, width, hasSpinner, hasElapsed, startedAt]);

  // Truncate rather than wrap: the live clock is appended outside the wrap budget,
  // so on an unreserved wide row (a shell command near full width) it clips at the
  // column edge instead of soft-wrapping onto a second terminal line, which would
  // desync the fixed-row viewport accounting until the tool completes.
  return (
    <Text wrap="truncate">
      {segments.map((seg, i) => (
        <Text key={i} {...segmentProps(seg)}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
});

// Memoized so typing in the prompt — which re-renders the App shell on every
// keystroke — does not re-walk the visible window unless the lines, scroll
// position, or viewport actually change.
export const EventLog = memo(function EventLog({
  lines,
  scrollOffset,
  visibleRows,
  width,
}: EventLogProps): ReactNode {
  const contentWidth = Math.max(1, width);
  const { start, end } = lineWindow(lines, scrollOffset, visibleRows);
  const visible = lines.slice(start, end);
  const missingRows = Math.max(0, visibleRows - visible.length);

  // Pad above the window so short transcripts sit on the last row of the viewport,
  // flush with the prompt chrome instead of leaving a dead band at the bottom.
  return (
    <Box flexDirection="column">
      {Array.from({ length: missingRows }, (_, i) => <RenderedLine key={`blank-top-${i}`} line={[]} width={contentWidth} />)}
      {visible.map((line, i) => {
        const startedAt = runningStartOfLine(line);
        return startedAt !== undefined
          ? <RunningToolRow key={`line-${start + i}`} line={line} width={contentWidth} startedAt={startedAt} />
          : <RenderedLine key={`line-${start + i}`} line={line} width={contentWidth} />;
      })}
    </Box>
  );
});
