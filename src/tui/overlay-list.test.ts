/**
 * Selection continuity of the shell's overlay list across count and height
 * changes. Scroll clamping and windowing itself are delegated to
 * @opentui/core's SelectRenderable and are not re-tested here; what this pins
 * is the wrapper's own reshape/setCount logic that carries the live selection
 * across a rebuild so a resize does not snap the cursor back.
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness";
import { createOverlayList } from "./shell/overlay-list";

function windowOf(list: ReturnType<typeof createOverlayList>): number[] {
  const { start, end } = list.visibleRange();
  const indices: number[] = [];
  for (let i = start; i < end; i++) indices.push(i);
  return indices;
}

function activeVisible(list: ReturnType<typeof createOverlayList>): void {
  const { start, end } = list.visibleRange();
  expect(list.activeIndex).toBeGreaterThanOrEqual(start);
  expect(list.activeIndex).toBeLessThan(end);
}

async function withList(
  opts: { count: number; items: number; activeIndex?: number },
  run: (list: ReturnType<typeof createOverlayList>) => void,
): Promise<void> {
  await withTestRenderer(async (h) => {
    run(createOverlayList(h.renderer, opts));
  });
}

describe("page / jump", () => {
  test("page steps by the window height minus one", async () => {
    await withList({ count: 30, items: 5 }, (list) => {
      list.page(1);
      expect(list.activeIndex).toBe(4);
      list.page(-1);
      expect(list.activeIndex).toBe(0);
      activeVisible(list);
    });
  });

  test("jump clamps into the list", async () => {
    await withList({ count: 10, items: 5 }, (list) => {
      list.jump(7);
      expect(list.activeIndex).toBe(7);
      activeVisible(list);
      list.jump(-5);
      expect(list.activeIndex).toBe(0);
      list.jump(99);
      expect(list.activeIndex).toBe(9);
    });
  });

  test("empty-list navigation is a no-op", async () => {
    await withList({ count: 0, items: 5 }, (list) => {
      list.move(1);
      list.move(-1);
      list.page(1);
      list.page(-1);
      expect(list.activeIndex).toBe(0);
      expect(list.offset).toBe(0);
      expect(list.visibleRange()).toEqual({ start: 0, end: 0 });
    });
  });

  test("move clamps at both ends", async () => {
    await withList({ count: 5, items: 3 }, (list) => {
      list.move(-10);
      expect(list.activeIndex).toBe(0);
      list.move(100);
      expect(list.activeIndex).toBe(4);
      activeVisible(list);
    });
  });

  test("height 1 pages by one row", async () => {
    await withList({ count: 10, items: 1 }, (list) => {
      list.page(1);
      expect(list.activeIndex).toBe(1);
      expect(list.offset).toBe(1);
      activeVisible(list);
    });
  });

  test("the visible window is end-exclusive and never past the count", async () => {
    await withList({ count: 10, items: 3 }, (list) => {
      const { start, end } = list.visibleRange();
      expect(end - start).toBe(3);
      expect(windowOf(list)).toEqual([0, 1, 2]);
      list.jump(9);
      const last = list.visibleRange();
      expect(last.end).toBe(10);
      expect(last.start).toBeLessThanOrEqual(9);
    });
  });

  test("a short list's window ends at the count", async () => {
    await withList({ count: 2, items: 8 }, (list) => {
      expect(list.visibleRange()).toEqual({ start: 0, end: 2 });
      expect(windowOf(list)).toEqual([0, 1]);
    });
  });
});

describe("setCount / setHeight", () => {
  test("shrinking the count clamps the active row", async () => {
    await withList({ count: 20, items: 5, activeIndex: 15 }, (list) => {
      list.setCount(4);
      expect(list.count).toBe(4);
      expect(list.activeIndex).toBeLessThan(4);
      activeVisible(list);
    });
  });

  test("resizing the height keeps the active row visible", async () => {
    await withList({ count: 30, items: 5, activeIndex: 12 }, (list) => {
      list.setHeight(3);
      expect(list.height).toBe(3);
      activeVisible(list);
      list.setHeight(30);
      expect(windowOf(list)).toContain(12);
    });
  });

  test("two-row-per-item reshape keeps the item capacity", async () => {
    await withList({ count: 30, items: 5 }, (list) => {
      list.setHeight(5, 2);
      expect(windowOf(list).length).toBeLessThanOrEqual(5);
      list.move(4);
      list.move(1);
      activeVisible(list);
    });
  });
});
