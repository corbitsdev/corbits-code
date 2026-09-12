import { describe, expect, test } from "bun:test";
import {
  fitPendingRow,
  pendingColumnHeight,
  pendingColumnRows,
  pendingWindowStart,
} from "./pending-column";
import { PENDING_MAX_VISIBLE } from "./geometry/zones";
import type { QueueItem } from "./session-queue";

let seq = 0;
function item(text: string, kind: QueueItem["kind"] = "queue"): QueueItem {
  seq += 1;
  return { id: `q${seq}`, text, kind, enqueuedAt: seq };
}

describe("pendingColumnRows", () => {
  test("one row per item in enqueue order, tags by kind", () => {
    const rows = pendingColumnRows([
      item("hold a", "steer"),
      item("hold b", "queue"),
    ]);
    expect(rows.map((r) => [r.tag, r.text])).toEqual([
      ["steer", "hold a"],
      ["follow-up", "hold b"],
    ]);
    expect(rows.map((r) => r.id)).toEqual(["q1", "q2"]);
  });

  test("deep queue folds the oldest into a leading +N more", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(`m${i}`));
    const rows = pendingColumnRows(items, PENDING_MAX_VISIBLE + 1);
    expect(rows[0]).toEqual({ id: null, tag: null, text: "+3 more" });
    // The newest items stay on screen — they are the rows selection enters on.
    expect(rows.slice(1).map((r) => r.text)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  test("message text flattens to one line and folds image count in", () => {
    const rows = pendingColumnRows([
      {
        ...item("line one\nline   two"),
        attachments: [
          {
            id: "img-a",
            name: "a.png",
            contentType: "image/png",
            data: new Uint8Array([137, 80, 78, 71]),
            contentHash: "hash-a",
          },
          {
            id: "img-b",
            name: "b.png",
            contentType: "image/png",
            data: new Uint8Array([137, 80, 78, 71]),
            contentHash: "hash-b",
          },
        ],
      },
    ]);
    expect(rows[0]?.text).toBe("line one line two · +2 images");
  });
});

describe("pendingWindowStart", () => {
  test("everything shows under the budget; overflow hides the oldest", () => {
    expect(pendingWindowStart(4, 5)).toBe(0);
    expect(pendingWindowStart(5, 5)).toBe(0);
    expect(pendingWindowStart(6, 5)).toBe(2);
    expect(pendingWindowStart(10, 5)).toBe(6);
  });

  test("a zero grant folds every item into the header", () => {
    expect(pendingWindowStart(3, 0)).toBe(3);
  });
});

describe("pendingColumnHeight", () => {
  test("empty costs zero rows; items cost themselves plus the hint row", () => {
    expect(pendingColumnHeight(0)).toBe(0);
    expect(pendingColumnHeight(1)).toBe(2);
    expect(pendingColumnHeight(99)).toBe(PENDING_MAX_VISIBLE + 2);
  });
});

describe("fitPendingRow", () => {
  test("tag rows keep the tag and slice the text to fit", () => {
    const fitted = fitPendingRow(
      { id: "q1", tag: "steer", text: "a very long held message" },
      24,
    );
    expect(fitted.head).toBe(" › steer      ");
    expect(`${fitted.head}${fitted.text}`).toHaveLength(24);
  });

  test("fold header has no tag column", () => {
    const fitted = fitPendingRow({ id: null, tag: null, text: "+2 more" }, 40);
    expect(fitted.head).toBe("");
    expect(fitted.text.trim()).toBe("+2 more");
  });

  test("the selected row swaps its marker so it reads without colour", () => {
    const row = { id: "q1", tag: "steer" as const, text: "m" };
    expect(fitPendingRow(row, 40).head).toContain("›");
    expect(fitPendingRow(row, 40, true).head).toContain("▸");
  });
});
