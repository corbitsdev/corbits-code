/**
 * Persistent chrome: paint, notice row, lockup frame, landing, panels,
 * flash status, focus application.
 */
import { homedir } from "node:os";
import {
  clampBoardRows,
  type ActivityState,
  type AgentPanelRow,
  type ChromeZoneContent,
  type TaskPanelRow,
} from "../chrome-state.js";
import {
  BoxRenderable,
  TextRenderable,
  StyledText,
  fg as fgChunk,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";
import { sliceTailToWidth, sliceToWidth, stringWidth } from "../view/height.js";
import { promptRowCount } from "../prompt-input.js";
import { promptBoxRows } from "../geometry/zones.js";
import { composeNoticeLine, resolveWaitingOn } from "../notice-line.js";
import {
  fitPendingRow,
  PENDING_COLUMN_HINT,
  pendingColumnHeight,
  pendingColumnRows,
} from "../pending-column.js";
import {
  lockupCells,
  lockupText,
  lockupWidth,
  type LockupInput,
} from "../lockup.js";
import type { RampPhase, StallAge } from "../ramp.js";
import {
  BORDER,
  composeAttentionLabel,
  composeRule,
  composeWorkspaceLabel,
  costContextText,
  type RulePart,
} from "../prompt-border.js";
import {
  focusOwner,
  focusPrompt,
  focusTranscript,
  popFocus,
} from "../focus/index.js";
import {
  resolveBottomMarginRows,
  resolveGeometry,
  resolveTopPadRows,
  type GeometryLayout,
} from "../geometry/index.js";
import {
  fitLandingMark,
  landingSuggestionFor,
  paintLandingBelow,
  paintLandingMark,
  resolveMarkGrid,
  versionBadgeVisible,
} from "../landing.js";
import {
  evictedRowsNotice,
  trimRetainedLog,
  unloadedHistoryNotice,
} from "../long-log.js";
import { destroySubtree } from "../teardown.js";
import {
  badgeCount,
  enqueue,
  setRunState,
  steerCount,
  type RunState,
} from "../delivery-queue.js";
import {
  agentVoicesIn,
  isCollapsibleRow,
  MAIN_AGENT,
  type StreamRow,
} from "../stream.js";
import { UI } from "../theme.js";
import {
  isDecisionOverlay,
  overlayRowsPerItem,
  overlayChromeRows,
} from "../overlay-view.js";
import { DECISION_CHOICE_ROWS } from "../overlay-body.js";

import {
  type AppShell,
  type FlashOptions,
  type FlashSchedule,
  flashTimers,
  isLanding,
  isTranscriptFollowing,
  type OverlayAnswerState,
  type OverlayList,
  shellFlashSchedules,
  shellInternals,
  transcriptSpacers,
} from "./internals.js";
import {
  defaultVisibility,
  fleetTranscriptFloor,
  landingSplitFor,
  type RelayoutOpts,
  terminalForGeometry,
  terminalOf,
} from "./layout.js";
import {
  buildRowNode,
  evictionMarkers,
  gapBefore,
  labelBefore,
  noteAgentVoice,
  retextStreamRow,
  transcriptMarker,
  transcriptRowChildren,
  transcriptRowLayout,
  transcriptRowOffset,
} from "./transcript.js";

function syncPending(shell: AppShell): void {
  shell.pendingQueue = badgeCount(shell.session);
}

/** The transient row's text for the current state ("" when it has nothing to say). */
export function noticeText(shell: AppShell): string {
  return composeNoticeLine({
    waitingOn: resolveWaitingOn(
      steerCount(shell.session),
      shell.inFlightTool,
      shell.lockupNowMs,
    ),
    interrupt: shell.session.interruptFlash,
    pinned: !isTranscriptFollowing(shell),
    flash: shell.statusFlash,
    attachments: shell.pendingAttachments.length,
  });
}

/** Which MCP servers are waiting on authorization. Repaints on change. */
export function setMcpNeedsAuth(
  shell: AppShell,
  names: readonly string[],
): void {
  const next = [...names];
  if (
    shell.mcpNeedsAuth.length === next.length &&
    next.every((name) => shell.mcpNeedsAuth.includes(name))
  ) {
    return;
  }
  shell.mcpNeedsAuth = next;
  paintChrome(shell);
}

/** Whether plugin load warnings still need attention. Repaints on change. */
export function setPluginNeedsAttention(shell: AppShell, needs: boolean): void {
  if (shell.pluginNeedsAttention === needs) return;
  shell.pluginNeedsAttention = needs;
  paintChrome(shell);
}

/**
 * Key over every input chrome paint reads; a missed input leaves stale
 * chrome. Keep exhaustive; landing and zone paints read their own state.
 */
function chromeComposeKey(shell: AppShell, notice: string): string {
  const meter = shell.costContext;
  return [
    notice,
    pendingColumnRows(shell.session.items)
      .map((row) => `${row.tag ?? ""}:${row.text}`)
      .join("\u0001"),
    shellInternals(shell)?.pendingSelId ?? "",
    shell.layout.contentWidth,
    shell.mcpNeedsAuth.length > 0 ? "1" : "0",
    shell.pluginNeedsAttention ? "1" : "0",
    shell.modelLabel ?? "",
    shell.lockupNowMs,
    shell.lockupAnimating ? "1" : "0",
    shell.lockupPhase ?? "",
    shell.lockupChangedMs,
    shell.lockupRampPhase ?? "",
    String(shell.lockupStalledForMs),
    shell.workspace.cwd,
    shell.workspace.branch,
    homedir(),
    meter === null
      ? ""
      : `${meter.band}\u0001${meter.percentLabel}\u0001${meter.costLabel ?? ""}`,
    shell.prompt.value.length,
  ].join("\u0000");
}

const paintedChromeKey = new WeakMap<AppShell, string>();
const chromeComposeCounts = new WeakMap<AppShell, number>();

/** Compose passes run since mount. Test seam for the repaint gate. */
export function chromeComposeCount(shell: AppShell): number {
  return chromeComposeCounts.get(shell) ?? 0;
}

/** Repaint only when the composed key changed; `force` bypasses the gate
 * when a relayout moved the tree under identical text. */
export function paintChrome(
  shell: AppShell,
  opts?: { readonly force?: boolean },
): void {
  if (shell.disposed) return;
  // Headless tests destroy the renderer without dispose; a flash armed
  // before that teardown must not write a buffer the harness freed.
  if (shell.renderer.isDestroyed || shell.notice.isDestroyed) return;
  syncPending(shell);
  const notice = noticeText(shell);
  const key = chromeComposeKey(shell, notice);
  if (!opts?.force && paintedChromeKey.get(shell) === key) return;
  paintedChromeKey.set(shell, key);
  chromeComposeCounts.set(shell, chromeComposeCount(shell) + 1);
  shell.notice.content = new StyledText([
    fgChunk(UI.textDim)(notice.length > 0 ? ` ${notice}` : ""),
  ]);
  syncPendingRows(shell);
  paintPromptBorder(shell);
  syncLandingSuggestions(shell);
  syncNoticeRow(shell, notice);
  syncPendingColumn(shell);
}

/** Rebuild pendingBox rows only when the painted content moved; unchanged
 * queues cost a signature compare, not a rebuild. */
function syncPendingRows(shell: AppShell): void {
  const bag = shellInternals(shell);
  const granted = Math.max(0, shell.layout.heights.pending);
  // The last granted row is the key-guidance line; items fill what is left.
  const rows = pendingColumnRows(shell.session.items, Math.max(0, granted - 1));
  // A drained or cancelled item cannot stay selected.
  if (
    bag !== undefined &&
    bag.pendingSelId !== null &&
    !shell.session.items.some((item) => item.id === bag.pendingSelId)
  ) {
    bag.pendingSelId = null;
  }
  const selId = bag?.pendingSelId ?? null;
  const key =
    `${shell.layout.contentWidth} ${granted} ${selId ?? ""}` +
    rows.map((row) => `${row.tag ?? ""}:${row.text}`).join("\u0001");
  if (paintedPendingKey.get(shell) === key) return;
  paintedPendingKey.set(shell, key);
  for (const child of [...shell.pendingBox.getChildren()]) {
    shell.pendingBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    const selected = row.id !== null && row.id === selId;
    const fitted = fitPendingRow(row, shell.layout.contentWidth, selected);
    shell.pendingBox.add(
      new TextRenderable(shell.renderer as CliRenderer, {
        content: new StyledText([
          fgChunk(selected ? UI.text : UI.textFaint)(fitted.head),
          fgChunk(
            row.tag === null ? UI.textFaint : selected ? UI.text : UI.textDim,
          )(fitted.text),
        ]),
      }),
    );
  }
  if (rows.length > 0 && granted > rows.length) {
    shell.pendingBox.add(
      new TextRenderable(shell.renderer as CliRenderer, {
        content: new StyledText([
          fgChunk(UI.textFaint)(
            ` ${sliceToWidth(PENDING_COLUMN_HINT, shell.layout.contentWidth)}`,
          ),
        ]),
      }),
    );
  }
}

/** Signature of what the pending column last painted, per shell. */
const paintedPendingKey = new WeakMap<AppShell, string>();

/** Give the pending column rows only while the queue has items — same
 * transient contract as the notice row. */
function syncPendingColumn(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (bag === undefined) return;
  const wanted = pendingColumnHeight(shell.session.items.length);
  if ((bag.visibility.pending ?? 0) === wanted) return;
  relayout(shell, { visibility: { ...bag.visibility, pending: wanted } });
}

/** Keep the notice row only while it has text; relayout re-enters
 * paintChrome with the visibility already correct. */
function syncNoticeRow(shell: AppShell, notice: string): void {
  paintedNotice.set(shell, notice);
  const bag = shellInternals(shell);
  if (bag === undefined) return;
  const wanted = notice.length > 0;
  if ((bag.visibility.notice ?? false) === wanted) return;
  relayout(shell, { visibility: { ...bag.visibility, notice: wanted } });
}

/** Re-read the notice after layout: `pinned` reflects the last completed
 * layout, so a mid-paint read can misread a following transcript as
 * pinned for a frame. */
export function syncNoticeAfterLayout(shell: AppShell): void {
  if (noticeText(shell) !== paintedNotice.get(shell)) paintChrome(shell);
}

/** Notice wording currently on the row, for the post-layout re-read. */
const paintedNotice = new WeakMap<AppShell, string>();

/** Withdraw or restore the landing starters as the prompt fills and empties. */
function syncLandingSuggestions(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  const landing = bag.landing;
  const content = bag.landingBelow;
  if (landing === null || content === null) return;
  const visible = shell.prompt.value.length === 0;
  if (visible === bag.landingSuggestionsVisible) return;
  bag.landingSuggestionsVisible = visible;
  paintLandingBelow(landing.below, content, visible);
}

/** Callers own the tick; repaint only when the frame differs. A phase
 * change stamps the fade origin; settling snaps to idle — a stuck frame
 * is worse than none. */
export interface LockupFrame {
  readonly nowMs: number;
  readonly animating: boolean;
  /** Live activity state, or null for the idle wordmark (closed set, no raw tool ids). */
  readonly phase: ActivityState | null;
  /** The turn's ramp phase, or null when idle. */
  readonly rampPhase: RampPhase | null;
  /** How long the turn has been stalled, or null when it is not stalled. */
  readonly stalledForMs: StallAge;
}

export function setLockupFrame(shell: AppShell, frame: LockupFrame): void {
  const settled = !frame.animating && !shell.lockupAnimating;
  shell.lockupNowMs = frame.nowMs;
  const phaseChanged = frame.phase !== shell.lockupPhase;
  if (phaseChanged) {
    shell.lockupPhase = frame.phase;
    shell.lockupChangedMs = frame.nowMs;
  }
  const changed =
    phaseChanged ||
    frame.rampPhase !== shell.lockupRampPhase ||
    frame.stalledForMs !== shell.lockupStalledForMs;
  shell.lockupRampPhase = frame.rampPhase;
  shell.lockupStalledForMs = frame.stalledForMs;
  if (settled && !changed && shell.lockupAnimating === frame.animating) return;
  shell.lockupAnimating = frame.animating;
  paintChrome(shell);
}

const defaultFlashSchedule: FlashSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  // A pending flash must never keep the process alive.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
  };
};

/** Set a non-destructive flash and repaint (no streamLog touch). A
 * `ttlMs` flash self-clears when its window lapses; omit it for
 * persistent conditions. */
export function setStatusFlash(
  shell: AppShell,
  message: string | null,
  options?: FlashOptions,
): void {
  flashTimers.get(shell)?.();
  flashTimers.delete(shell);
  shell.statusFlash = message;
  paintChrome(shell);
  const ttlMs = options?.ttlMs;
  if (message === null || ttlMs === undefined || ttlMs <= 0) return;
  if (shell.disposed || shell.renderer.isDestroyed) return;
  const schedule =
    options?.schedule ?? shellFlashSchedules.get(shell) ?? defaultFlashSchedule;
  flashTimers.set(
    shell,
    schedule(() => {
      flashTimers.delete(shell);
      // Only this flash expires — a later one owns its own row.
      if (shell.statusFlash !== message) return;
      shell.statusFlash = null;
      paintChrome(shell);
    }, ttlMs),
  );
}

/** Apply focus state to OpenTUI focusables. */
export function applyFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  // Observe is a read-only child view; blur it so the parent prompt cannot
  // swallow its keystrokes.
  if (owner === "overlay" || owner === "palette" || owner === "observe") {
    if (typeof shell.prompt.blur === "function") {
      shell.prompt.blur();
    }
  } else if (owner === "transcript") {
    shell.transcript.focus();
  } else {
    shell.prompt.focus();
  }
  paintChrome(shell);
}

export function shellFocusPrompt(shell: AppShell): void {
  shell.focus = focusPrompt(shell.focus);
  applyFocus(shell);
}

export function shellFocusTranscript(shell: AppShell): void {
  shell.focus = focusTranscript(shell.focus);
  applyFocus(shell);
}

export function toggleShellFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  if (owner === "overlay" || owner === "palette") return;
  if (owner === "transcript") {
    shellFocusPrompt(shell);
  } else {
    shellFocusTranscript(shell);
  }
}

export function overlayAnswerState(shell: AppShell): OverlayAnswerState | null {
  return shellInternals(shell)?.overlayAnswer ?? null;
}

/** Stacking order for the floated overlay host; one step clears the landing. */
const OVERLAY_FLOAT_Z = 10;

/** Float the overlay host over the root column, or back in. Landing: it
 * floats as a modal so the mark stays beneath; a transcript pushes rows
 * instead of covering them. */
function floatOverlayHost(
  shell: AppShell,
  floating: boolean,
  top: number,
): void {
  const host = shell.overlayHost;
  if (!floating) {
    host.position = "relative";
    host.zIndex = 0;
    // A stale absolute top from a landing float acts as an in-flow offset;
    // clear it so the band sits where flow put it.
    host.top = 0;
    host.left = 0;
    host.width = "100%";
    return;
  }
  host.position = "absolute";
  // Absolute positioning escapes root's padding: give the sideMargin back
  // and use the same contentWidth the prompt box resolves to.
  host.left = shell.layout.sideMargin;
  host.width = shell.layout.contentWidth;
  host.top = top;
  host.zIndex = OVERLAY_FLOAT_Z;
}

/** Stable id for the focused row: `itemIds[index]` when supplied, else its label. */
export function activeOverlayItemId(
  shell: AppShell,
  list: OverlayList,
): string {
  const bag = shellInternals(shell);
  return (
    bag?.primaryBindings.itemIds[list.activeIndex] ??
    shell.overlayItems[list.activeIndex] ??
    String(list.activeIndex)
  );
}

export function paintOverlayList(shell: AppShell): void {
  const list = shell.overlayList;
  if (!list) return;
  // Use geometry's host rows, not overlayHost.height: OpenTUI still reports
  // the dummy height 1 until the next layout pass.
  const hostH = Math.max(0, shell.layout.overlayHeight);
  if (hostH > 0) {
    fitOverlayListToHost(shell, hostH);
    return;
  }
  paintOverlayListContents(shell);
}

function paintOverlayListContents(shell: AppShell): void {
  const list = shell.overlayList;
  if (!list) return;
  const bag = shellInternals(shell);
  shell.overlayView.paintList(
    {
      kind: shell.overlayKind,
      items: shell.overlayItems,
      ...(bag !== undefined ? { itemIds: bag.primaryBindings.itemIds } : {}),
      paletteCommands: shell.paletteCommands,
      list,
      bodyLines: shell.overlayBodyLines,
      bodyFgs: shell.overlayBodyFgs,
      answer: overlayAnswerState(shell),
      describe: () => {
        const describe = shellInternals(shell)?.primaryBindings.describe;
        return describe
          ? describe(activeOverlayItemId(shell, list))
          : undefined;
      },
    },
    shell.layout.contentWidth,
  );
}

/** Faint frame so labels read brighter; the brand run swaps in the
 * lockup's cells — the border's only animating part. */
function ruleChunks(shell: AppShell, parts: readonly RulePart[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const part of parts) {
    if (part.role === "brand") {
      const cells = lockupCells(lockupFrameInput(shell));
      chunks.push(fgChunk(UI.textFaint)(" "));
      for (const cell of cells) chunks.push(fgChunk(cell.fg)(cell.char));
      chunks.push(fgChunk(UI.textFaint)(" "));
      continue;
    }
    if (part.role === "meter") {
      chunks.push(...meterChunks(shell, part.text));
      continue;
    }
    if (part.role === "attention") {
      chunks.push(fgChunk(UI.warning)(part.text));
      continue;
    }
    chunks.push(
      fgChunk(part.role === "label" ? UI.textDim : UI.textFaint)(part.text),
    );
  }
  return chunks;
}

/** Color a meter cell: the percent takes the band color (`textDim`, sand,
 * red), the optional cost suffix stays dim chrome. */
function meterChunks(shell: AppShell, cell: string): TextChunk[] {
  const meter = shell.costContext;
  const percentFg =
    meter?.band === "danger"
      ? UI.error
      : meter?.band === "warning"
        ? UI.warning
        : UI.textDim;
  if (meter === null) return [fgChunk(percentFg)(cell)];
  const percent = meter.percentLabel;
  const idx = cell.indexOf(percent);
  if (idx === -1) return [fgChunk(percentFg)(cell)];
  const before = cell.slice(0, idx);
  const after = cell.slice(idx + percent.length);
  const chunks: TextChunk[] = [];
  if (before.length > 0) chunks.push(fgChunk(UI.textFaint)(before));
  chunks.push(fgChunk(percentFg)(percent));
  if (after.length > 0) chunks.push(fgChunk(UI.textDim)(after));
  return chunks;
}

/** The status slot's state, as the lockup renderer wants it. */
function lockupFrameInput(shell: AppShell): LockupInput {
  return {
    nowMs: shell.lockupNowMs,
    still: !shell.lockupAnimating,
    phase: shell.lockupPhase,
    changedMs: shell.lockupChangedMs,
    rampPhase: shell.lockupRampPhase,
    stalledForMs: shell.lockupStalledForMs,
  };
}

/** Repaint both border rules. A resize moves the column budget; the lockup
 * animates in place — both shift the compose key. */
export function paintPromptBorder(shell: AppShell): void {
  const width = shell.layout.contentWidth;
  const attention = composeAttentionLabel({
    mcp: shell.mcpNeedsAuth.length > 0,
    plugin: shell.pluginNeedsAttention,
  });
  const top = composeRule({
    width,
    corners: [BORDER.topLeft, BORDER.topRight],
    ...(attention !== undefined ? { attention } : {}),
    ...(shell.modelLabel !== null ? { label: shell.modelLabel } : {}),
  });
  shell.promptTopRule.content = new StyledText(ruleChunks(shell, top));

  // The workspace shares the row with the lockup only when both fit; when
  // only one fits, the information wins and the mark goes.
  const withBrand = Math.max(
    0,
    width - 9 - lockupWidth(lockupFrameInput(shell)),
  );
  const alone = Math.max(0, width - 6);
  const workspaceInput = {
    cwd: shell.workspace.cwd,
    branch: shell.workspace.branch,
    home: homedir(),
  };
  // A pathless workspace is a bare branch; the mark yields when it would
  // starve the path, not only when the label cannot fit.
  const roomyRaw = composeWorkspaceLabel({
    ...workspaceInput,
    maxWidth: withBrand,
  });
  const roomy = roomyRaw.startsWith("(") ? "" : roomyRaw;
  const workspace =
    roomy.length > 0
      ? roomy
      : composeWorkspaceLabel({ ...workspaceInput, maxWidth: alone });
  const brand = lockupText(lockupCells(lockupFrameInput(shell)));
  const meter = shell.costContext;
  const bottom = composeRule({
    width,
    corners: [BORDER.bottomLeft, BORDER.bottomRight],
    ...(roomy.length > 0 || workspace.length === 0 ? { brand } : {}),
    ...(meter !== null
      ? {
          meter: costContextText(meter, true),
          meterCompact: costContextText(meter, false),
        }
      : {}),
    ...(workspace.length > 0 ? { label: workspace } : {}),
  });
  shell.promptBottomRule.content = new StyledText(ruleChunks(shell, bottom));
}

/** Shrink overlay body and list to fit the host; on a short terminal,
 * drop context first so one choice stays answerable. */
function fitOverlayListToHost(shell: AppShell, hostH: number): void {
  const list = shell.overlayList;
  if (!list || hostH <= 0) return;
  const bag = shellInternals(shell);
  const hasDesc = !!bag?.primaryBindings.describe;
  const hasAnswer = overlayAnswerState(shell) !== null;
  const perItem = overlayRowsPerItem(shell.overlayKind);
  const hasItems = shell.overlayItems.length > 0;
  const choiceWant = hasItems ? perItem : 0;
  const choiceMin = hasItems ? 1 : 0;
  let bodyCount = shell.overlayBodyLines.length;
  const chromeOf = (n: number): number =>
    overlayChromeRows(shell.overlayKind, n, hasDesc, hasAnswer);
  let chrome = chromeOf(bodyCount);
  while (bodyCount > 0 && hostH - chrome < choiceMin) {
    bodyCount -= 1;
    chrome = chromeOf(bodyCount);
  }
  while (bodyCount > 0 && hostH - chrome < choiceWant) {
    bodyCount -= 1;
    chrome = chromeOf(bodyCount);
  }
  const bodyH = Math.max(0, hostH - chrome);
  if (hasItems && bodyH >= perItem) {
    list.setHeight(
      Math.max(1, Math.floor(bodyH / perItem)),
      isDecisionOverlay(shell.overlayKind) ? DECISION_CHOICE_ROWS : 1,
    );
  } else if (bodyH >= 1 && hasItems) {
    list.setHeight(1, 1);
  }
  const savedLines = shell.overlayBodyLines;
  const savedFgs = shell.overlayBodyFgs;
  if (bodyCount < savedLines.length) {
    shell.overlayBodyLines = savedLines.slice(0, bodyCount);
    shell.overlayBodyFgs = savedFgs.slice(0, bodyCount);
  }
  try {
    paintOverlayListContents(shell);
  } finally {
    shell.overlayBodyLines = savedLines;
    shell.overlayBodyFgs = savedFgs;
  }
}

export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  // Width changes move the column budget, so every painted row is rebuilt
  // rather than reflowed.
  const widthChanged =
    shell.layout.contentWidth !== layout.contentWidth ||
    shell.layout.chatWidth !== layout.chatWidth ||
    shell.layout.layoutMode !== layout.layoutMode;
  shell.layout = layout;
  const h = layout.heights;

  shell.root.paddingLeft = layout.sideMargin;
  shell.root.paddingRight = layout.sideMargin;

  // Use the raw renderer size, not `layout.terminal` (net of the badge's
  // row) — the threshold must not check its own effect. Landing-only.
  shell.versionRow.visible =
    isLanding(shell) &&
    versionBadgeVisible(shell.renderer.width, shell.renderer.height);

  const taskH = Math.max(0, h.task);
  shell.taskBox.height = taskH > 0 ? taskH : 1;
  shell.taskBox.visible = taskH > 0;

  const agentsH = Math.max(0, h.agents);
  shell.agentsBox.visible = agentsH > 0;

  // Both pads come out of the transcript residual, never chrome, so the
  // resolver's row budget still sums to the terminal height.
  const transcriptH = Math.max(0, h.transcript);
  const padH = resolveTopPadRows(transcriptH);
  shell.topPad.height = padH > 0 ? padH : 1;
  shell.topPad.visible = padH > 0;

  const bottomPadH = resolveBottomMarginRows(layout.terminal.rows);
  shell.bottomPad.height = bottomPadH > 0 ? bottomPadH : 1;
  shell.bottomPad.visible = bottomPadH > 0;

  const overlayH = Math.max(0, h.overlay_host);

  // The landing splits the residual around the prompt box; an open overlay
  // floats over it, so the overlay host's rows go back to the split.
  const bag = shellInternals(shell);
  const landing = bag?.landing ?? null;
  const landingRows =
    transcriptH - padH - bottomPadH + (landing === null ? 0 : overlayH);
  // overlayH is the overlay's real content, capped by fraction/floor limits —
  // the right minimum for the landing split; less starves the list.
  const split =
    landing === null ? null : landingSplitFor(landingRows, overlayH, padH);
  if (bag !== undefined && landing !== null && split !== null) {
    landing.above.box.height = Math.max(1, split.above);
    // A new zone can seat a different tier/grid, so the mark is redrawn.
    fitLandingMark(
      landing.above,
      resolveMarkGrid(split.above, layout.contentWidth),
    );
    paintLandingMark(
      landing.above,
      bag.landingNowMs,
      !bag.landingAnimating,
      bag.reducedMotion,
    );
    landing.below.height = Math.max(0, split.below);
    landing.below.visible = split.below > 0;
  }

  const transcriptBody =
    split === null ? transcriptH - padH - bottomPadH : Math.max(1, split.above);
  shell.transcript.height = transcriptBody > 0 ? transcriptBody : 1;
  shell.transcript.visible = transcriptBody > 0;
  syncTranscriptSpacer(shell);

  // Agents strip: full-width flex stack under the transcript when present.
  // Live chrome keeps the zone empty (spawn_agent transcript rows instead).
  shell.agentsBox.position = "relative";
  shell.agentsBox.left = 0;
  shell.agentsBox.top = 0;
  shell.agentsBox.width = "100%";
  shell.agentsBox.height = agentsH > 0 ? agentsH : 1;
  shell.agentsBox.zIndex = 0;
  shell.transcript.width = "100%";

  const noticeH = Math.max(0, h.notice);
  shell.notice.height = noticeH > 0 ? noticeH : 1;
  shell.notice.visible = noticeH > 0;

  const pendingH = Math.max(0, h.pending);
  shell.pendingBox.height = pendingH > 0 ? pendingH : 1;
  shell.pendingBox.visible = pendingH > 0;

  const promptH = Math.max(0, h.prompt);
  shell.promptBox.height = promptH > 0 ? promptH : 1;
  shell.promptBox.visible = promptH > 0;
  const showPromptRules = promptH >= 2;
  const showPromptField = promptH >= 3;
  shell.promptTopRule.visible = showPromptRules || promptH === 1;
  shell.promptBottomRule.visible = showPromptRules;
  shell.promptField.visible = showPromptField;
  // The field takes whatever the box has left once both labelled rules are paid.
  const promptInnerH = showPromptField ? Math.max(1, promptH - 2) : 1;
  shell.promptField.height = promptInnerH;
  // Sized explicitly: past the cap the input scrolls inside a fixed window
  // instead of pushing the frame open.
  shell.prompt.height = promptInnerH;

  // Sized last: the float anchors against chrome sized earlier in this pass.
  const floating = landing !== null && overlayH > 0;
  // A floated host's bottom edge must land above the mid-screen landing box;
  // covering it would hide what the operator types. Stack: topPad, transcript,
  // agents, task, prompt (notice and pending are transient).
  const promptTop = padH + transcriptBody + agentsH + taskH;
  const hostH = floating
    ? Math.min(overlayH, Math.max(1, promptTop))
    : overlayH;
  floatOverlayHost(shell, floating, Math.max(0, promptTop - hostH));
  shell.overlayHost.height = hostH > 0 ? hostH : 1;
  shell.overlayHost.visible = hostH > 0;
  if (hostH > 0 && shell.overlayList) {
    fitOverlayListToHost(shell, hostH);
  }

  paintPromptBorder(shell);

  // The landing owns the transcript's children until the first row lands.
  if (widthChanged && shell.streamLog.length > 0 && !isLanding(shell)) {
    repaintTranscriptWindow(shell);
  }

  // A width change moves the column budget; content may be unchanged, so
  // setChromeZones would skip the rebuild — do it here.
  if (widthChanged && bag !== undefined) {
    if (bag.chrome.task.length > 0) {
      renderTasksRows(shell, bag.chrome.task, layout.contentWidth);
    }
    if (bag.chrome.agents.length > 0) {
      renderAgentsRows(
        shell,
        clampBoardRows(bag.chrome.agents, agentsH),
        layout.contentWidth,
      );
    }
  }

  // Forced: a relayout can move the render tree under identical composed
  // text, so the trailing chrome pass always recomposes.
  paintChrome(shell, { force: true });
}

/** Re-size the prompt box to its content; geometry re-resolves only when
 * the row count moves (once per wrapped line). */
export function syncPromptRows(shell: AppShell): void {
  const rows = promptBoxRows(
    promptRowCount(shell.prompt),
    shell.renderer.height,
  );
  if (rows === shell.layout.heights.prompt) return;
  relayout(shell, { promptContentRows: rows });
}

/**
 * Resize the leading filler to soak up leftover viewport space, reading
 * `scrollHeight` minus the filler. Not at row-mutation time: a mid-layout
 * row reads short for a frame, so a filler grown then would bury it. The
 * render-frame hook calls it after that pass.
 */
export function syncTranscriptSpacer(shell: AppShell): void {
  const spacer = transcriptSpacers.get(shell);
  if (spacer === undefined) return;
  // The landing already bottom-anchors its mark via the above/below split; a
  // filler would double-count and squeeze it.
  if (isLanding(shell)) {
    if (spacer.height !== 0) spacer.height = 0;
    return;
  }
  const rowsHeight = Math.max(0, shell.transcript.scrollHeight - spacer.height);
  const nextHeight = Math.max(0, shell.transcript.height - rowsHeight);
  if (spacer.height !== nextHeight) spacer.height = nextHeight;
}

export function relayout(shell: AppShell, opts?: RelayoutOpts): GeometryLayout {
  const bag = shellInternals(shell);
  const visibility = opts?.visibility ?? bag?.visibility ?? defaultVisibility();
  const promptContentRows = opts?.promptContentRows ?? bag?.promptContentRows;
  const overlayMode = opts?.overlayMode ?? bag?.overlayMode ?? "closed";
  const overlayBodyRows = opts?.overlayBodyRows ?? bag?.overlayBodyRows;
  const overlayMinBodyRows =
    opts?.overlayMinBodyRows ?? bag?.overlayMinBodyRows;
  if (bag) {
    bag.visibility = visibility;
    bag.promptContentRows = promptContentRows;
    bag.overlayMode = overlayMode;
    bag.overlayBodyRows = overlayBodyRows;
    bag.overlayMinBodyRows = overlayMinBodyRows;
  }

  const columns = opts?.columns ?? shell.renderer.width;
  const rows = opts?.rows ?? shell.renderer.height;
  const terminal = terminalOf(shell.renderer, { columns, rows });
  // Only the landing gives up a row for the version badge; with transcript
  // content the badge stops showing rather than taking space back.
  const versionReserved = isLanding(shell);
  const layout = resolveGeometry({
    terminal: versionReserved ? terminalForGeometry(terminal) : terminal,
    visibility,
    overlay:
      overlayMode === "closed"
        ? { mode: "closed" }
        : {
            mode: overlayMode,
            ...(overlayBodyRows !== undefined
              ? { bodyRows: overlayBodyRows }
              : {}),
            ...(overlayMinBodyRows !== undefined
              ? { minBodyRows: overlayMinBodyRows }
              : {}),
          },
    ...(promptContentRows !== undefined ? { promptContentRows } : {}),
    // The landing owns the screen until the first row lands; a transcript
    // floor would only clip overlays. An open overlay is the exception —
    // otherwise a long list claims the whole screen.
    ...(isLanding(shell) && overlayMode === "closed"
      ? { transcriptFloor: 0 }
      : fleetTranscriptFloor(shell)),
  });
  applyLayout(shell, layout);
  return layout;
}

/** Append a raw line to the sticky transcript ScrollBox (auto-follows
 * until the operator scrolls up). */
export function appendTranscript(
  shell: AppShell,
  line: string,
  opts?: { readonly fg?: string },
): void {
  clearLandingMark(shell);
  // A raw paint like any other: it breaks a run of identical system echoes.
  paintSequence.set(shell, (paintSequence.get(shell) ?? 0) + 1);
  shell.lineCount += 1;
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${line}`,
      fg: opts?.fg ?? UI.text,
    }),
  );
  paintChrome(shell);
}

/** Append a role-styled stream row to the parent transcript. While
 * observing, rows go to the parent snapshot only (not painted); leave
 * restores them. */
export function appendStreamRow(shell: AppShell, row: StreamRow): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    shell.parentStreamLog.push(row);
    shell.parentStreamLogBase = trimRetainedLog(
      shell.parentStreamLog,
      shell.parentStreamLogBase ?? 0,
    );
    return;
  }
  paintAppendStreamRow(shell, row);
}

/** Paint the dropped-rows notice when on-disk history hit the retention
 * cap before trim ran. Does not bump `streamLogBase`: faking the splice
 * offset would orphan the first retained row. */
export function noteUnloadedHistory(shell: AppShell): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    if (shell.parentStreamLog.length > 0) {
      shell.parentUnloadedHistory = true;
    }
    return;
  }
  if (shell.streamLog.length === 0) return;
  shell.unloadedHistory = true;
  paintDroppedHistoryMarker(shell);
}

function droppedHistoryNotice(shell: AppShell): string {
  return shell.streamLogBase > 0
    ? evictedRowsNotice(shell.streamLogBase)
    : unloadedHistoryNotice();
}

function paintDroppedHistoryMarker(shell: AppShell): void {
  const content = droppedHistoryNotice(shell);
  const marker = transcriptMarker(shell);
  if (marker instanceof TextRenderable) {
    marker.content = content;
    return;
  }
  const node = new TextRenderable(shell.renderer as CliRenderer, {
    content,
    fg: UI.textDim,
  });
  evictionMarkers.add(node);
  shell.transcript.add(node, 1);
}

/** Append a child stream row while observing a subagent (host-pushed live
 * events, not only seed lines). No-op when not observing.
 * @returns true when the row reached the observe view */
export function appendObserveStreamRow(
  shell: AppShell,
  row: StreamRow,
): boolean {
  if (shell.observe === null) return false;
  shell.observe.lines.push(row);
  paintAppendStreamRow(shell, row);
  return true;
}

/** Collapse a system row identical to the one on top (startup echoes
 * stutter) only when nothing painted since. Observe rows paint without
 * touching the parent log, so adjacency alone would swallow a "left
 * observe" farewell; the sequence check restores it. */
const paintSequence = new WeakMap<AppShell, number>();
const systemPushSequence = new WeakMap<AppShell, number>();

function isDuplicateSystemEcho(shell: AppShell, row: StreamRow): boolean {
  if (row.role !== "system") return false;
  const top = shell.streamLog[shell.streamLog.length - 1];
  if (
    top === undefined ||
    top.role !== "system" ||
    top.text !== row.text ||
    (top.agent ?? MAIN_AGENT) !== (row.agent ?? MAIN_AGENT) ||
    top.meta !== row.meta
  ) {
    return false;
  }
  // The in-flight call already advanced the sequence; the top row is
  // back-to-back only when the immediately previous paint pushed it.
  const seq = paintSequence.get(shell) ?? 0;
  return systemPushSequence.get(shell) === seq - 1;
}

/** Push onto the visible streamLog (child while observing, parent
 * otherwise). The paint tree stays 1:1 with the retention-capped log, so
 * a trim past the cap costs one node removal, not a rebuild. */
function paintAppendStreamRow(shell: AppShell, row: StreamRow): void {
  clearLandingMark(shell);
  const seq = (paintSequence.get(shell) ?? 0) + 1;
  paintSequence.set(shell, seq);
  if (isDuplicateSystemEcho(shell, row)) {
    systemPushSequence.set(shell, seq);
    return;
  }
  const gainedVoice = noteAgentVoice(shell, row);
  shell.streamLog.push(row);
  if (row.role === "system") systemPushSequence.set(shell, seq);
  const baseBefore = shell.streamLogBase;
  shell.streamLogBase = trimRetainedLog(shell.streamLog, shell.streamLogBase);
  shell.lineCount = shell.streamLog.length;

  if (gainedVoice) {
    repaintTranscriptWindow(shell);
    paintChrome(shell);
    return;
  }

  const dropped = shell.streamLogBase - baseBefore;
  if (dropped > 0) {
    for (const evicted of transcriptRowChildren(shell).slice(0, dropped)) {
      shell.transcript.remove(evicted);
      destroySubtree(evicted);
    }
    paintDroppedHistoryMarker(shell);
  }

  const index = shell.streamLog.length - 1;
  shell.transcript.add(
    createStreamRowRenderable(
      shell,
      row,
      gapBefore(shell, index),
      labelBefore(shell, index),
      shell.streamLogBase + index,
    ),
  );
  paintChrome(shell);
}

/** Drop every row from absolute `length` onward. A failed attempt re-streams
 * from scratch, so retract painted rows rather than piling the replay under
 * them. A cap-evicted boundary is a no-op. */
export function truncateStreamRows(shell: AppShell, length: number): void {
  const parentLog = shell.parentStreamLog;
  const observing = shell.observe !== null && parentLog !== null;
  const log = observing ? parentLog : shell.streamLog;
  const base = observing
    ? (shell.parentStreamLogBase ?? 0)
    : shell.streamLogBase;
  const local = length - base;
  if (local < 0 || local >= log.length) return;
  log.length = local;
  if (log !== shell.streamLog) return;
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);
  paintChrome(shell);
}

/** Empty the visible transcript for a fresh session (/clear, /new). Backend
 * rotation lives in the runner — on-screen wipe only. Observe drops first
 * so a child view cannot paint into a cleared parent; retention base
 * resets so no stale marker lingers. */
export function clearTranscript(shell: AppShell): void {
  if (shell.observe !== null) {
    // Drop observe without the "left observe" row — the log is about to go,
    // and a farewell would only flash then vanish.
    shell.observe = null;
    shell.parentStreamLog = null;
    shell.parentStreamLogBase = null;
    shell.parentUnloadedHistory = null;
    let guard = 4;
    while (guard-- > 0 && focusOwner(shell.focus) === "observe") {
      shell.focus = popFocus(shell.focus);
    }
    const frames = shell.focus.frames.filter((f) => f.target !== "observe");
    if (frames.length !== shell.focus.frames.length) {
      shell.focus = { frames };
    }
    setChromeZones(shell, { agents: null });
    applyFocus(shell);
  }
  shell.streamLog.length = 0;
  shell.streamLogBase = 0;
  shell.unloadedHistory = false;
  shell.lineCount = 0;
  shell.parentStreamLog = null;
  shell.parentStreamLogBase = null;
  shell.parentUnloadedHistory = null;
  repaintTranscriptWindow(shell);
  paintChrome(shell);
}

/** Rewrite an appended transcript row in place. Streaming bodies grow token
 * by token, so one open row is replaced per delta, not one per token.
 * `index` is absolute (`streamLogBase`); a cap-evicted row is a no-op,
 * not an unrelated-slot write. */
export function replaceStreamRowAt(
  shell: AppShell,
  index: number,
  row: StreamRow,
): void {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    const parentLocal = index - (shell.parentStreamLogBase ?? 0);
    if (parentLocal >= 0 && parentLocal < shell.parentStreamLog.length) {
      shell.parentStreamLog[parentLocal] = row;
    }
    return;
  }
  const local = index - shell.streamLogBase;
  if (local < 0 || local >= shell.streamLog.length) return;
  shell.streamLog[local] = row;

  const children = transcriptRowChildren(shell);
  // A raw appendTranscript line breaks the 1:1 node↔row mapping; fall back to
  // a full repaint, which derives every node from the log.
  if (children.length !== shell.streamLog.length) {
    repaintTranscriptWindow(shell);
    paintChrome(shell);
    return;
  }

  const stale = children[local];
  if (stale && retextStreamRow(shell, stale, row, labelBefore(shell, local))) {
    paintChrome(shell);
    return;
  }
  if (stale) {
    shell.transcript.remove(stale);
    destroySubtree(stale);
  }
  // Child list is spacer (+ eviction notice) then rows; see `transcriptRowOffset`.
  shell.transcript.add(
    createStreamRowRenderable(
      shell,
      row,
      gapBefore(shell, local),
      labelBefore(shell, local),
      index,
    ),
    local + transcriptRowOffset(shell),
  );
  paintChrome(shell);
}

/** Rebuild the transcript paint tree from `streamLog` — every retained row,
 * not a window. The log caps at `MAX_RETAINED_STREAM_ROWS`, so this is
 * O(cap); painting all keeps history scrollable. */
export function repaintTranscriptWindow(shell: AppShell): void {
  clearLandingMark(shell);
  shell.agentVoices = new Set(agentVoicesIn(shell.streamLog));
  // The bottom-anchor spacer (index 0) stays; the eviction notice (if any)
  // and every row get torn down and rebuilt from the log.
  for (const child of shell.transcript.getChildren().slice(1)) {
    shell.transcript.remove(child);
    destroySubtree(child);
  }

  // Evicted rows are gone, not scrolled past — say so, or the boundary
  // reads as the true start of history. A truncated resume may leave older
  // history on disk without a painted splice; that path must not fake
  // `streamLogBase`.
  if (shell.streamLogBase > 0 || shell.unloadedHistory) {
    const marker = new TextRenderable(shell.renderer as CliRenderer, {
      content: droppedHistoryNotice(shell),
      fg: UI.textDim,
    });
    evictionMarkers.add(marker);
    shell.transcript.add(marker);
  }

  shell.streamLog.forEach((row, local) => {
    shell.transcript.add(
      createStreamRowRenderable(
        shell,
        row,
        gapBefore(shell, local),
        labelBefore(shell, local),
        shell.streamLogBase + local,
      ),
    );
  });
}

/** Tear the landing down on the first transcript row. The prompt box jumps
 * from mid-screen to the bottom on the same frame — the screen answering,
 * not a layout twitch. Deferred notices flush into the transcript. */
function clearLandingMark(shell: AppShell): void {
  const bag = shellInternals(shell);
  const landing = bag?.landing;
  if (bag === undefined || landing === null || landing === undefined) return;
  bag.landing = null;
  bag.landingIdleTimerCancel?.();
  bag.landingIdleTimerCancel = null;
  shell.transcript.remove(landing.above.box);
  destroySubtree(landing.above.box);
  shell.root.remove(landing.below);
  destroySubtree(landing.below);
  relayout(shell);

  const notice = bag.landingNotice;
  if (notice !== null) {
    bag.landingNotice = null;
    appendStreamRow(shell, { role: "system", text: notice });
  }

  const deferred = bag.landingDeferredRows;
  if (deferred.length > 0) {
    bag.landingDeferredRows = [];
    // The notice strip held the latest wording; the rows are durable now,
    // so drop the flash rather than double-paint.
    setStatusFlash(shell, null);
    for (const row of deferred) appendStreamRow(shell, row);
  }
}

/** Idle repaint cadence (mount-scoped timer in `createAppShell`): snow
 * needs about half a row per second, so 8fps reads as motion. */
export const LANDING_IDLE_REPAINT_INTERVAL_MS = 125;

/** Repaint the landing mark for `nowMs`. `animating` runs the draw/fill/fade
 * timeline; otherwise it holds its filled frame. No-op once the landing is
 * gone, so callers can always drive it. Idle still repaints — snow drifts.
 * Reduced motion (a mount-time flag) freezes the mark and drops snow even
 * under `animating`. */
export function paintLanding(
  shell: AppShell,
  nowMs: number,
  animating: boolean,
): void {
  const bag = shellInternals(shell);
  const landing = bag?.landing;
  if (bag === undefined || landing === null || landing === undefined) return;
  const motion = bag.reducedMotion ? false : animating;
  bag.landingAnimating = motion;
  bag.landingNowMs = nowMs;
  paintLandingMark(landing.above, nowMs, !motion, bag.reducedMotion);
}

/** Fill the prompt from a landing starter; false when the key selects
 * nothing, the landing is gone, or the operator already typed. */
export function applyLandingSuggestion(shell: AppShell, key: string): boolean {
  if (!isLanding(shell) || shell.prompt.value.length > 0) return false;
  const suggestion = landingSuggestionFor(key);
  if (suggestion === null) return false;
  shell.prompt.value = suggestion.prompt;
  return true;
}

/** Paint node for one transcript row, plus its writer label when the row
 * opens a new block. The label stacks above the node in a column wrapper,
 * never a separate transcript child, so the log-index-to-child mapping
 * stays 1:1. */
export function createStreamRowRenderable(
  shell: AppShell,
  row: StreamRow,
  marginTop = 0,
  label: string | null = null,
  index?: number,
): TextRenderable | BoxRenderable {
  const ctx = shell.renderer as CliRenderer;
  const layout = transcriptRowLayout(shell);
  // `index` is absolute (see `streamLogBase`) so it survives retention-cap
  // trims; `toggleRowExpandedAt` converts it back to local at click time,
  // not here.
  const onToggle =
    index === undefined || !isCollapsibleRow(row)
      ? undefined
      : () => {
          toggleRowExpandedAt(shell, index);
        };
  const node = buildRowNode(ctx, row, layout, onToggle);

  if (label === null) {
    node.marginTop = marginTop;
    return node;
  }

  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "column",
    width: "100%",
    marginTop,
  });
  wrapper.add(new TextRenderable(ctx, { content: label, fg: UI.textDim }));
  wrapper.add(node);
  return wrapper;
}

export function setHeader(shell: AppShell, text: string): void {
  shell.baseTitle = text;
  paintChrome(shell);
}

export function setPendingQueue(shell: AppShell, count: number): void {
  let s = shell.session;
  const target = Math.max(0, Math.floor(count));
  while (badgeCount(s) > target) {
    s = { ...s, items: s.items.slice(0, -1) };
  }
  while (badgeCount(s) < target) {
    s = enqueue(s, `pad-${badgeCount(s) + 1}`);
  }
  shell.session = s;
  paintChrome(shell);
}

export function setShellRunState(shell: AppShell, run: RunState): void {
  shell.session = setRunState(shell.session, run);
  paintChrome(shell);
}

/** Expand or collapse one transcript row — a click on its arrow; a key with
 * nothing under it means all (see `toggleCollapsedRow`). `index` is
 * absolute (`streamLogBase`), matching `createStreamRowRenderable`'s
 * closures. */
export function toggleRowExpandedAt(shell: AppShell, index: number): boolean {
  const row = shell.streamLog[index - shell.streamLogBase];
  if (row === undefined || !isCollapsibleRow(row)) return false;
  replaceStreamRowAt(shell, index, { ...row, expanded: row.expanded !== true });
  return true;
}

/** Expand or collapse every collapsed row — same key as overlay payloads.
 * All-or-nothing: opening just the newest of several reads as a miss. Any
 * still-collapsed row opens; only once none are left does the key close
 * them again. */
export function toggleCollapsedRow(shell: AppShell): boolean {
  const collapsible = shell.streamLog.flatMap((row, local) =>
    row !== undefined && isCollapsibleRow(row)
      ? [{ row, index: shell.streamLogBase + local }]
      : [],
  );
  if (collapsible.length === 0) return false;
  const expand = collapsible.some(({ row }) => row.expanded !== true);
  for (const { row, index } of collapsible) {
    if ((row.expanded === true) === expand) continue;
    replaceStreamRowAt(shell, index, { ...row, expanded: expand });
  }
  return true;
}

/** Bracket marker per task status; a trailer row (status null) gets none. */
function taskStatusMarker(status: TaskPanelRow["status"]): string {
  switch (status) {
    case "todo":
      return "[ ] ";
    case "doing":
      return "[~] ";
    case "done":
      return "[x] ";
    case "cancelled":
      return "[-] ";
    case null:
      return "";
  }
}

/** Fit a row's label + tail into `maxWidth`, ellipsizing the label
 * (routinely long, free-form) before the tail the operator glances at.
 * Measured via `stringWidth`/`sliceToWidth`, not `.length` — UTF-16
 * units undercount wide glyphs. */
function fitAgentRow(row: AgentPanelRow, maxWidth: number): string {
  const full = ` ${row.label}${row.tail}`;
  if (stringWidth(full) <= maxWidth) {
    // Right-align lane tails so the clocks line up as a column; a lane
    // silent far longer than its neighbours stands out by shape alone.
    if (row.kind === "lane") {
      const pad = maxWidth - stringWidth(full);
      return ` ${row.label}${" ".repeat(Math.max(0, pad))}${row.tail}`;
    }
    return full;
  }

  const leadingSpace = 1;
  const ellipsis = 1;
  const budget = maxWidth - leadingSpace - stringWidth(row.tail) - ellipsis;
  if (budget <= 0) {
    // Not even the tail fits — keep its trailing end (where "stalled"
    // lives) rather than an unreadable sliver of the label.
    return ` ${sliceTailToWidth(row.tail, maxWidth - leadingSpace)}`;
  }
  return ` ${sliceToWidth(row.label, budget)}…${row.tail}`;
}

/** Fit a task row's marker + label into `maxWidth`, like `fitAgentRow`:
 * keep the marker whole, give the free-form title the space. */
function fitTaskRow(row: TaskPanelRow, maxWidth: number): string {
  const marker = taskStatusMarker(row.status);
  const full = ` ${marker}${row.label}`;
  if (stringWidth(full) <= maxWidth) return full;

  const leadingSpace = 1;
  const ellipsis = 1;
  const budget = maxWidth - leadingSpace - stringWidth(marker) - ellipsis;
  if (budget <= 0) return ` ${sliceToWidth(marker, maxWidth - leadingSpace)}`;
  return ` ${marker}${sliceToWidth(row.label, budget)}…`;
}

/** Rebuild taskBox's row children to match the requested rows exactly. */
function renderTasksRows(
  shell: AppShell,
  rows: readonly TaskPanelRow[],
  maxWidth: number,
): void {
  for (const child of [...shell.taskBox.getChildren()]) {
    shell.taskBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    const text = new TextRenderable(shell.renderer as CliRenderer, {
      content: fitTaskRow(row, maxWidth),
      fg:
        row.status === "done"
          ? UI.done
          : row.status === "doing"
            ? UI.text
            : UI.textDim,
    });
    shell.taskBox.add(text);
  }
}

/** Paint tone for one agents-strip row (cream live / orange trouble / green done). */
function agentRowFg(row: AgentPanelRow): string {
  if (row.kind === "more" || row.kind === "header") return UI.textDim;
  if (row.stalled || row.status === "failed") return UI.action;
  if (row.status === "done") return UI.done;
  if (row.status === "cancelled" || row.status === "interrupted")
    return UI.textDim;
  return UI.text;
}

/** Rebuild agentsBox's row children to match the requested rows exactly. */
function renderAgentsRows(
  shell: AppShell,
  rows: readonly AgentPanelRow[],
  maxWidth: number,
): void {
  for (const child of [...shell.agentsBox.getChildren()]) {
    shell.agentsBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    // Live lanes are body text, not in-flight chrome; stalled/failed keep
    // decision orange; done is green; cancelled and "+N more" sit back in
    // dim.
    const text = new TextRenderable(shell.renderer as CliRenderer, {
      content: fitAgentRow(row, maxWidth),
      fg: agentRowFg(row),
    });
    shell.agentsBox.add(text);
  }
}

/** Set agents/task chrome zone content (null/empty hides the zone); heights
 * come from geometry resolve. */
function taskRowsEqual(
  a: readonly TaskPanelRow[],
  b: readonly TaskPanelRow[],
): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        row.label === other.label &&
        row.status === other.status
      );
    })
  );
}

export function setChromeZones(
  shell: AppShell,
  content: ChromeZoneContent,
): void {
  const bag = shellInternals(shell);
  if (!bag) return;

  let taskChanged = false;
  if (content.task !== undefined) {
    bag.chrome.tasksRaw = content.task ?? [];
    const rendered = bag.tasksPanelHidden ? [] : bag.chrome.tasksRaw;
    taskChanged = !taskRowsEqual(rendered, bag.chrome.task);
    bag.chrome.task = rendered;
  }
  let agentsChanged = false;
  if (content.agents !== undefined) {
    const next = content.agents ?? [];
    agentsChanged =
      next.length !== bag.chrome.agents.length ||
      next.some((row, i) => {
        const prev = bag.chrome.agents[i];
        return (
          prev === undefined ||
          row.label !== prev.label ||
          row.tail !== prev.tail ||
          row.stalled !== prev.stalled ||
          row.status !== prev.status ||
          row.kind !== prev.kind
        );
      });
    bag.chrome.agents = next;
  }

  const taskRowCount = bag.chrome.task.length;
  const agentsRowCount = bag.chrome.agents.length;

  // Rebuilding children is node churn; skip it unless the panel's lines
  // actually changed.
  if (taskChanged) {
    renderTasksRows(shell, bag.chrome.task, shell.layout.contentWidth);
  }
  // Only a zone appearing or changing row count alters the row budget;
  // retitling with the same count must not re-resolve the layout.
  const budgetUnchanged =
    taskRowCount === bag.visibility.task &&
    agentsRowCount === bag.visibility.agents;
  if (!budgetUnchanged) {
    relayout(shell, {
      visibility: {
        ...bag.visibility,
        task: taskRowCount,
        agents: agentsRowCount,
      },
      overlayMode: bag.overlayMode,
      ...(bag.overlayBodyRows !== undefined
        ? { overlayBodyRows: bag.overlayBodyRows }
        : {}),
    });
  }

  // Paint after the resolver speaks, only as many rows as it granted: a board
  // past its box tears down what is under it.
  if (agentsChanged || !budgetUnchanged) {
    renderAgentsRows(
      shell,
      clampBoardRows(bag.chrome.agents, shell.layout.heights.agents),
      shell.layout.contentWidth,
    );
  }
  if (budgetUnchanged) paintChrome(shell);
}

/** How long a panel-visibility flash holds the notice row. */
const PANEL_TOGGLE_FLASH_MS = 3000;

/** Toggle the task-list panel without touching the live task data;
 * un-hiding shows whatever manage_tasks last wrote. The flag is
 * shell-memory, not persisted. */
export function toggleTasksPanel(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  bag.tasksPanelHidden = !bag.tasksPanelHidden;
  const hiding = bag.tasksPanelHidden;
  setChromeZones(shell, { task: bag.chrome.tasksRaw });
  // A flash, not a transcript row: which panels show is a property of the
  // current screen, not of the conversation.
  setStatusFlash(
    shell,
    hiding ? "task list hidden · alt+t to show" : "task list shown",
    {
      ttlMs: PANEL_TOGGLE_FLASH_MS,
    },
  );
}
