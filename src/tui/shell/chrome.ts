/**
 * Persistent chrome: paint, notice row, lockup frame, landing paint, panels, flash status, focus application.
 */
import { homedir } from "node:os";
import {
  clampBoardRows,
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
import { promptBoxRows } from "../prompt-rows.js";
import { composeNoticeLine, resolveWaitingOn } from "../notice-line.js";
import { lockupCells, lockupText, lockupWidth, type LockupInput } from "../lockup.js";
import type { RampPhase, StallAge } from "../ramp.js";
import type { ActivityState } from "../session-chrome.js";
import {
  BORDER,
  composeAttentionLabel,
  composeRule,
  composeWorkspaceLabel,
  costContextText,
  type RulePart,
} from "../prompt-border.js";
import { focusOwner, focusPrompt, focusTranscript, popFocus } from "../focus/index.js";
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
import { evictedRowsNotice, trimRetainedLog } from "../long-log.js";
import { destroySubtree } from "../teardown.js";
import {
  badgeCount,
  enqueue,
  queueCount,
  setRunState,
  steerCount,
  type RunState,
} from "../session-queue.js";
import { agentVoicesIn, isCollapsibleRow, type StreamRow } from "../stream.js";
import { UI } from "../theme.js";
import { isDecisionOverlay, overlayRowsPerItem, overlayChromeRows } from "../overlay-view.js";
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
    steer: steerCount(shell.session),
    followUp: queueCount(shell.session),
    waitingOn: resolveWaitingOn(steerCount(shell.session), shell.inFlightTool, shell.lockupNowMs),
    interrupt: shell.session.interruptFlash,
    pinned: !isTranscriptFollowing(shell),
    flash: shell.statusFlash,
    attachments: shell.pendingAttachments.length,
  });
}

/** Which MCP servers are waiting on authorization. Repaints on change. */
export function setMcpNeedsAuth(shell: AppShell, names: readonly string[]): void {
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

/** Repaint the prompt borders and the transient notice row from live state. */
export function paintChrome(shell: AppShell): void {
  if (shell.disposed) return;
  // Headless tests often destroy the renderer without dispose
  // (`withTestRenderer` cleanup). A TTL flash armed before that teardown
  // must not write a TextBuffer the harness already freed.
  if (shell.renderer.isDestroyed || shell.notice.isDestroyed) return;
  syncPending(shell);
  const notice = noticeText(shell);
  shell.notice.content = new StyledText([
    fgChunk(UI.textDim)(notice.length > 0 ? ` ${notice}` : ""),
  ]);
  paintPromptBorder(shell);
  syncLandingSuggestions(shell);
  syncNoticeRow(shell, notice);
}

/**
 * Give the notice row a row only while it has something to say, and take it
 * back the moment it does not. The relayout re-enters paintChrome, which then
 * finds the visibility already correct and stops.
 */
function syncNoticeRow(shell: AppShell, notice: string): void {
  paintedNotice.set(shell, notice);
  const bag = shellInternals(shell);
  if (bag === undefined) return;
  const wanted = notice.length > 0;
  if ((bag.visibility.notice ?? false) === wanted) return;
  relayout(shell, { visibility: { ...bag.visibility, notice: wanted } });
}

/**
 * Re-read the notice once the layout pass has run.
 *
 * `pinned` is derived from the scroll box's own numbers, and those describe the
 * *last completed* layout: chrome painted at row-mutation time can read a
 * transcript that is following its tail as pinned, for the one frame between a
 * row landing and sticky-scroll re-applying. Repaints only when the wording
 * actually changed, so a settled frame costs a string compare.
 */
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

/**
 * Advance the status slot's clock and publish what it says. Callers own the
 * tick; the shell only repaints when the frame it would draw can actually
 * differ.
 *
 * A change of phase stamps the fade's origin, so the crossfade runs off the
 * frames the monitor is already scheduling for the live turn. Settling snaps
 * straight to the idle slot rather than fading into it: the tick stops on the
 * frame the turn ends, and a transition with no frames left to draw is worse
 * than none.
 */
export interface LockupFrame {
  readonly nowMs: number;
  readonly animating: boolean;
  /**
   * Live activity state, or null for the idle wordmark. Typed to the closed
   * set so the caller cannot hand this a raw tool identifier.
   */
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
  // A pending flash must never be the reason the process stays alive.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
  };
};

/**
 * Set a non-destructive flash and repaint (does not touch streamLog).
 *
 * A flash with a `ttlMs` clears itself when its window lapses. Anything whose
 * wording is only true for a moment ("press ctrl+c again to exit") must say so
 * for exactly that moment: left on screen it becomes a claim about a keypress
 * the operator never made, and it holds a transcript row hostage for it.
 * Omit `ttlMs` for live conditions that stay true until something replaces them
 * (stall notice, landing hold).
 */
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
  const schedule = options?.schedule ?? shellFlashSchedules.get(shell) ?? defaultFlashSchedule;
  flashTimers.set(
    shell,
    schedule(() => {
      flashTimers.delete(shell);
      // Only this flash expires: a later one has its own window, and the row
      // it is holding is not this one's to take back.
      if (shell.statusFlash !== message) return;
      shell.statusFlash = null;
      paintChrome(shell);
    }, ttlMs),
  );
}

/** Apply focus state to OpenTUI focusables. */
export function applyFocus(shell: AppShell): void {
  const owner = focusOwner(shell.focus);
  // Observe is a read-only child view: the parent prompt must not swallow the
  // keystrokes, so it is blurred exactly as an overlay blurs it.
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

/**
 * Stacking order for the floated overlay host. Only the landing composition
 * sits under it, and that has no z-index of its own, so one step is enough.
 */
const OVERLAY_FLOAT_Z = 10;

/**
 * Lift the overlay host out of the root's column, or drop it back in.
 *
 * On the landing the host is a modal: the mark and the disclosure are the
 * screen, and shoving them around to open a command list would make every
 * overlay feel like a navigation. Absolute positioning takes the host out of
 * flow so the composition beneath is untouched, anchored above the chrome the
 * host used to sit on top of. With a transcript on screen the opposite is
 * true — rows there are content the operator is reading, and covering them is
 * worse than pushing them — so the host goes back into the column.
 */
function floatOverlayHost(shell: AppShell, floating: boolean, top: number): void {
  const host = shell.overlayHost;
  if (!floating) {
    host.position = "relative";
    host.zIndex = 0;
    // A previous landing float left absolute insets behind. Under relative
    // positioning those same values act as offsets from the in-flow slot, so
    // a stale top pushes the band that many rows below the prompt — clear
    // them so the band sits where the flow put it.
    host.top = 0;
    host.left = 0;
    host.width = "100%";
    return;
  }
  host.position = "absolute";
  // Absolute positioning escapes root's padding, so the same sideMargin the
  // prompt box gets for free in normal flow has to be given back explicitly.
  // width is set to the same contentWidth the prompt box resolves to via
  // "100%" of root's padded box — one source, not a second computed here —
  // rather than left+right insets, since those combine with the existing
  // width:"100%" to overshoot the right edge.
  host.left = shell.layout.sideMargin;
  host.width = shell.layout.contentWidth;
  host.top = top;
  host.zIndex = OVERLAY_FLOAT_Z;
}

/** Stable id for the focused row: `itemIds[index]` when supplied, else its label. */
export function activeOverlayItemId(shell: AppShell, list: OverlayList): string {
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
  shell.overlayView.paintList(
    {
      kind: shell.overlayKind,
      items: shell.overlayItems,
      paletteCommands: shell.paletteCommands,
      list,
      bodyLines: shell.overlayBodyLines,
      bodyFgs: shell.overlayBodyFgs,
      answer: overlayAnswerState(shell),
      describe: () => {
        const describe = shellInternals(shell)?.primaryBindings.describe;
        return describe ? describe(activeOverlayItemId(shell, list)) : undefined;
      },
    },
    shell.layout.contentWidth,
  );
}

/**
 * Colour a composed rule. The frame stays faint so the labels it carries read
 * as the brighter thing on the row; the brand run is swapped for the lockup's
 * own cells, which is the only part of the border that animates.
 */
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
    chunks.push(fgChunk(part.role === "label" ? UI.textDim : UI.textFaint)(part.text));
  }
  return chunks;
}

/**
 * Color a meter cell: the percent takes the band color (quiet `textDim`,
 * warning sand, danger red) and the optional cost suffix stays dim chrome.
 */
function meterChunks(shell: AppShell, cell: string): TextChunk[] {
  const meter = shell.costContext;
  const percentFg =
    meter?.band === "danger" ? UI.error : meter?.band === "warning" ? UI.warning : UI.textDim;
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

/**
 * Repaint both border rules. Recomposed on every pass rather than cached: a
 * resize changes the column budget without changing any label, and the lockup
 * changes every animation frame without changing the geometry.
 */
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

  // Corners, both rule margins, the gap and the spaces around each label are
  // what the workspace has to fit inside — with the lockup if the rule can
  // seat both, without it if it cannot. Where the row can only afford one, the
  // information wins and the mark goes.
  const withBrand = Math.max(0, width - 9 - lockupWidth(lockupFrameInput(shell)));
  const alone = Math.max(0, width - 6);
  const workspaceInput = {
    cwd: shell.workspace.cwd,
    branch: shell.workspace.branch,
    home: homedir(),
  };
  // A workspace that has lost its path is a branch floating with no context,
  // which is worth less than the mark it displaced. So the mark yields not just
  // when the label cannot fit at all, but when keeping it would starve the path.
  const roomyRaw = composeWorkspaceLabel({ ...workspaceInput, maxWidth: withBrand });
  const roomy = roomyRaw.startsWith("(") ? "" : roomyRaw;
  const workspace =
    roomy.length > 0 ? roomy : composeWorkspaceLabel({ ...workspaceInput, maxWidth: alone });
  const brand = lockupText(lockupCells(lockupFrameInput(shell)));
  const meter = shell.costContext;
  const bottom = composeRule({
    width,
    corners: [BORDER.bottomLeft, BORDER.bottomRight],
    ...(roomy.length > 0 || workspace.length === 0 ? { brand } : {}),
    ...(meter !== null
      ? { meter: costContextText(meter, true), meterCompact: costContextText(meter, false) }
      : {}),
    ...(workspace.length > 0 ? { label: workspace } : {}),
  });
  shell.promptBottomRule.content = new StyledText(ruleChunks(shell, bottom));
}

export function applyLayout(shell: AppShell, layout: GeometryLayout): void {
  // Rows lay themselves out against the column budget (right-aligned bubbles,
  // pre-wrapped reasoning blocks), so a width change invalidates every painted
  // row rather than just reflowing it.
  const widthChanged =
    shell.layout.contentWidth !== layout.contentWidth ||
    shell.layout.chatWidth !== layout.chatWidth ||
    shell.layout.layoutMode !== layout.layoutMode;
  shell.layout = layout;
  const h = layout.heights;

  shell.root.paddingLeft = layout.sideMargin;
  shell.root.paddingRight = layout.sideMargin;

  // Raw renderer size, not `layout.terminal` — that is already net of the row
  // this badge itself reserves (see `terminalForGeometry`), which would make
  // the threshold check its own effect. Landing-only: see `relayout`.
  shell.versionRow.visible =
    isLanding(shell) && versionBadgeVisible(shell.renderer.width, shell.renderer.height);

  const taskH = Math.max(0, h.task);
  shell.taskBox.height = taskH > 0 ? taskH : 1;
  shell.taskBox.visible = taskH > 0;

  const agentsH = Math.max(0, h.agents);
  shell.agentsBox.visible = agentsH > 0;

  // Both pads are taken out of the transcript residual, never out of chrome,
  // so the resolver's row budget still sums to the terminal height.
  const transcriptH = Math.max(0, h.transcript);
  const padH = resolveTopPadRows(transcriptH);
  shell.topPad.height = padH > 0 ? padH : 1;
  shell.topPad.visible = padH > 0;

  const bottomPadH = resolveBottomMarginRows(layout.terminal.rows);
  shell.bottomPad.height = bottomPadH > 0 ? bottomPadH : 1;
  shell.bottomPad.visible = bottomPadH > 0;

  const overlayH = Math.max(0, h.overlay_host);

  // The landing splits the transcript residual around the prompt box so the box
  // sits on the terminal's middle row instead of at its foot. An open overlay
  // floats over that composition rather than displacing it, so the rows the
  // resolver took for the overlay host are handed back to the split.
  const bag = shellInternals(shell);
  const landing = bag?.landing ?? null;
  const landingRows = transcriptH - padH - bottomPadH + (landing === null ? 0 : overlayH);
  // The resolver already sized overlayH to the overlay's real content (list
  // included) and capped it against the fraction/floor limits, so it is the
  // correct minimum to ask the landing split to make room for — asking for
  // less (e.g. just enough for one choice row) starves the list underneath
  // the title down to nearly nothing once floatOverlayHost pins the host to it.
  const split = landing === null ? null : landingSplitFor(landingRows, overlayH, padH);
  if (bag !== undefined && landing !== null && split !== null) {
    landing.above.box.height = Math.max(1, split.above);
    // A new zone can seat a different tier, and a tier is a different grid, so
    // the mark is redrawn rather than left showing the previous size's frame.
    fitLandingMark(landing.above, resolveMarkGrid(split.above, layout.contentWidth));
    paintLandingMark(landing.above, bag.landingNowMs, !bag.landingAnimating, bag.reducedMotion);
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

  const promptH = Math.max(1, h.prompt);
  shell.promptBox.height = promptH;
  shell.promptBox.visible = promptH > 0;
  // The field takes whatever the box has left once both labelled rules are paid.
  const promptInnerH = Math.max(1, promptH - 2);
  shell.promptField.height = promptInnerH;
  // Sized explicitly rather than left to grow with its content: past the cap the
  // input has to scroll inside a fixed window instead of pushing the frame open.
  shell.prompt.height = promptInnerH;

  // Sized last: the float is anchored against chrome sized earlier in this
  // pass. Modal over the landing, an in-flow band once there is a transcript
  // to push.
  const floating = landing !== null && overlayH > 0;
  // Rows the flow spends before the prompt box — where a floated host's bottom
  // edge has to land, since the landing's box sits mid-screen rather than at
  // the foot and covering it would hide the thing the operator types into.
  // Stack: topPad, transcript, agents, task, then prompt (notice omitted —
  // same as before; it is transient chrome between task and prompt).
  const promptTop = padH + transcriptBody + agentsH + taskH;
  const hostH = floating ? Math.min(overlayH, Math.max(1, promptTop)) : overlayH;
  floatOverlayHost(shell, floating, Math.max(0, promptTop - hostH));
  shell.overlayHost.height = hostH > 0 ? hostH : 1;
  shell.overlayHost.visible = hostH > 0;
  if (hostH > 0 && shell.overlayList) {
    const chrome = overlayChromeRows(
      shell.overlayKind,
      shell.overlayBodyLines.length,
      !!bag?.primaryBindings.describe,
      overlayAnswerState(shell) !== null,
    );
    const bodyH = Math.max(1, hostH - chrome);
    // The viewport counts items, not rows; a decision overlay spends several
    // rows per item, so the row budget has to be divided back down.
    const perItem = overlayRowsPerItem(
      shell.overlayKind,
      shell.overlayItems,
      shell.layout.contentWidth,
    );
    shell.overlayList.setHeight(
      Math.max(1, Math.floor(bodyH / perItem)),
      isDecisionOverlay(shell.overlayKind) ? DECISION_CHOICE_ROWS : 1,
    );
    paintOverlayList(shell);
  }

  paintPromptBorder(shell);

  // The landing owns the transcript's children until the first row lands, so a
  // resize there must not rebuild them out from under it.
  if (widthChanged && shell.streamLog.length > 0 && !isLanding(shell)) {
    repaintTranscriptWindow(shell);
  }

  // Width change changes the column budget chrome rows fit to. Content may
  // be unchanged, so setChromeZones would skip the rebuild — do it here.
  if (widthChanged && bag !== undefined) {
    if (bag.chrome.task.length > 0) {
      renderTasksRows(shell, bag.chrome.task, layout.contentWidth);
    }
    if (bag.chrome.agents.length > 0) {
      renderAgentsRows(shell, clampBoardRows(bag.chrome.agents, agentsH), layout.contentWidth);
    }
  }

  paintChrome(shell);
}

/**
 * Re-size the prompt box for what is now in it. Cheap enough to run on every
 * content change: it re-resolves geometry only when the row count actually
 * moves, which is once per wrapped line gained or lost.
 */
export function syncPromptRows(shell: AppShell): void {
  const rows = promptBoxRows(promptRowCount(shell.prompt), shell.renderer.height);
  if (rows === shell.layout.heights.prompt) return;
  relayout(shell, { promptContentRows: rows });
}

/**
 * Resize the transcript's leading filler to soak up leftover viewport space.
 * Reads `scrollHeight` (content height, filler included) net of the filler's
 * own last-applied height, so it stays correct regardless of wrapping,
 * markdown, or windowed long-log rebuilds.
 *
 * Deliberately NOT called at row-mutation time: `scrollHeight` reflects the
 * last completed layout, not the tree as it stands the instant a row lands —
 * a row whose own box needs a layout pass to size itself (structured/tool/
 * collapsible rows) reads back as shorter than it really is for one frame.
 * Growing the filler on that stale reading would claim room the row still
 * needs and bury it. Called from the render-frame hook instead, once that
 * pass has actually run.
 */
export function syncTranscriptSpacer(shell: AppShell): void {
  const spacer = transcriptSpacers.get(shell);
  if (spacer === undefined) return;
  // The landing screen already bottom-anchors its own mark against the box
  // via the above/below split; a filler competing for the same content box
  // would double-count that space and squeeze the mark.
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
  const overlayMinBodyRows = opts?.overlayMinBodyRows ?? bag?.overlayMinBodyRows;
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
  // Only the landing screen ever gives up a row for the version badge — once
  // a session has real transcript content every row is that content's, and
  // the badge simply stops showing (see `applyLayout`) rather than taking
  // space back from it.
  const versionReserved = isLanding(shell);
  const layout = resolveGeometry({
    terminal: versionReserved ? terminalForGeometry(terminal) : terminal,
    visibility,
    overlay:
      overlayMode === "closed"
        ? { mode: "closed" }
        : {
            mode: overlayMode,
            ...(overlayBodyRows !== undefined ? { bodyRows: overlayBodyRows } : {}),
            ...(overlayMinBodyRows !== undefined ? { minBodyRows: overlayMinBodyRows } : {}),
          },
    ...(promptContentRows !== undefined ? { promptContentRows } : {}),
    // The landing owns the screen until the first transcript row lands, so
    // holding rows back for a transcript that does not exist would only clip
    // whatever the operator opened over it. An open overlay is the exception:
    // it asks for exactly as many rows as it has content, and without the floor
    // a long list would claim the whole screen instead of scrolling.
    ...(isLanding(shell) && overlayMode === "closed"
      ? { transcriptFloor: 0 }
      : fleetTranscriptFloor(shell)),
  });
  applyLayout(shell, layout);
  return layout;
}

/**
 * Append a raw line to the sticky transcript ScrollBox.
 * stickyScroll + stickyStart "bottom" auto-follow until the operator scrolls up.
 */
export function appendTranscript(
  shell: AppShell,
  line: string,
  opts?: { readonly fg?: string },
): void {
  clearLandingMark(shell);
  shell.lineCount += 1;
  shell.transcript.add(
    new TextRenderable(shell.renderer as CliRenderer, {
      content: ` ${line}`,
      fg: opts?.fg ?? UI.text,
    }),
  );
  paintChrome(shell);
}

/**
 * Append a role-styled stream row to the **parent** transcript.
 * While subagent observe is active, rows go to the parent snapshot only
 * (not painted); leave restores them with the parent lease.
 */
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

/**
 * Append a child stream row while observing a subagent.
 * Host-pushed live events (not only fixture seed lines). No-op when not observing.
 * @returns true when the row was applied to the observe view
 */
export function appendObserveStreamRow(shell: AppShell, row: StreamRow): boolean {
  if (shell.observe === null) return false;
  shell.observe.lines.push(row);
  paintAppendStreamRow(shell, row);
  return true;
}

/**
 * Paint + push onto the visible streamLog (child while observing, parent
 * otherwise). The paint tree stays 1:1 with the (retention-capped) log —
 * CL-5551 already bounds `streamLog` to `MAX_RETAINED_STREAM_ROWS`, so there
 * is no separate, smaller window to maintain on top of it: every retained
 * row gets a node, which is also what makes all of it reachable by
 * scrolling (CL-5553). A trim past the cap costs one node removal here, not
 * a rebuild.
 */
function paintAppendStreamRow(shell: AppShell, row: StreamRow): void {
  clearLandingMark(shell);
  const gainedVoice = noteAgentVoice(shell, row);
  shell.streamLog.push(row);
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
    const marker = transcriptMarker(shell);
    if (marker instanceof TextRenderable) {
      marker.content = evictedRowsNotice(shell.streamLogBase);
    } else {
      const node = new TextRenderable(shell.renderer as CliRenderer, {
        content: evictedRowsNotice(shell.streamLogBase),
        fg: UI.textDim,
      });
      evictionMarkers.add(node);
      shell.transcript.add(node, 1);
    }
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

/**
 * Drop every row from absolute `length` onward on the log `appendStreamRow`
 * targets.
 *
 * A committed inference attempt that fails is re-streamed from scratch, so the
 * transcript has to retract what the failed attempt already painted instead of
 * letting the replay pile up underneath it. A boundary the retention cap has
 * already evicted has nothing left to retract, so this is a no-op rather than
 * mis-truncating the tail that replaced it.
 */
export function truncateStreamRows(shell: AppShell, length: number): void {
  const observing = shell.observe !== null && shell.parentStreamLog !== null;
  const log = observing ? shell.parentStreamLog! : shell.streamLog;
  const base = observing ? (shell.parentStreamLogBase ?? 0) : shell.streamLogBase;
  const local = length - base;
  if (local < 0 || local >= log.length) return;
  log.length = local;
  if (log !== shell.streamLog) return;
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);
  paintChrome(shell);
}

/**
 * Empty the visible transcript for a fresh session (/clear, /new).
 *
 * Backend session rotation lives in the runner; this is only the on-screen wipe
 * the OpenTUI host must own after the Ink App path went away. Observe mode is
 * dropped first so a child view cannot keep painting into a cleared parent.
 * Retention base resets so the screen matches a brand-new session, not a window
 * over an empty retained log with a stale eviction marker.
 */
export function clearTranscript(shell: AppShell): void {
  if (shell.observe !== null) {
    // Drop observe without the "left observe" system row — the whole log is
    // about to go and a farewell row would only flash then vanish.
    shell.observe = null;
    shell.parentStreamLog = null;
    shell.parentStreamLogBase = null;
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
  shell.lineCount = 0;
  shell.parentStreamLog = null;
  shell.parentStreamLogBase = null;
  repaintTranscriptWindow(shell);
  paintChrome(shell);
}

/**
 * Rewrite an already-appended transcript row in place.
 *
 * Streaming assistant and thinking bodies grow token by token; the bridge keeps
 * one open row and replaces it on every delta rather than appending a row per
 * token. Repaints only the affected node while the log fits without windowing.
 *
 * `index` is absolute (see `streamLogBase`); a row the retention cap has
 * already evicted is a no-op rather than corrupting an unrelated row at the
 * same array slot.
 */
export function replaceStreamRowAt(shell: AppShell, index: number, row: StreamRow): void {
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
  // Raw child list is spacer (+ eviction notice, if any) then rows; see
  // `transcriptRowOffset` (see `transcriptRowChildren` for why row 0 is not
  // simply index 1).
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

/**
 * Rebuild the transcript paint tree from `streamLog` — every retained row,
 * not a smaller window of it. `streamLog` is already capped at
 * `MAX_RETAINED_STREAM_ROWS`, so this is O(cap), and painting all of it is
 * what makes the full retained history reachable by scrolling.
 */
export function repaintTranscriptWindow(shell: AppShell): void {
  clearLandingMark(shell);
  shell.agentVoices = new Set(agentVoicesIn(shell.streamLog));
  // The bottom-anchor spacer (index 0) stays; the eviction notice (if any)
  // and every row get torn down and rebuilt from the log.
  for (const child of shell.transcript.getChildren().slice(1)) {
    shell.transcript.remove(child);
    destroySubtree(child);
  }

  // Rows evicted by the retention cap are gone for good, not just scrolled
  // past — say so, or the boundary reads as the true start of history.
  if (shell.streamLogBase > 0) {
    const marker = new TextRenderable(shell.renderer as CliRenderer, {
      content: evictedRowsNotice(shell.streamLogBase),
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

/**
 * Tear the landing down on the first transcript row.
 *
 * The prompt box travels from the middle of the screen to the bottom, which is
 * a jump; it happens on the same frame as the operator's own first row so it
 * reads as the screen answering them rather than as the layout twitching.
 *
 * System/runtime notices deferred while the hero was up are flushed into the
 * transcript here so they stay durable once the session has content, without
 * ever having stolen the mountain on the way in.
 */
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
    // The notice strip held the latest wording while the mark was up; the
    // rows themselves are durable now, so drop the flash rather than double-paint.
    setStatusFlash(shell, null);
    for (const row of deferred) appendStreamRow(shell, row);
  }
}

/**
 * Cadence of the mount-scoped idle repaint timer armed in `createAppShell`.
 * The snow only needs to advance about half a row per second, so 8fps is
 * comfortably enough to read as motion.
 */
export const LANDING_IDLE_REPAINT_INTERVAL_MS = 125;

/**
 * Repaint the landing mark for `nowMs`. `animating` runs the mountain's
 * draw/fill/fade timeline; anything else holds its filled frame. No-op once
 * the landing is gone, so the caller can drive it unconditionally.
 *
 * Always repaints while the landing is up, even when `animating` is false:
 * the landing is idle by definition (no turn processing), and snow still
 * needs to drift across a frozen mountain. Driven by the mount-scoped timer
 * armed in `createAppShell` rather than a render event, so the repaint
 * cadence is independent of however often the renderer happens to paint.
 *
 * Reduced motion is a mount-time flag on the shell, not a per-paint
 * argument: it freezes the mountain and drops snow even when a caller
 * asks for `animating`.
 */
export function paintLanding(shell: AppShell, nowMs: number, animating: boolean): void {
  const bag = shellInternals(shell);
  const landing = bag?.landing;
  if (bag === undefined || landing === null || landing === undefined) return;
  const motion = bag.reducedMotion ? false : animating;
  bag.landingAnimating = motion;
  bag.landingNowMs = nowMs;
  paintLandingMark(landing.above, nowMs, !motion, bag.reducedMotion);
}

/**
 * Fill the prompt from a landing starter. Returns false when the key selects
 * nothing, the landing is gone, or the operator has already typed.
 */
export function applyLandingSuggestion(shell: AppShell, key: string): boolean {
  if (!isLanding(shell) || shell.prompt.value.length > 0) return false;
  const suggestion = landingSuggestionFor(key);
  if (suggestion === null) return false;
  shell.prompt.value = suggestion.prompt;
  return true;
}

/**
 * Build the paint node for one transcript row, including its writer label
 * when this row opens a new block (see `blockLabel`). The label is one text
 * child stacked above the row's own node in a column wrapper — never a
 * separate transcript child — so the 1:1 log-index-to-child mapping holds.
 */
export function createStreamRowRenderable(
  shell: AppShell,
  row: StreamRow,
  marginTop = 0,
  label: string | null = null,
  index?: number,
): TextRenderable | BoxRenderable {
  const ctx = shell.renderer as CliRenderer;
  const layout = transcriptRowLayout(shell);
  // `index` is absolute (see `streamLogBase`), so it stays the row's index
  // for as long as its node lives even if the retention cap trims the array
  // out from underneath it later. `toggleRowExpandedAt` converts it back to
  // a local array position at click time, not here.
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

  const wrapper = new BoxRenderable(ctx, { flexDirection: "column", width: "100%", marginTop });
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

/**
 * Expand or collapse every transcript row that hides a body behind a summary:
 * loaded skills, summarised tool calls, settled reasoning. Same key as the
 * overlay's collapsed payloads, so the product has one expand idiom.
 *
 * All-or-nothing rather than one row at a time: with several collapsed rows on
 * screen, expanding the newest and leaving the rest reads as the key having
 * missed. Any row still collapsed means the whole set opens; only once nothing
 * is left to open does the key close them again.
 *
 * False when no row on the log can expand at all.
 */
/**
 * Expand or collapse exactly one transcript row — what a click on its arrow
 * means. The key stays bulk (see `toggleCollapsedRow`): a pointer says *this
 * one*, a key with nothing under it can only mean all of them.
 *
 * False when that row hides nothing.
 */
/** `index` is absolute (see `streamLogBase`), matching the index closures built off `createStreamRowRenderable` carry. */
export function toggleRowExpandedAt(shell: AppShell, index: number): boolean {
  const row = shell.streamLog[index - shell.streamLogBase];
  if (row === undefined || !isCollapsibleRow(row)) return false;
  replaceStreamRowAt(shell, index, { ...row, expanded: row.expanded !== true });
  return true;
}

export function toggleCollapsedRow(shell: AppShell): boolean {
  const collapsible = shell.streamLog.flatMap((row, local) =>
    row !== undefined && isCollapsibleRow(row) ? [{ row, index: shell.streamLogBase + local }] : [],
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

/**
 * Fit a row's label + tail into `maxWidth` terminal columns, ellipsizing the
 * label (agentId + description — free-form, model-authored, routinely long,
 * and not guaranteed narrow: CJK and emoji run two columns per code point)
 * before ever touching the tail (elapsed/tool/stalled). The tail carries
 * the fact an operator glances at the panel to see, so it is preserved
 * whole or not shown at all. Measured and sliced in columns via
 * `stringWidth`/`sliceToWidth` (`src/tui/view/height.ts`) rather than UTF-16
 * code units — `.length` undercounts wide glyphs, which is exactly the class
 * of bug that would make a row overflow its zone and wrap.
 */
function fitAgentRow(row: AgentPanelRow, maxWidth: number): string {
  const full = ` ${row.label}${row.tail}`;
  if (stringWidth(full) <= maxWidth) {
    // Push every lane's tail to the right edge so the clocks line up as a
    // column. A lane that has been silent far longer than its neighbours then
    // stands out of that column by its shape, before any of it is read — which
    // is the one thing the board has to get right at a glance.
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
    // Not even the tail fits at full width — keep as much of the tail's
    // trailing end (where the "stalled" marker lives) as there is room for,
    // rather than an unreadable sliver of the label.
    return ` ${sliceTailToWidth(row.tail, maxWidth - leadingSpace)}`;
  }
  return ` ${sliceToWidth(row.label, budget)}…${row.tail}`;
}

/**
 * Fit a task row's status marker + label into `maxWidth` columns, same
 * ellipsis discipline as `fitAgentRow`: the marker (what says done vs.
 * pending) is preserved whole, the free-form title is what gives way.
 */
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
function renderTasksRows(shell: AppShell, rows: readonly TaskPanelRow[], maxWidth: number): void {
  for (const child of [...shell.taskBox.getChildren()]) {
    shell.taskBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    const text = new TextRenderable(shell.renderer as CliRenderer, {
      content: fitTaskRow(row, maxWidth),
      fg: row.status === "done" ? UI.done : row.status === "doing" ? UI.text : UI.textDim,
    });
    shell.taskBox.add(text);
  }
}

/** Paint tone for one agents-strip row (cream live / orange trouble / green done). */
function agentRowFg(row: AgentPanelRow): string {
  if (row.kind === "more" || row.kind === "header") return UI.textDim;
  if (row.stalled || row.status === "failed") return UI.action;
  if (row.status === "done") return UI.done;
  if (row.status === "cancelled" || row.status === "interrupted") return UI.textDim;
  return UI.text;
}

/** Rebuild agentsBox's row children to match the requested rows exactly. */
function renderAgentsRows(shell: AppShell, rows: readonly AgentPanelRow[], maxWidth: number): void {
  for (const child of [...shell.agentsBox.getChildren()]) {
    shell.agentsBox.remove(child);
    destroySubtree(child);
  }
  for (const row of rows) {
    // Live lanes use primary cream (`UI.text`) — the Amp/Codex strip is body
    // text, not bronze in-flight chrome. Stalled / failed keep the decision
    // orange; done linger is green; cancelled / "+N more" sit back in dim.
    const text = new TextRenderable(shell.renderer as CliRenderer, {
      content: fitAgentRow(row, maxWidth),
      fg: agentRowFg(row),
    });
    shell.agentsBox.add(text);
  }
}

/**
 * Set agents/task chrome zone content (null/empty = hide zone).
 * Heights come from geometry resolve — never guessed.
 */
function taskRowsEqual(a: readonly TaskPanelRow[], b: readonly TaskPanelRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i];
      return other !== undefined && row.label === other.label && row.status === other.status;
    })
  );
}

export function setChromeZones(shell: AppShell, content: ChromeZoneContent): void {
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

  // Rebuilding N TextRenderable children is real node churn; skip it unless
  // the panel's actual lines changed (not every push carries new data).
  if (taskChanged) {
    renderTasksRows(shell, bag.chrome.task, shell.layout.contentWidth);
  }
  // Only a zone appearing/disappearing or its row count changing alters the
  // row budget; retitling a zone whose row count is unchanged must not
  // re-resolve and re-apply the whole layout.
  const budgetUnchanged =
    taskRowCount === bag.visibility.task && agentsRowCount === bag.visibility.agents;
  if (!budgetUnchanged) {
    relayout(shell, {
      visibility: {
        ...bag.visibility,
        task: taskRowCount,
        agents: agentsRowCount,
      },
      overlayMode: bag.overlayMode,
      ...(bag.overlayBodyRows !== undefined ? { overlayBodyRows: bag.overlayBodyRows } : {}),
    });
  }

  // Painted after the resolver has spoken, and only ever as many rows as it
  // granted: a board that paints past its box lands on top of the transcript
  // and tears down the renderables underneath it. Full content width (stack).
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

/**
 * Toggle the task-list panel visible/hidden without touching the live task
 * data underneath it — un-hiding shows whatever manage_tasks last wrote,
 * not a stale snapshot from before the hide. The flag lives on the shell's
 * internals in memory for the shell's lifetime; nothing is written to
 * storage, so it does not survive a restart.
 */
export function toggleTasksPanel(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  bag.tasksPanelHidden = !bag.tasksPanelHidden;
  const hiding = bag.tasksPanelHidden;
  setChromeZones(shell, { task: bag.chrome.tasksRaw });
  // A flash, not a transcript row: which panels are showing is a property of
  // the current screen, not something that happened in the conversation.
  setStatusFlash(shell, hiding ? "task list hidden · alt+t to show" : "task list shown", {
    ttlMs: PANEL_TOGGLE_FLASH_MS,
  });
}
