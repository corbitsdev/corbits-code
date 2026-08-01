import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildLinesIncremental,
  buildResourceBanner,
  clearMarkdownLineCache,
  DEFAULT_MAX_RENDERED_LOG_LINES,
  maxLineOffset,
  resolveViewportExpandIds,
  type IncrementalLinesState,
  type RenderableBlock,
} from "../components/event-log.js";
import type { StyledLine } from "../view/index.js";
import { subAgentScrollWindow, subAgentTranscriptWidth, renderTranscriptLines } from "../components/subagent-session-view.js";
import { useScroll, type ScrollController } from "./use-scroll.js";
import type { AgentStreamView } from "../use-stream.js";
import type { SubAgentSession } from "../../subagent/index.js";

function sortedSetKey(ids: ReadonlySet<string>): string {
  const values: string[] = [];
  ids.forEach((id) => {
    values.push(id);
  });
  return values.sort().join("\x1f");
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  return sortedSetKey(a) === sortedSetKey(b);
}

export type UseTranscriptLayoutArgs = {
  state: AgentStreamView;
  contentWidth: number;
  thinkingExpanded: boolean;
  expandedTools: ReadonlySet<string>;
  verbose: boolean;
  visibleRows: number;
  loadedSkills: readonly { name: string }[] | undefined;
  activePlugins: readonly string[] | undefined;
  cwd: string;
  telemetryNotice: string | undefined;
  enteredSession: SubAgentSession | undefined;
};

export type TranscriptLayoutController = {
  eventLogLines: StyledLine[];
  scrollMaxOffset: number;
  scroll: ScrollController;
  enteredScroll: ScrollController;
  activeScroll: ScrollController;
  lastToolId: string | null;
  viewportExpandedIds: Set<string>;
  setViewportExpandedIds: (ids: Set<string>) => void;
  prefixLineCount: number;
  incrementalLinesRef: { current: IncrementalLinesState | undefined };
  baseLinesRef: { current: IncrementalLinesState | undefined };
};

export function useTranscriptLayout({
  state,
  contentWidth,
  thinkingExpanded,
  expandedTools,
  verbose,
  visibleRows,
  loadedSkills,
  activePlugins,
  cwd,
  telemetryNotice,
  enteredSession,
}: UseTranscriptLayoutArgs): TranscriptLayoutController {
  // Cleared when layout width or thinking expand change — those affect all blocks.
  // Verbose no longer invalidates the cache: each block already keys collapsed vs
  // expanded layouts separately, and Ctrl+O only expands a viewport-local subset.
  const lineCacheRef = useRef(new Map<string, StyledLine[]>());
  const baseLinesRef = useRef<IncrementalLinesState | undefined>(undefined);
  const incrementalLinesRef = useRef<IncrementalLinesState | undefined>(undefined);
  const lineCacheKeysRef = useRef({ contentWidth, thinkingExpanded });
  if (
    lineCacheKeysRef.current.contentWidth !== contentWidth ||
    lineCacheKeysRef.current.thinkingExpanded !== thinkingExpanded
  ) {
    lineCacheRef.current.clear();
    clearMarkdownLineCache();
    baseLinesRef.current = undefined;
    incrementalLinesRef.current = undefined;
    lineCacheKeysRef.current = { contentWidth, thinkingExpanded };
  }

  // Tools Ctrl+O expands for the current viewport (± buffer). Refreshed after
  // scroll in a layout effect so line layout can depend on a stable Set.
  const [viewportExpandedIds, setViewportExpandedIds] = useState<Set<string>>(() => new Set());

  const explicitExpandKey = useMemo(
    () => sortedSetKey(expandedTools),
    [expandedTools],
  );

  const baseLayoutKey = useMemo(
    () => [
      contentWidth,
      thinkingExpanded ? "1" : "0",
      explicitExpandKey,
      String(state.currentPlanStep),
      state.planDeviated ? "1" : "0",
    ].join("|"),
    [contentWidth, thinkingExpanded, explicitExpandKey, state.currentPlanStep, state.planDeviated],
  );

  const isExplicitlyExpanded = useMemo(
    () => (block: RenderableBlock) => expandedTools.has(block.id),
    [expandedTools],
  );

  // Collapsed layout (explicit Ctrl+R expands only). Reused as the display when
  // verbose is off so toggling Ctrl+O does not throw away the warm incremental state.
  const membershipBase = useMemo(
    () => {
      const next = buildLinesIncremental(
        baseLinesRef.current,
        state.contentBlocks,
        contentWidth,
        thinkingExpanded,
        isExplicitlyExpanded,
        lineCacheRef.current,
        { currentStep: state.currentPlanStep, deviated: state.planDeviated },
        baseLayoutKey,
        DEFAULT_MAX_RENDERED_LOG_LINES,
      );
      baseLinesRef.current = next;
      return next;
    },
    // lineCacheRef is a stable ref — intentionally not in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.displayRevision, baseLayoutKey, contentWidth, thinkingExpanded, isExplicitlyExpanded, state.currentPlanStep, state.planDeviated],
  );

  const resourceBanner = useMemo(
    () => buildResourceBanner(loadedSkills ?? [], activePlugins ?? [], contentWidth, cwd, telemetryNotice),
    [loadedSkills, activePlugins, contentWidth, cwd, telemetryNotice],
  );

  const prefixLineCount =
    resourceBanner.length + (state.trimmedBlockCount > 0 ? 2 : 0);

  const viewportExpandKey = useMemo(
    () => {
      if (!verbose || viewportExpandedIds.size === 0) return "";
      return sortedSetKey(viewportExpandedIds);
    },
    [verbose, viewportExpandedIds],
  );

  const linesLayoutKey = useMemo(
    () => [
      baseLayoutKey,
      verbose ? "1" : "0",
      viewportExpandKey,
    ].join("|"),
    [baseLayoutKey, verbose, viewportExpandKey],
  );

  const isViewportExpanded = useMemo(
    () => {
      if (!verbose || viewportExpandedIds.size === 0) return isExplicitlyExpanded;
      return (block: RenderableBlock) =>
        expandedTools.has(block.id) || viewportExpandedIds.has(block.id);
    },
    [verbose, viewportExpandedIds, expandedTools, isExplicitlyExpanded],
  );

  const eventLogLines = useMemo(
    () => {
      let next: IncrementalLinesState;
      if (!verbose) {
        next = membershipBase;
        incrementalLinesRef.current = next;
      } else {
        next = buildLinesIncremental(
          incrementalLinesRef.current,
          state.contentBlocks,
          contentWidth,
          thinkingExpanded,
          isViewportExpanded,
          lineCacheRef.current,
          { currentStep: state.currentPlanStep, deviated: state.planDeviated },
          linesLayoutKey,
          DEFAULT_MAX_RENDERED_LOG_LINES,
        );
        incrementalLinesRef.current = next;
      }
      return state.trimmedBlockCount > 0
        ? [
            ...resourceBanner,
            [
              { text: `↑ ${state.trimmedBlockCount} earlier message${state.trimmedBlockCount === 1 ? "" : "s"} trimmed to keep the session responsive`, dim: true },
            ] satisfies StyledLine,
            [],
            ...next.lines,
          ]
        : [...resourceBanner, ...next.lines];
    },
    // lineCacheRef is a stable ref — intentionally not in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.displayRevision, state.trimmedBlockCount, membershipBase, linesLayoutKey, contentWidth, thinkingExpanded, verbose, isViewportExpanded, state.currentPlanStep, state.planDeviated, resourceBanner],
  );
  const scrollMaxOffset = maxLineOffset(eventLogLines, visibleRows);

  const lastToolId = useMemo(() => {
    const blocks = state.contentBlocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.type === "tool_call") return blocks[i]!.id;
    }
    return null;
  }, [state.contentBlocks]);

  const scroll = useScroll({ maxOffset: scrollMaxOffset });

  // The entered child view owns its own scroll: the parent transcript and the
  // child transcript have unrelated line counts, so one shared offset would
  // scroll the hidden parent while the child stayed pinned to its newest rows.
  const enteredTranscriptLineCount = useMemo(() => {
    if (enteredSession === undefined) return 0;
    return renderTranscriptLines(
      enteredSession.entries,
      subAgentTranscriptWidth(contentWidth),
    ).length;
  }, [enteredSession, contentWidth]);
  const enteredScrollMaxOffset = subAgentScrollWindow(
    enteredTranscriptLineCount,
    visibleRows,
    0,
  ).maxOffset;
  const enteredScroll = useScroll({ maxOffset: enteredScrollMaxOffset });
  const activeScroll = enteredSession !== undefined ? enteredScroll : scroll;

  // Ctrl+O expands tools intersecting the visible window. Membership uses the
  // *display* layout (same line space as scrollOffset) so mid-scroll tracking
  // stays correct after tools grow. Sticky hold + tool-count cap keep the set
  // from thrashing or exploding under dense tool rows. Toggle seeds the set
  // synchronously so the first verbose paint is already expanded.
  useLayoutEffect(() => {
    if (!verbose) {
      if (viewportExpandedIds.size > 0) setViewportExpandedIds(new Set());
      return;
    }

    const layout = incrementalLinesRef.current;
    if (layout === undefined) return;

    const nextIds = resolveViewportExpandIds({
      blocks: layout.blocks,
      blockLineStarts: layout.blockLineStarts,
      lineCount: layout.lines.length,
      prefixLineCount,
      visibleRows,
      scrollOffset: scroll.scrollOffset,
      atBottom: scroll.atBottom,
      previousIds: viewportExpandedIds,
    });

    if (sameStringSet(nextIds, viewportExpandedIds)) return;
    setViewportExpandedIds(nextIds);
  }, [
    verbose,
    scroll.scrollOffset,
    scroll.atBottom,
    visibleRows,
    // Recompute when either layout changes (content, expand set, prefix).
    membershipBase,
    eventLogLines,
    prefixLineCount,
    viewportExpandedIds,
  ]);

  return {
    eventLogLines,
    scrollMaxOffset,
    scroll,
    enteredScroll,
    activeScroll,
    lastToolId,
    viewportExpandedIds,
    setViewportExpandedIds,
    prefixLineCount,
    incrementalLinesRef,
    baseLinesRef,
  };
}
