/**
 * Pure list windowing kit: visible window, keep-active-visible, page/jump.
 * Consumers (permissions, models, agents, settings) pass item count + viewport
 * height in rows — no paint, no OpenTUI/Ink imports.
 */

export interface ListViewportState {
  /** Total number of items in the list. */
  count: number;
  /** Visible row capacity (viewport height). */
  height: number;
  /** Index of the first visible item. */
  offset: number;
  /** Index of the active/highlighted item. */
  activeIndex: number;
}

export interface CreateListViewportArgs {
  count: number;
  height: number;
  activeIndex?: number;
}

export interface VisibleSlice {
  /** Inclusive start index into the full list. */
  start: number;
  /** Exclusive end index into the full list. */
  end: number;
  activeIndex: number;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function maxOffset(count: number, height: number): number {
  return Math.max(0, count - height);
}

function normalizeCount(count: number): number {
  return Math.max(0, Math.floor(count));
}

function normalizeHeight(height: number): number {
  return Math.max(0, Math.floor(height));
}

function clampActive(count: number, activeIndex: number): number {
  if (count === 0) return 0;
  return clamp(Math.floor(activeIndex), 0, count - 1);
}

/**
 * Adjust `offset` so `activeIndex` lies in the visible window, then clamp
 * offset to `[0, max(0, count - height)]`.
 *
 * Rules:
 * - if active < offset → offset = active
 * - if active >= offset + height → offset = active - height + 1
 */
export function keepActiveVisible(state: ListViewportState): ListViewportState {
  const count = normalizeCount(state.count);
  const height = normalizeHeight(state.height);
  const activeIndex = clampActive(count, state.activeIndex);

  if (height <= 0 || count === 0) {
    return { count, height, offset: 0, activeIndex };
  }

  let offset = Math.floor(state.offset);

  if (activeIndex < offset) {
    offset = activeIndex;
  } else if (activeIndex >= offset + height) {
    offset = activeIndex - height + 1;
  }

  offset = clamp(offset, 0, maxOffset(count, height));
  return { count, height, offset, activeIndex };
}

/** Create a viewport with offset 0, then keep-active-visible. */
export function createListViewport(args: CreateListViewportArgs): ListViewportState {
  const count = normalizeCount(args.count);
  const height = normalizeHeight(args.height);
  const activeIndex = args.activeIndex === undefined ? 0 : args.activeIndex;
  return keepActiveVisible({ count, height, offset: 0, activeIndex });
}

/** Move active by `delta` (clamped), then keep-active-visible. */
export function moveActive(state: ListViewportState, delta: number): ListViewportState {
  const count = normalizeCount(state.count);
  if (count === 0) {
    return keepActiveVisible({ ...state, count, activeIndex: 0 });
  }
  const activeIndex = clampActive(count, state.activeIndex + delta);
  return keepActiveVisible({ ...state, count, activeIndex });
}

/**
 * Page up (`dir = -1`) or down (`dir = 1`).
 * Step is `height - 1` when height > 1 (one row of context), else 1.
 */
export function page(state: ListViewportState, dir: -1 | 1): ListViewportState {
  const height = normalizeHeight(state.height);
  const step = height > 1 ? height - 1 : 1;
  return moveActive(state, dir * step);
}

/** Jump active to `index` (clamped), then keep-active-visible. */
export function jump(state: ListViewportState, index: number): ListViewportState {
  return keepActiveVisible({ ...state, activeIndex: index });
}

/** Visible window as half-open `[start, end)` plus the (clamped) active index. */
export function visibleSlice(state: ListViewportState): VisibleSlice {
  const count = normalizeCount(state.count);
  const height = normalizeHeight(state.height);
  const activeIndex = clampActive(count, state.activeIndex);
  const start = clamp(Math.floor(state.offset), 0, maxOffset(count, height));
  const end = height <= 0 ? start : Math.min(count, start + height);
  return { start, end, activeIndex };
}

/** Update viewport height (e.g. terminal resize) and re-window. */
export function setHeight(state: ListViewportState, height: number): ListViewportState {
  return keepActiveVisible({ ...state, height: normalizeHeight(height) });
}

/** Update item count (list length change) and re-window. */
export function setCount(state: ListViewportState, count: number): ListViewportState {
  return keepActiveVisible({ ...state, count: normalizeCount(count) });
}
