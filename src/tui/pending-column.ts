/**
 * The pending column: queued steer/follow-up messages stacked above the
 * prompt box, one dim row per item.
 *
 * Items land in the transcript only when they deliver, so a held-back
 * message must not out-shout a sent one; the column keeps them visible
 * meanwhile without spending transcript rows.
 *
 * Pure: delivery-queue items in, row models out.
 */

import { PENDING_MAX_VISIBLE } from "./geometry/zones.js";
import { sliceToWidth, stringWidth } from "./view/height.js";
import type { QueueItem } from "./delivery-queue.js";

/** Marker opening every pending row — a pointer at the prompt it sits on. */
const ROW_MARK = "›";

/** Selected row's marker — a shape change, not only a colour, so it reads
 * on terminals that paint every fg the same. */
const SELECTED_MARK = "▸";

/** Widest kind tag; pads shorter ones so message text opens on one column. */
const TAG_WIDTH = "follow-up".length;

export interface PendingColumnRow {
  /** Queue item id so selection names a row; null on the "+N more" header. */
  readonly id: string | null;
  /** Kind tag for a queued item; null on the "+N more" header. */
  readonly tag: "steer" | "follow-up" | null;
  /** Single-line message text (whitespace-squashed), image count folded in. */
  readonly text: string;
}

/** Key guidance painted as the column's last row while items are pending. */
export const PENDING_COLUMN_HINT =
  "↑↓ select · Enter send now · ^X drop · esc back";

/** Item text flattened onto one row, with its image count folded in. */
function pendingText(item: QueueItem): string {
  const label = item.text.replace(/\s+/g, " ").trim();
  const images = item.attachments?.length ?? 0;
  const suffix = images > 0 ? `+${images} image${images === 1 ? "" : "s"}` : "";
  if (label.length === 0) return suffix;
  return suffix.length > 0 ? `${label} · ${suffix}` : label;
}

/**
 * Index of the oldest shown item for a row budget. A deep queue keeps the
 * *newest* items visible — selection enters on the top row — and folds the
 * rest behind "+N more"; nav clamps to this floor so selection never lands
 * on a folded item.
 */
export function pendingWindowStart(
  itemCount: number,
  itemRows: number,
): number {
  const limit = Math.max(0, Math.floor(itemRows));
  if (itemCount <= limit) return 0;
  return Math.min(itemCount, Math.max(0, itemCount - limit + 1));
}

/**
 * Rows the column paints: one per shown item in enqueue order, oldest folded
 * into a leading "+N more" (see `pendingWindowStart`). `maxRows` is the
 * geometry grant; the zone-ceiling default reserves a fold row so a partial
 * grant drops nothing silently.
 */
export function pendingColumnRows(
  items: readonly QueueItem[],
  maxRows: number = PENDING_MAX_VISIBLE + 1,
): readonly PendingColumnRow[] {
  const limit = Math.max(0, Math.floor(maxRows));
  const start = pendingWindowStart(items.length, limit);
  const rows: PendingColumnRow[] = [];
  const hidden = start;
  if (hidden > 0) rows.push({ id: null, tag: null, text: `+${hidden} more` });
  for (const item of items.slice(start)) {
    rows.push({
      id: item.id,
      tag: item.kind === "steer" ? "steer" : "follow-up",
      text: pendingText(item),
    });
  }
  return rows;
}

/**
 * Row count for geometry: the items (folded at the ceiling) plus one
 * guidance row while anything is pending.
 */
export function pendingColumnHeight(itemCount: number): number {
  if (itemCount === 0) return 0;
  return Math.min(itemCount, PENDING_MAX_VISIBLE + 1) + 1;
}

/** Segments of one painted line — the tag sits back from the text. */
export interface FittedPendingRow {
  readonly head: string;
  readonly text: string;
}

/**
 * Fit one row to the column budget. A pending message is a glance, not a
 * document: a long one loses its tail to the slice rather than wrapping,
 * and the tag is never what gives way.
 */
export function fitPendingRow(
  row: PendingColumnRow,
  maxWidth: number,
  selected = false,
): FittedPendingRow {
  if (row.tag === null) {
    return { head: "", text: sliceToWidth(`   ${row.text}`, maxWidth) };
  }
  const mark = selected ? SELECTED_MARK : ROW_MARK;
  const head = ` ${mark} ${row.tag.padEnd(TAG_WIDTH)}  `;
  return {
    head,
    text: sliceToWidth(row.text, Math.max(0, maxWidth - stringWidth(head))),
  };
}
