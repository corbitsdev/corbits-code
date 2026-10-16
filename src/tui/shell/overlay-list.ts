/**
 * The overlay list wrapper (SelectRenderable) and its selection delegations.
 */
import {
  BoxRenderable,
  ScrollBoxRenderable,
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
 * relayout into it. In-place item refreshes must call this themselves: a
 * filter that narrows then widens would stay pinned at its first-opened
 * size.
 */
export function relayoutOverlayHost(shell: AppShell, itemCount: number): void {
  const perItem = overlayRowsPerItem(shell.overlayKind);
  // An empty list reserves zero rows but still paints its one-line empty
  // state, so the chrome budget carries that row as a body line.
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
 * Select keeps scroll offset private. The window is the same centered slice
 * it would paint, taken from the reserved slot count rather than a reflective
 * read. The ScrollBox viewport is what actually scrolls; this only names the
 * slice.
 */
function listWindow(
  index: number,
  count: number,
  slots: number,
): { offset: number; visible: number } {
  if (count === 0) return { offset: 0, visible: 0 };
  const visible = Math.max(1, slots);
  const half = Math.floor(visible / 2);
  const offset = Math.max(
    0,
    Math.min(index - half, Math.max(0, count - visible)),
  );
  return { offset, visible };
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

  const rowSpan = (): number => Math.max(1, shape.rowsPerItem);

  const build = (): SelectRenderable =>
    new SelectRenderable(ctx, {
      id: "shell-overlay-select",
      options,
      selectedIndex: activeIndex,
      // Full list, not the visible window. The viewport ScrollBox clips it and
      // owns the scrollbar; a window-sized select would scroll a second time
      // inside itself and the bar would never see overflow.
      height: Math.max(rowSpan(), Math.max(shape.items, count) * rowSpan()),
      width: "100%",
      flexShrink: 0,
      showDescription: shape.rowsPerItem > 1,
      showSelectionIndicator: false,
      showScrollIndicator: false,
      wrapSelection: false,
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

  const viewport = new ScrollBoxRenderable(ctx, {
    id: "shell-overlay-list-scroll",
    width: "100%",
    height: Math.max(1, shape.items * rowSpan()),
    flexShrink: 0,
    // Arrow keys stay on the shell's selection handler. A focusable scrollbox
    // would page itself and steal the list.
    focusable: false,
    viewportCulling: true,
    scrollY: true,
    stickyScroll: false,
    rootOptions: { backgroundColor: UI.ground },
    contentOptions: { backgroundColor: UI.ground },
    viewportOptions: { backgroundColor: UI.ground },
  });
  viewport.horizontalScrollBar.visible = false;
  viewport.horizontalScrollBar.focusable = false;
  viewport.verticalScrollBar.focusable = false;
  // Vertical bar stays on the native auto rule: visible once the select is
  // taller than the slot window. Forcing it off is the transcript's choice,
  // not the overlay host's.
  const placed = viewport.content.onSizeChange;
  let revealing = false;

  // Absolute marker at the active row. scrollChildIntoView on the whole select
  // is a no-op when the select is taller than the viewport (both edges outside).
  const anchor = new BoxRenderable(ctx, {
    id: "shell-overlay-active-anchor",
    position: "absolute",
    left: 0,
    width: 1,
    height: rowSpan(),
    top: 0,
  });
  viewport.add(select);
  viewport.add(anchor);

  const reveal = (): void => {
    if (revealing) return;
    revealing = true;
    try {
      const row = rowSpan();
      const slots = Math.max(1, shape.items);
      viewport.height = slots * row;
      select.height = Math.max(row, Math.max(slots, count) * row);
      const index = select.getSelectedIndex();
      anchor.height = row;
      anchor.top = index * row;
      const { offset } = listWindow(index, count, slots);
      const y = count === 0 ? 0 : offset * row;
      viewport.scrollTop = y;
      if (count > 0 && anchor.y !== 0 && viewport.viewport.y !== 0) {
        viewport.scrollChildIntoView(anchor.id);
      }
      // Applied last: scrollTop clamps until the bar has a content size, and
      // that clamp rewrites translateY. The viewport paints this translation.
      viewport.content.translateY = -y;
    } finally {
      revealing = false;
    }
  };
  viewport.content.onSizeChange = () => {
    placed?.call(viewport.content);
    reveal();
  };

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
    if (select.parent) viewport.remove(select);
    select = build();
    viewport.add(select, 0);
    select.setSelectedIndex(
      count === 0 ? 0 : Math.min(count - 1, Math.max(0, current)),
    );
    reveal();
  };

  reveal();

  return {
    get select() {
      return select;
    },
    viewport,
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
      return listWindow(select.getSelectedIndex(), count, shape.items).offset;
    },
    get count() {
      return count;
    },
    move(delta: number) {
      if (delta < 0) select.moveUp(-delta);
      else if (delta > 0) select.moveDown(delta);
      reveal();
    },
    page(dir: -1 | 1) {
      this.move(dir * (shape.items > 1 ? shape.items - 1 : 1));
    },
    jump(index: number) {
      if (count === 0) return;
      select.setSelectedIndex(
        Math.max(0, Math.min(count - 1, Math.floor(index))),
      );
      reveal();
    },
    setCount(next: number) {
      count = Math.max(0, Math.floor(next));
      options = placeholderOptions(count);
      select.options = options;
      reveal();
    },
    setHeight(items: number, rowsPerItem?: number) {
      reshape({
        items: Math.max(0, Math.floor(items)),
        ...(rowsPerItem ? { rowsPerItem } : {}),
      });
    },
    scrollActiveIntoView() {
      reveal();
    },
    visibleRange() {
      const { offset, visible } = listWindow(
        select.getSelectedIndex(),
        count,
        shape.items,
      );
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
 * `onCycle` (settings inline cycling). No-op without a hook, so Left/Right
 * stay unclaimed elsewhere.
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
 * `onAction`. No-op without one, so the key falls through unclaimed.
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
