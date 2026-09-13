/**
 * The overlay list wrapper (SelectRenderable) and its selection delegations.
 */
import {
  SelectRenderable,
  type KeyEvent,
  type RenderContext,
  type SelectOption,
} from "@opentui/core";
import { UI } from "../theme.js";
import {
  overlayRowsPerItem,
  overlayChromeRows,
  overlayMinHostRows,
} from "../overlay-view.js";

import {
  type AppShell,
  getShellOverlayHooks,
  type OverlayList,
  type OverlaySelection,
  shellInternals,
} from "./internals.js";
import {
  activeOverlayItemId,
  overlayAnswerState,
  paintOverlayList,
  relayout,
} from "./chrome.js";

/** Dispatch accept to per-open callback, then shell-level kind hooks. */
export function dispatchOverlayAccept(
  shell: AppShell,
  selection: OverlaySelection,
  perOpen: ((selection: OverlaySelection) => void) | null,
): void {
  if (perOpen) {
    perOpen(selection);
    return;
  }
  const hooks = getShellOverlayHooks(shell);
  if (!hooks) return;
  switch (selection.kind) {
    case "permissions":
      if (hooks.onPermission) {
        hooks.onPermission(selection);
        return;
      }
      break;
    case "operator":
      if (hooks.onOperator) {
        hooks.onOperator(selection);
        return;
      }
      break;
    case "model_picker":
      if (hooks.onModel) {
        hooks.onModel(selection);
        return;
      }
      break;
    case "settings":
      if (hooks.onSettings) {
        hooks.onSettings(selection);
        return;
      }
      break;
    case "help":
      if (hooks.onHelp) {
        hooks.onHelp(selection);
        return;
      }
      break;
    case "plugins":
      if (hooks.onPlugins) {
        hooks.onPlugins(selection);
        return;
      }
      break;
    case "resume":
      if (hooks.onResume) {
        hooks.onResume(selection);
        return;
      }
      break;
    case "mentions":
      if (hooks.onMentions) {
        hooks.onMentions(selection);
        return;
      }
      break;
    default:
      break;
  }
  hooks.onSelect?.(selection);
}

/**
 * Recompute the overlay host's row budget from the current item count and
 * relayout into it. Callers that refresh an already-open overlay's items in
 * place (rather than reopening) must call this themselves — a filter that
 * narrows a list and then widens it again would otherwise stay pinned at
 * whatever size it first opened at.
 */
export function relayoutOverlayHost(shell: AppShell, itemCount: number): void {
  const perItem = overlayRowsPerItem(shell.overlayKind);
  // An empty list reserves zero rows but still paints its one-line empty
  // state, so the chrome budget carries that row as a body line (CL-6720).
  const chrome = overlayChromeRows(
    shell.overlayKind,
    shell.overlayBodyLines.length + (itemCount === 0 ? 1 : 0),
    !!shellInternals(shell)?.primaryBindings.describe,
    overlayAnswerState(shell) !== null,
  );
  const hostRows = chrome + itemCount * perItem;
  const minHostRows = overlayMinHostRows(chrome, perItem, itemCount > 0);
  relayout(shell, {
    overlayMode: "inset",
    overlayBodyRows: hostRows,
    overlayMinBodyRows: minHostRows,
  });
}

interface OverlayListShape {
  items: number;
  rowsPerItem: number;
}

function placeholderOptions(count: number): SelectOption[] {
  return Array.from({ length: Math.max(0, count) }, () => ({
    name: "",
    description: "",
  }));
}

/**
 * SelectRenderable keeps its scroll offset and visible-item capacity private
 * in its type surface (@opentui/core 0.5.10 exposes no accessors for either),
 * so the wrapper reads them reflectively and narrows the values instead of
 * asserting a shape.
 */
function selectScrollState(select: SelectRenderable): {
  offset: number;
  visible: number;
} {
  const numberProp = (name: string): number => {
    const value = Object.getOwnPropertyDescriptor(select, name)?.value;
    return typeof value === "number" ? value : 1;
  };
  return {
    offset: numberProp("scrollOffset"),
    visible: Math.max(1, numberProp("maxVisibleItems")),
  };
}

export function createOverlayList(
  ctx: RenderContext,
  opts: { count: number; items: number; activeIndex?: number },
): OverlayList {
  let shape: OverlayListShape = {
    items: Math.max(0, opts.items),
    rowsPerItem: 1,
  };
  let count = Math.max(0, opts.count);
  const activeIndex = opts.activeIndex ?? 0;
  let options = placeholderOptions(count);

  const build = (): SelectRenderable =>
    new SelectRenderable(ctx, {
      options,
      selectedIndex: activeIndex,
      height: shape.items * shape.rowsPerItem,
      width: "100%",
      flexShrink: 0,
      showDescription: shape.rowsPerItem > 1,
      showSelectionIndicator: true,
      itemSpacing: 0,
      // Selection is a text colour, not a filled band: the highlighted row
      // already stands out, and a block would fight the host's background.
      backgroundColor: UI.ground,
      focusedBackgroundColor: UI.ground,
      selectedBackgroundColor: UI.ground,
      textColor: UI.textDim,
      focusedTextColor: UI.textDim,
      selectedTextColor: UI.text,
      descriptionColor: UI.textDim,
      selectedDescriptionColor: UI.text,
    });

  let select = build();

  const reshape = (next: Partial<OverlayListShape>): void => {
    const merged = { ...shape, ...next };
    if (
      merged.items === shape.items &&
      merged.rowsPerItem === shape.rowsPerItem
    ) {
      return;
    }
    // A rebuild lands on the open-time index; carry the live selection across
    // (clamped to the new count) so a resize does not snap the cursor back.
    const current = select.getSelectedIndex();
    shape = merged;
    select = build();
    select.setSelectedIndex(
      count === 0 ? 0 : Math.min(count - 1, Math.max(0, current)),
    );
  };

  return {
    get select() {
      return select;
    },
    get activeIndex() {
      return select.getSelectedIndex();
    },
    get height() {
      return shape.items;
    },
    get rowsPerItem() {
      return shape.rowsPerItem;
    },
    get offset() {
      return selectScrollState(select).offset;
    },
    get count() {
      return count;
    },
    move(delta: number) {
      if (delta < 0) select.moveUp(-delta);
      else if (delta > 0) select.moveDown(delta);
    },
    page(dir: -1 | 1) {
      this.move(dir * (shape.items > 1 ? shape.items - 1 : 1));
    },
    jump(index: number) {
      if (count === 0) return;
      select.setSelectedIndex(
        Math.max(0, Math.min(count - 1, Math.floor(index))),
      );
    },
    setCount(next: number) {
      count = Math.max(0, Math.floor(next));
      options = placeholderOptions(count);
      select.options = options;
    },
    setHeight(items: number, rowsPerItem?: number) {
      reshape({
        items: Math.max(0, Math.floor(items)),
        ...(rowsPerItem ? { rowsPerItem } : {}),
      });
    },
    visibleRange() {
      const { offset, visible } = selectScrollState(select);
      return { start: offset, end: Math.min(count, offset + visible) };
    },
  };
}

/** Run the open overlay's expand/collapse hook; true when one was bound. */
export function toggleOverlayExpand(shell: AppShell): boolean {
  if (!shell.overlayList) return false;
  const hook = shellInternals(shell)?.primaryBindings.onToggleExpand ?? null;
  if (!hook) return false;
  hook();
  return true;
}

/** Move overlay selection (j/k / arrows). */
export function moveOverlaySelection(shell: AppShell, delta: number): void {
  if (!shell.overlayList) return;
  shell.overlayList.move(delta);
  paintOverlayList(shell);
}

/**
 * Cycle the focused row's value in place, for overlays that opted in via
 * `onCycle` (settings inline cycling). No-op when the open overlay did not
 * supply a cycle hook, so Left/Right stay unclaimed everywhere else.
 */
export function cycleOverlaySelection(
  shell: AppShell,
  direction: -1 | 1,
): boolean {
  const list = shell.overlayList;
  if (!list) return false;
  const onCycle = shellInternals(shell)?.primaryBindings.onCycle;
  if (!onCycle) return false;
  onCycle(activeOverlayItemId(shell, list), direction);
  return true;
}

/**
 * Run the open overlay's bare-key claim, for overlays that opted in via
 * `onAction`. No-op when the open overlay did not supply one, so the key
 * falls through unclaimed everywhere else.
 */
export function runOverlayAction(shell: AppShell, key: KeyEvent): boolean {
  const list = shell.overlayList;
  if (!list) return false;
  const onAction = shellInternals(shell)?.primaryBindings.onAction;
  if (!onAction) return false;
  return onAction(activeOverlayItemId(shell, list), key);
}

/** Page overlay selection (PgUp/PgDn). */
export function pageOverlaySelection(shell: AppShell, dir: -1 | 1): void {
  if (!shell.overlayList) return;
  shell.overlayList.page(dir);
  paintOverlayList(shell);
}
