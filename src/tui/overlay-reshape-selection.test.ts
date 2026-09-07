/**
 * Regression: a reshape rebuild (resize -> setHeight, or an item-set refresh)
 * must carry the live selection index across, clamped to the new item count —
 * not snap back to the index the list opened at.
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness";
import { createOverlayList } from "./shell/overlay-list";

describe("reshape keeps selection", () => {
  test("setHeight rebuild keeps the moved selection in a 30-item list", async () => {
    await withTestRenderer((h) => {
      const list = createOverlayList(h.renderer, { count: 30, items: 5 });
      for (let i = 0; i < 9; i++) list.move(1);
      expect(list.activeIndex).toBe(9);
      list.setHeight(10);
      expect(list.activeIndex).toBe(9);
      list.setHeight(3, 2);
      expect(list.activeIndex).toBe(9);
    });
  });

  test("reshape clamps the selection to a shrunken item count", async () => {
    await withTestRenderer((h) => {
      const list = createOverlayList(h.renderer, { count: 30, items: 5 });
      for (let i = 0; i < 9; i++) list.move(1);
      list.setCount(3);
      list.setHeight(10);
      expect(list.activeIndex).toBe(2);
    });
  });

  test("rows-per-item reshape keeps the selection on the description pair", async () => {
    await withTestRenderer((h) => {
      const list = createOverlayList(h.renderer, { count: 10, items: 4 });
      for (let i = 0; i < 5; i++) list.move(1);
      list.setHeight(4, 2);
      expect(list.activeIndex).toBe(5);
    });
  });
});
