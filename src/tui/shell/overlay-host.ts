/**
 * The single overlay host: float/relayout, reservations, deferred commands, close paths, answer field.
 */
import { type CliRenderer, type KeyEvent } from "@opentui/core";
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import { focusOwner, openOverlay, popFocus } from "../focus/index.js";
import { OVERLAY_MAX_FRACTION, PROMPT_BASE_ROWS } from "../geometry/index.js";
import { type PaletteCommand } from "../command-catalog.js";
import { streamLogMarkdown, writeClipboard } from "../copy-path.js";
import { UI } from "../theme.js";
import {
  isDecisionOverlay,
  overlayRowWidth,
  overlayRowsPerItem,
  overlayTitleRows,
  OVERLAY_HOST_BORDER_ROWS,
} from "../overlay-view.js";
import {
  composeDecisionBody,
  decisionContextBudget,
  overlayChoiceText,
  overlayKindWord,
  wrapOverlayText,
} from "../overlay-body.js";

import {
  type AppShell,
  clearMentionAccept,
  EMPTY_PRIMARY_BINDINGS,
  getPaletteOnCommand,
  isSlashPopupOpen,
  liveMentionAccept,
  mentionPopups,
  type OpenListOverlayOpts,
  type OverlaySelection,
  type PrimaryOverlayKind,
  shellInternals,
  slashPopups,
} from "./internals.js";
import {
  createOverlayList,
  dispatchOverlayAccept,
  relayoutOverlayHost,
} from "./overlay-list.js";
import {
  appendStreamRow,
  applyFocus,
  overlayAnswerState,
  paintOverlayList,
  relayout,
  setStatusFlash,
} from "./chrome.js";

function refreshOverlayTitle(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  shell.overlayView.paintTitle(
    {
      title: bag.overlayTitleText,
      kind: shell.overlayKind,
      hasChoices: shell.overlayItems.length > 0,
      answer: overlayAnswerState(shell),
      addProviderHint: bag.primaryBindings.addProviderHint,
      setDefaultHint: bag.primaryBindings.setDefaultHint,
      mcpManageHint: bag.primaryBindings.mcpManageHint,
      mcpAddHint: bag.primaryBindings.mcpAddHint,
    },
    shell.layout.contentWidth,
  );
}

const OVERLAY_FRAME_ID = "inset-demo";

/** Re-shape and store the open overlay's body rows for the current width. */
export function applyOverlayBodyText(
  shell: AppShell,
  text: string,
  maxLines: number,
  terminalHeight = shell.renderer.height,
): void {
  const width = overlayRowWidth(shell.layout.contentWidth);
  const bag = shellInternals(shell);
  // Scoped to decision overlays: a palette stacked over an open approval
  // calls this too, with its own (usually empty) body text. Caching that
  // would overwrite the approval's cached raw text with the palette's, and
  // popping the palette restores the approval's `overlayBodyLines` but not
  // this cache (`PriorOverlaySnapshot` never carried it) — so a resize right
  // after would re-shape the approval's body from the palette's stale empty
  // string instead of its own, blanking it. The palette itself never reads
  // this cache (not a decision overlay), so it never needs to be cached.
  if (bag && isDecisionOverlay(shell.overlayKind))
    bag.overlayRawBodyText = text;
  if (text.length === 0) {
    shell.overlayBodyLines = [];
    shell.overlayBodyFgs = [];
    return;
  }
  if (isDecisionOverlay(shell.overlayKind)) {
    const rows = composeDecisionBody(
      text,
      width,
      decisionContextBudget({
        terminalHeight,
        overlayRowsPerItem: overlayRowsPerItem(shell.overlayKind),
        overlayTitleRows: overlayTitleRows(shell.overlayKind),
        overlayHostBorderRows: OVERLAY_HOST_BORDER_ROWS,
        overlayMaxFraction: OVERLAY_MAX_FRACTION,
        promptBaseRows: PROMPT_BASE_ROWS,
      }),
    );
    shell.overlayBodyLines = rows.map((r) => r.text);
    shell.overlayBodyFgs = rows.map((r) => r.fg);
    return;
  }
  const lines = wrapOverlayText(text, width, maxLines);
  shell.overlayBodyLines = lines;
  shell.overlayBodyFgs = lines.map(() => UI.text);
}

/**
 * Open an inset list overlay on the shared host (permissions / operator / picker / palette).
 * Measures body + list into geometry — no guessed absolute paint.
 *
 * Single host: a non-palette open while anything is showing is a silent no-op
 * unless `deferIfBusy` is set, in which case it waits in one deferred slot
 * with a system line. Callers that replace a non-gate list close it first.
 * Palette may stack over a prior primary.
 */
export function openListOverlay(
  shell: AppShell,
  opts?: OpenListOverlayOpts,
): void {
  const kind = opts?.kind ?? "demo";
  const isPalette = kind === "palette";

  // Single host: non-palette open is a silent no-op while anything is open,
  // unless the caller opted into the one deferred command-surface slot.
  // Command surfaces that should replace a non-gate list call
  // closeReplaceableOverlay first. Palette may stack over a prior primary.
  if (shell.overlayList) {
    if (!isPalette) {
      if (opts?.deferIfBusy === true) deferBusyCommandOpen(shell, opts);
      return;
    }
    if (shell.overlayKind !== "palette") {
      const bag = shellInternals(shell);
      if (bag) {
        bag.priorOverlay = {
          kind: shell.overlayKind,
          items: shell.overlayItems,
          bodyLines: shell.overlayBodyLines,
          bodyFgs: shell.overlayBodyFgs,
          list: shell.overlayList,
          title: String(shell.overlayTitle.content),
          paletteCommands: shell.paletteCommands,
          primaryBindings: { ...bag.primaryBindings },
          answer: bag.overlayAnswer,
          titleText: bag.overlayTitleText,
        };
      }
      // Leave prior overlay focus frame; palette will stack above it.
    } else {
      // Already palette — pop palette frame only so we re-push cleanly.
      let guard = 4;
      while (guard-- > 0 && focusOwner(shell.focus) === "palette") {
        shell.focus = popFocus(shell.focus);
      }
    }
  }

  const labels = opts?.items ?? shell.overlayItems;
  shell.overlayItems = labels;
  shell.overlayKind = kind;
  if (!isPalette) shell.paletteCommands = [];

  const bag = shellInternals(shell);
  if (bag) {
    bag.overlayGeneration += 1;
    // A stacked palette borrows the primary bindings until restoration.
    if (!isPalette || !bag.priorOverlay) {
      bag.primaryBindings = {
        itemIds: opts?.itemIds ? [...opts.itemIds] : [],
        itemValues: opts?.itemValues ? [...opts.itemValues] : [],
        onAccept: opts?.onAccept ?? null,
        onToggleExpand: opts?.onToggleExpand ?? null,
        onCycle: opts?.onCycle ?? null,
        describe: opts?.describe ?? null,
        onAction: opts?.onAction ?? null,
        onPaste: opts?.onPaste ?? null,
        onCancel: opts?.onCancel ?? null,
        onDispose: opts?.onDispose ?? null,
        isGate: opts?.isGate === true,
        addProviderHint: opts?.addProviderHint ?? false,
        setDefaultHint: opts?.setDefaultHint ?? false,
        mcpManageHint: opts?.mcpManageHint ?? false,
        mcpAddHint: opts?.mcpAddHint ?? false,
      };
      bag.overlayEchoChoice = opts?.echoChoice ?? true;
      // Capture the full unfiltered set so typing can re-narrow in place.
      bag.listFilter =
        !isPalette && opts?.typeToFilter === true
          ? {
              query: "",
              allItems: [...labels],
              allItemIds: opts?.itemIds ? [...opts.itemIds] : [],
              allItemValues: opts?.itemValues ? [...opts.itemValues] : [],
            }
          : null;
    }
    if (!isPalette) {
      bag.overlayAnswer =
        opts?.onTextAnswer === undefined
          ? null
          : {
              text: "",
              // With nothing to choose, typing is the only way to answer, so
              // the field takes the keys immediately.
              active: opts.textAnswerActive ?? labels.length === 0,
              onSubmit: opts.onTextAnswer,
            };
    }
  }

  // Type-to-filter list overlays paint a `>` query row; everything else uses
  // the caller's body text (or empty).
  const bodyText =
    !isPalette && opts?.typeToFilter === true
      ? `> ${bag?.listFilter?.query ?? ""}`
      : (opts?.body ?? "");
  // Operator question and permission approval context get body lines; other
  // list-only overlays keep the body empty.
  applyOverlayBodyText(shell, bodyText, 0);

  // Ask for exactly what the content needs. The resolver caps the request
  // against OVERLAY_MAX_FRACTION and the transcript floor, and applyLayout
  // shrinks the viewport to whatever survived — so a longer list scrolls
  // instead of growing, and a short one leaves no dead rows below it.
  // An empty list charges no rows: a chooser with nothing to choose must not
  // reserve a blank band the operator can neither read nor act on.
  const listItems = labels.length;

  shell.overlayList = createOverlayList(shell.renderer as CliRenderer, {
    count: labels.length,
    items: listItems,
    activeIndex: opts?.activeIndex ?? 0,
  });

  if (bag) bag.overlayTitleText = opts?.title ?? "permission";
  refreshOverlayTitle(shell);

  const frameId = opts?.frameId ?? OVERLAY_FRAME_ID;
  const focusTarget = isPalette ? "palette" : "overlay";
  shell.focus = openOverlay(shell.focus, frameId, {
    target: focusTarget,
    scrollOwner: isPalette ? "palette" : "overlay",
  });
  relayoutOverlayHost(shell, listItems);
  applyFocus(shell);
  paintOverlayList(shell);
  opts?.onOpened?.();
}

/** Open inset permission/palette stub; focus stack owns keys; Esc closes. */
export function openInsetOverlay(
  shell: AppShell,
  items?: readonly string[],
): void {
  openListOverlay(shell, {
    kind: "demo",
    title: "permission",
    items: items ?? shell.overlayItems,
    frameId: OVERLAY_FRAME_ID,
  });
}

export function repaintListFilter(shell: AppShell): void {
  const bag = shellInternals(shell);
  const state = bag?.listFilter;
  if (!state) return;
  const q = state.query.trim().toLowerCase();
  const matched: { label: string; id: string; value: string | undefined }[] =
    [];
  for (let i = 0; i < state.allItems.length; i++) {
    const label = state.allItems[i] ?? "";
    const id = state.allItemIds[i] ?? label;
    if (q.length > 0) {
      const hay = `${label} ${id}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched.push({
      label,
      id,
      value: state.allItemValues[i],
    });
  }
  const labels =
    matched.length > 0 ? matched.map((m) => m.label) : ["(no matches)"];
  const ids = matched.length > 0 ? matched.map((m) => m.id) : [""];
  const values =
    state.allItemValues.length > 0
      ? matched.length > 0
        ? matched.map((m) => m.value)
        : [undefined]
      : undefined;
  setOverlayItems(shell, labels, ids, values);
  setOverlayBody(shell, `> ${state.query}`);
}

/**
 * Move the open overlay's free-text field in or out of taking keystrokes.
 * Returns false when the overlay offers no such field.
 */
export function setOverlayAnswerActive(
  shell: AppShell,
  active: boolean,
): boolean {
  const answer = overlayAnswerState(shell);
  if (answer === null || shell.overlayList === null) return false;
  if (answer.active === active) return false;
  answer.active = active;
  refreshOverlayTitle(shell);
  paintOverlayList(shell);
  return true;
}

/**
 * Esc inside a live answer field means "back to the choices", not "abandon the
 * question" — but only when there are choices to go back to.
 */
export function exitOverlayAnswerMode(shell: AppShell): boolean {
  const answer = overlayAnswerState(shell);
  if (answer === null || !answer.active) return false;
  if (shell.overlayItems.length === 0) return false;
  return setOverlayAnswerActive(shell, false);
}

/**
 * Keys the free-text answer field claims while it is taking input. Printable
 * characters and backspace edit the answer; Enter submits it and closes the
 * overlay through the per-open `onTextAnswer` callback.
 */
export function handleOverlayAnswerKey(
  shell: AppShell,
  key: KeyEvent,
): boolean {
  const answer = overlayAnswerState(shell);
  if (answer === null || shell.overlayList === null) return false;

  if (
    key.name === "tab" &&
    !key.shift &&
    !key.ctrl &&
    !key.meta &&
    !key.option &&
    !answer.active
  ) {
    return setOverlayAnswerActive(shell, true);
  }
  if (!answer.active) return false;
  if (key.ctrl || key.meta || key.option) return false;

  if (key.name === "return" || key.name === "enter") {
    if (answer.text.length === 0) return true;
    const text = answer.text;
    const submit = answer.onSubmit;
    const bag = shellInternals(shell);
    if (bag?.overlayEchoChoice !== false) {
      appendStreamRow(shell, {
        role: "system",
        text: `answered: ${text}`,
        meta: overlayKindWord(shell.overlayKind ?? "operator"),
      });
    }
    // Deliberate submit, not a dismiss — closeInsetOverlay must not also fire
    // the Esc/cancel path.
    if (bag) bag.primaryBindings.onCancel = null;
    closeInsetOverlay(shell);
    submit(text);
    return true;
  }
  if (key.name === "backspace") {
    if (answer.text.length > 0) {
      answer.text = answer.text.slice(0, -1);
      paintOverlayList(shell);
    }
    return true;
  }

  const seq = typeof key.sequence === "string" ? key.sequence : "";
  if (seq.length !== 1 || seq < " ") return false;
  answer.text += seq;
  paintOverlayList(shell);
  return true;
}

/** Close overlay/palette if open; restore prior focus (or prior overlay under palette). */
export function closeInsetOverlay(shell: AppShell): void {
  if (!shell.overlayList) return;
  // Esc (or any other dismiss) must also drop the `/` and `@` popups' key claim.
  slashPopups.delete(shell);
  if (mentionPopups.has(shell)) clearMentionAccept(shell);
  mentionPopups.delete(shell);

  const wasPalette = shell.overlayKind === "palette";
  if (wasPalette) {
    const filterBag = shellInternals(shell);
    if (filterBag) filterBag.paletteFilter = null;
  }
  const bag = shellInternals(shell);
  if (bag) bag.listFilter = null;
  const prior = wasPalette ? (bag?.priorOverlay ?? null) : null;
  // A primary overlay that registers onCancel owns cleanup for every dismiss
  // path. A palette stacked over another overlay restores that prior frame
  // instead, so its callback must remain untouched.
  const onCancel = !prior ? (bag?.primaryBindings.onCancel ?? null) : null;
  const onDispose = !prior ? (bag?.primaryBindings.onDispose ?? null) : null;

  shell.overlayList = null;
  shell.overlayKind = null;
  shell.overlayBodyLines = [];
  shell.overlayBodyFgs = [];
  shell.paletteCommands = [];
  shell.copyTargets = null;
  shell.overlayView.clearBody();
  // Esc / dismiss: drop accept path without invoking it (onCancel above is
  // captured before this clears, and is invoked separately once state settles).
  if (bag && !prior) {
    bag.primaryBindings = { ...EMPTY_PRIMARY_BINDINGS };
    bag.overlayAnswer = null;
  }

  // Pop exactly one frame (palette or overlay).
  if (
    focusOwner(shell.focus) === "overlay" ||
    focusOwner(shell.focus) === "palette"
  ) {
    shell.focus = popFocus(shell.focus);
  }

  if (prior && bag) {
    bag.priorOverlay = null;
    // Restore prior primary overlay paint; focus should already be overlay.
    shell.overlayItems = prior.items;
    shell.overlayKind = prior.kind;
    shell.overlayBodyLines = prior.bodyLines;
    shell.overlayBodyFgs = prior.bodyFgs;
    shell.overlayList = prior.list;
    shell.paletteCommands = prior.paletteCommands;
    shell.overlayTitle.visible = true;
    shell.overlayTitle.content = prior.title;
    bag.primaryBindings = { ...prior.primaryBindings };
    bag.overlayAnswer = prior.answer;
    bag.overlayTitleText = prior.titleText;
    // If focus was not stacked (edge case), re-open overlay frame.
    if (focusOwner(shell.focus) !== "overlay") {
      shell.focus = openOverlay(shell.focus, OVERLAY_FRAME_ID, {
        target: "overlay",
        scrollOwner: "overlay",
      });
    }
    relayoutOverlayHost(shell, prior.list.count);
    applyFocus(shell);
    paintOverlayList(shell);
    return;
  }

  // Ensure no leftover overlay/palette frames.
  let guard = 4;
  while (
    guard-- > 0 &&
    (focusOwner(shell.focus) === "overlay" ||
      focusOwner(shell.focus) === "palette")
  ) {
    shell.focus = popFocus(shell.focus);
  }

  relayout(shell, { overlayMode: "closed" });
  applyFocus(shell);
  if (bag) bag.overlayGeneration += 1;
  if (isOverlayHostIdle(shell)) notifyOverlayClosed(shell);
  try {
    onDispose?.();
    onCancel?.();
  } finally {
    scheduleDeferredCommandFlush(shell);
  }
}

/**
 * Close the current overlay only when dismissing it does not settle a
 * decision gate (`isGate`). Command surfaces that need a fresh host
 * (settings cycle, plugins, mcp) call this instead of `closeInsetOverlay`
 * so a live gate is left in place and `openListOverlay` can defer.
 * Overlays that bind `onDispose` for cleanup (mcp unsubscribe) still
 * run that hook; `onCancel` is Esc/dismiss only and is skipped here.
 */
export function closeReplaceableOverlay(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (bag?.primaryBindings.isGate === true) return;
  if (bag) bag.primaryBindings.onCancel = null;
  closeInsetOverlay(shell);
}

/**
 * Subscribe to "the overlay host is idle". Idle means no live list, no
 * deferred command surface, and no host reservations. Callers that must not
 * lose an open (gate wiring) queue on this instead of racing a busy host.
 */
export function onOverlayClosed(
  shell: AppShell,
  listener: () => void,
): () => void {
  const bag = shellInternals(shell);
  if (!bag) return () => undefined;
  bag.overlayClosedListeners.add(listener);
  return () => {
    bag.overlayClosedListeners.delete(listener);
  };
}

/**
 * True when the shared overlay host can accept a new primary open: the shell
 * is live, no list is showing, no deferred command is waiting, and nothing
 * holds a reservation.
 */
export function isOverlayHostIdle(shell: AppShell): boolean {
  if (shell.disposed) return false;
  const bag = shellInternals(shell);
  return (
    shell.overlayList === null &&
    (bag?.deferredCommandOverlay ?? null) === null &&
    (bag?.overlayHostReservations ?? 0) === 0
  );
}

export function notifyOverlayClosed(shell: AppShell): void {
  if (!isOverlayHostIdle(shell)) return;
  const bag = shellInternals(shell);
  if (!bag) return;
  // Copied: a listener may re-open an overlay and unsubscribe mid-iteration.
  for (const listener of [...bag.overlayClosedListeners]) listener();
}

/**
 * Hold the overlay host idle-notify while an async command surface is still
 * claiming it (permissions.list() before settings/permissions paint). Release
 * clears the hold, flushes a deferred surface if one is waiting, and notifies
 * if the host is actually idle.
 */
export function reserveOverlayHost(shell: AppShell): () => void {
  const bag = shellInternals(shell);
  if (!bag) return () => undefined;
  bag.overlayHostReservations += 1;
  const epoch = bag.overlayReservationEpoch;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = shellInternals(shell);
    if (!current || current.overlayReservationEpoch !== epoch) return;
    if (current.overlayHostReservations > 0)
      current.overlayHostReservations -= 1;
    scheduleDeferredCommandFlush(shell);
    notifyOverlayClosed(shell);
  };
}

/** Drop in-flight host holds. Stale `release()` callbacks become no-ops. */
export function abortOverlayHostReservations(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag || bag.overlayHostReservations === 0) return;
  bag.overlayReservationEpoch += 1;
  bag.overlayHostReservations = 0;
  bag.overlayGeneration += 1;
  scheduleDeferredCommandFlush(shell);
}

/** One deferred command-surface slot while the host is busy. */
function deferBusyCommandOpen(
  shell: AppShell,
  opts: OpenListOverlayOpts,
): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  bag.deferredCommandOverlay =
    opts.kind === undefined ? { ...opts, kind: "demo" } : opts;
  const kind = overlayKindWord(opts.kind ?? "demo");
  appendStreamRow(shell, {
    role: "system",
    text: `${kind} will open when the current list closes.`,
  });
  scheduleDeferredCommandFlush(shell);
}

function scheduleDeferredCommandFlush(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag || bag.deferredCommandOverlay === null || bag.deferredFlushScheduled)
    return;
  bag.deferredFlushScheduled = true;
  queueMicrotask(() => {
    bag.deferredFlushScheduled = false;
    if (shell.disposed) {
      bag.deferredCommandOverlay = null;
      return;
    }
    flushDeferredCommandOverlay(shell);
  });
}

function flushDeferredCommandOverlay(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  // Live list still occupies the host — keep the slot.
  if (shell.overlayList !== null) return;
  const opts = bag.deferredCommandOverlay;
  if (opts === null) {
    notifyOverlayClosed(shell);
    return;
  }
  bag.deferredCommandOverlay = null;
  // Reservations/disposed still occupy the host; restore the slot.
  if (!isOverlayHostIdle(shell)) {
    bag.deferredCommandOverlay = opts;
    return;
  }
  openListOverlay(shell, opts);
}

export function dropDeferredCommandOverlay(shell: AppShell): void {
  const bag = shellInternals(shell);
  if (!bag) return;
  bag.deferredCommandOverlay = null;
  bag.deferredFlushScheduled = false;
}

/** Replace the open overlay's body text in place (re-wrap + relayout). */
export function setOverlayBody(
  shell: AppShell,
  text: string,
  maxLines = 8,
): void {
  if (!shell.overlayList) return;
  applyOverlayBodyText(shell, text, maxLines);
  // Ask for the whole list again, not the height it currently has: a body that
  // shrank should hand its rows back to the choices rather than leave the
  // viewport stuck at the size an earlier, taller body forced it to.
  relayoutOverlayHost(shell, shell.overlayItems.length);
  paintOverlayList(shell);
}

export interface OverlayContinuationToken {
  readonly generation: number;
}

/** Capture overlay generation for an async continuation. Stale after a newer open, a full close, or Esc abort. */
export function captureOverlayContinuation(
  shell: AppShell,
): OverlayContinuationToken {
  return { generation: shellInternals(shell)?.overlayGeneration ?? -1 };
}

/** True only while no newer overlay has taken ownership of the shared host. */
export function isOverlayContinuationCurrent(
  shell: AppShell,
  token: OverlayContinuationToken,
): boolean {
  return isOverlayGenerationCurrent(shell, token) && shell.overlayList === null;
}

/** True while the shell is live and generation has not advanced. */
export function isOverlayGenerationCurrent(
  shell: AppShell,
  token: OverlayContinuationToken,
): boolean {
  return (
    !shell.disposed &&
    shellInternals(shell)?.overlayGeneration === token.generation
  );
}

/**
 * Refresh an overlay owned by either the foreground or the frame beneath a
 * stacked palette. Returns false once that overlay no longer owns either slot.
 */
export function setOwnedOverlayItems(
  shell: AppShell,
  kind: PrimaryOverlayKind,
  items: readonly string[],
  itemIds: readonly string[],
): boolean {
  const bag = shellInternals(shell);
  if (!bag) return false;

  if (shell.overlayKind === kind && shell.overlayList !== null) {
    const previousCount = shell.overlayItems.length;
    const activeId = bag.primaryBindings.itemIds[shell.overlayList.activeIndex];
    const filter = bag.listFilter;
    if (filter) {
      bag.listFilter = {
        query: filter.query,
        allItems: [...items],
        allItemIds: [...itemIds],
        allItemValues: filter.allItemValues,
      };
      repaintListFilter(shell);
    } else {
      setOverlayItems(shell, items, itemIds);
    }
    const displayedCount = shell.overlayItems.length;
    const activeIndex =
      activeId === undefined
        ? -1
        : bag.primaryBindings.itemIds.indexOf(activeId);
    if (activeIndex >= 0 && shell.overlayList.activeIndex !== activeIndex) {
      shell.overlayList.jump(activeIndex);
      paintOverlayList(shell);
    }
    if (displayedCount !== previousCount) {
      shell.overlayList?.setHeight(displayedCount);
      relayoutOverlayHost(shell, displayedCount);
      paintOverlayList(shell);
    }
    return true;
  }

  const prior = bag.priorOverlay;
  if (prior?.kind !== kind) return false;
  const activeId = prior.primaryBindings.itemIds[prior.list.activeIndex];
  const activeIndex = activeId === undefined ? -1 : itemIds.indexOf(activeId);
  bag.priorOverlay = {
    ...prior,
    items: [...items],
    primaryBindings: { ...prior.primaryBindings, itemIds: [...itemIds] },
    list: createOverlayList(shell.renderer as CliRenderer, {
      count: items.length,
      items: prior.list.height,
      activeIndex: activeIndex >= 0 ? activeIndex : prior.list.activeIndex,
    }),
  };
  return true;
}

/**
 * Replace the open overlay's item labels (and optionally ids) in place,
 * keeping the active row's position. Cycling a value redraws the row it
 * changed rather than closing and reopening the overlay, which would lose
 * the cursor and retrigger the open animation for a one-key edit.
 */
export function setOverlayItems(
  shell: AppShell,
  items: readonly string[],
  itemIds?: readonly string[],
  itemValues?: readonly (string | undefined)[],
  opts?: { readonly resetActive?: boolean },
): void {
  if (!shell.overlayList) return;
  shell.overlayItems = items;
  const bag = shellInternals(shell);
  if (bag && itemIds) bag.primaryBindings.itemIds = [...itemIds];
  if (bag && itemValues) bag.primaryBindings.itemValues = [...itemValues];
  // Most callers (mention/model-picker filtering) keep the operator's current
  // selection as the list narrows. The `/` popup instead resets to the top
  // row on every keystroke, matching pre-refresh behavior where each filter
  // reopened the overlay fresh.
  shell.overlayList.setCount(items.length);
  if (opts?.resetActive) shell.overlayList.jump(0);
  paintOverlayList(shell);
}

/** Accept active overlay item → callback + system line + close (palette dispatches action).
 * Mention Enter that is not live (stale generation or cursor off that `@`) dismisses. */
export function acceptOverlaySelection(shell: AppShell): void {
  if (!shell.overlayList) return;

  if (shell.overlayKind === "copy") {
    confirmCopySelection(shell);
    return;
  }

  const bag = shellInternals(shell);
  const kind = shell.overlayKind ?? "demo";
  // Empty chooser: Enter must not synthesize a phantom row. Stay open when a
  // free-text answer field is the way to reply, or when this is not a live
  // gate. A live gate with nowhere to answer fail-closes via onAccept with no
  // id so the helper can mark unavailable instead of hanging or impersonating
  // Esc/Reject through onCancel.
  if (shell.overlayItems.length === 0) {
    if (
      bag?.primaryBindings.isGate !== true ||
      overlayAnswerState(shell) !== null
    )
      return;
    const perOpen = bag.primaryBindings.onAccept ?? null;
    bag.primaryBindings.onCancel = null;
    const release = reserveOverlayHost(shell);
    closeInsetOverlay(shell);
    try {
      dispatchOverlayAccept(shell, { kind, index: 0, label: "" }, perOpen);
    } finally {
      release();
    }
    return;
  }

  const idx = shell.overlayList.activeIndex;
  const label = shell.overlayItems[idx] ?? `item ${idx}`;

  if (kind === "palette") {
    const cmd = shell.paletteCommands[idx];
    if (!cmd) {
      // Type-to-filter plants a "(no matches)" row with no command. Stay open.
      // Slash popup (`typeToFilter: false`) still closes — intentional dismiss.
      if (bag?.paletteFilter?.typeToFilter === true && !isSlashPopupOpen(shell))
        return;
      closeInsetOverlay(shell);
      return;
    }
    const release = reserveOverlayHost(shell);
    closeInsetOverlay(shell);
    try {
      dispatchPaletteSelection(shell, cmd);
    } finally {
      release();
    }
    return;
  }

  if (
    kind === "mentions" &&
    mentionPopups.has(shell) &&
    liveMentionAccept(shell) === null
  ) {
    // Stale generation or cursor off the @token: operator dismiss, not accept.
    closeInsetOverlay(shell);
    return;
  }

  const painted = shell.overlayList.select.getSelectedOption()?.value;
  const itemIds = bag?.primaryBindings.itemIds ?? [];
  const idKeyed = typeof painted === "string" && itemIds.includes(painted);
  // Gate accept is id-keyed. A painted Select value missing from the live
  // itemIds is a stale or mismatched row — remapping via index would bind
  // Enter to the new question's same-index choice. Dispatch the painted id
  // (or omit id) so the gate helper fail-closes as unavailable instead of
  // impersonating Reject through onCancel.
  let id: string | undefined;
  if (idKeyed) {
    id = painted;
  } else if (bag?.primaryBindings.isGate !== true) {
    id = itemIds[idx];
  } else if (typeof painted === "string") {
    id = painted;
  }
  // Type-to-filter plants "(no matches)" with an empty-id sentinel. Stay open
  // on non-gate lists. A live gate must not dead-end — omit the sentinel so
  // the helper fail-closes as unavailable.
  if (id === "") {
    if (bag?.primaryBindings.isGate !== true) return;
    id = undefined;
  }
  const value = bag?.primaryBindings.itemValues[idx];
  const selection: OverlaySelection = {
    kind,
    index: idx,
    label,
    ...(id !== undefined ? { id } : {}),
    ...(value !== undefined ? { value } : {}),
  };
  // Capture before close clears per-open state.
  const perOpen = bag?.primaryBindings.onAccept ?? null;
  // This is a deliberate accept, not a dismiss — closeInsetOverlay must not
  // also fire the Esc/cancel path below.
  if (bag) bag.primaryBindings.onCancel = null;

  if (bag?.overlayEchoChoice !== false) {
    appendStreamRow(shell, {
      role: "system",
      text: overlayChoiceText(label, id, value),
      meta: overlayKindWord(kind),
    });
  }
  // Accept is not operator dismiss: keep mention accept state for onAccept
  // after this close (closeInsetOverlay would otherwise bump the generation).
  if (kind === "mentions") mentionPopups.delete(shell);
  const release = reserveOverlayHost(shell);
  closeInsetOverlay(shell);
  try {
    dispatchOverlayAccept(shell, selection, perOpen);
  } finally {
    release();
  }
}

/**
 * Dispatch a selected `/` command list item after the popup has closed.
 * Every entry is registry-backed — the host's `onCommand(name)` runs it.
 */
export function dispatchPaletteSelection(
  shell: AppShell,
  cmd: PaletteCommand,
): void {
  const onCommand = getPaletteOnCommand(shell);
  if (onCommand) {
    onCommand(cmd.id);
    return;
  }
  appendStreamRow(shell, {
    role: "system",
    text: `palette: /${cmd.id} (no onCommand handler)`,
  });
}

/** Write the frozen target at the active list index; status flash only. */
export function confirmCopySelection(shell: AppShell): boolean {
  const targets = shell.copyTargets;
  if (!targets || targets.length === 0 || !shell.overlayList) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    closeInsetOverlay(shell);
    return false;
  }
  const idx = Math.max(
    0,
    Math.min(targets.length - 1, shell.overlayList.activeIndex),
  );
  const target = targets[idx];
  if (!target) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    closeInsetOverlay(shell);
    return false;
  }
  const preview =
    target.text.length > 48
      ? `${target.text.slice(0, 45).replace(/\s+/g, " ")}…`
      : target.text;
  writeClipboard(shell.clipboard, target.text, {
    onSuccess: () => {
      setStatusFlash(
        shell,
        `Copied ${target.label} (${target.text.length} chars): ${preview}`,
        {
          ttlMs: RUNTIME_FLASH_MS,
        },
      );
    },
    onFailure: () => {
      setStatusFlash(shell, "Copy failed", { ttlMs: RUNTIME_FLASH_MS });
    },
  });
  closeInsetOverlay(shell);
  return true;
}

/** Copy all frozen targets as markdown; status flash only. */
export function copyAllTargets(shell: AppShell): boolean {
  const targets = shell.copyTargets;
  if (!targets || targets.length === 0) {
    setStatusFlash(shell, "nothing to copy", { ttlMs: RUNTIME_FLASH_MS });
    if (shell.overlayKind === "copy") closeInsetOverlay(shell);
    return false;
  }
  const text = streamLogMarkdown(targets);
  writeClipboard(shell.clipboard, text, {
    onSuccess: () => {
      setStatusFlash(
        shell,
        `Copied all (${targets.length} items, ${text.length} chars)`,
        {
          ttlMs: RUNTIME_FLASH_MS,
        },
      );
    },
    onFailure: () => {
      setStatusFlash(shell, "Copy failed", { ttlMs: RUNTIME_FLASH_MS });
    },
  });
  closeInsetOverlay(shell);
  return true;
}
