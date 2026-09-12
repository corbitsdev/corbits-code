/**
 * The pending column: queued steer/follow-up messages stacked directly above
 * the prompt box, one dim row per item.
 *
 * Queued input used to echo into the transcript twice — once tagged
 * "[will steer next]" at enqueue, again tagged "[steering]" at delivery —
 * which made a held-back message louder than a sent one. The column keeps the
 * same fact on screen (what is waiting, in what order) without spending
 * transcript rows on it: items sit here while pending and land in the
 * transcript as ordinary user rows only when they actually deliver.
 *
 * Pure: session-queue items in, row models out. Paint lives in
 * shell/chrome.ts (`syncPendingRows`); the row budget lives in geometry
 * (zone `pending`).
 */

import { PENDING_MAX_VISIBLE } from "./geometry/zones.js";
import { sliceToWidth, stringWidth } from "./view/height.js";
import type { QueueItem } from "./session-queue.js";

/** Marker opening every pending row — a pointer at the prompt it sits on. */
const ROW_MARK = "›";

/** Selected row's marker — a shape change, not only a colour, so the active
 * row reads on terminals that paint every fg the same. */
const SELECTED_MARK = "▸";

/** Widest kind tag; pads shorter ones so message text opens on one column. */
const TAG_WIDTH = "follow-up".length;

export interface PendingColumnRow {
  /** Queue item id so selection can name a row; null on the "+N more" header. */
  readonly id: string | null;
  /** Kind tag for a queued item; null on the "+N more" header. */
  readonly tag: "steer" | "follow-up" | null;
  /** Single-line message text (whitespace-squashed), attachment count folded in. */
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
 * Index of the oldest item the column shows at a given item-row budget. A deep
 * queue keeps the *newest* items visible — the newest is the row ↑ selects
 * first and the one the operator most likely typed a beat ago — folding the
 * older ones into a "+N more" header. Nav clamps against this floor so the
 * selection can never point at a folded item.
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
 * Rows the column paints: one per shown item in enqueue order, a deep queue
 * folding its oldest items into a leading "+N more" (see
 * `pendingWindowStart`). `maxRows` is the row budget geometry granted; the
 * default is the zone's own ceiling, so a partial grant (collapse under
 * pressure) still reserves a row for the fold instead of dropping items
 * silently.
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
 * Rows the zone asks geometry for — the items (folded at the ceiling) plus
 * one guidance row while anything is pending.
 */
export function pendingColumnHeight(itemCount: number): number {
  if (itemCount === 0) return 0;
  return Math.min(itemCount, PENDING_MAX_VISIBLE + 1) + 1;
}

/** Segments of one painted line, split so the tag can sit back from the text. */
export interface FittedPendingRow {
  readonly head: string;
  readonly text: string;
}

/**
 * Fit one row to the zone's column budget. A pending message is a glance, not
 * a document — a long one loses its tail to the slice rather than wrapping the
 * column, and the kind tag is never what gives way.
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
