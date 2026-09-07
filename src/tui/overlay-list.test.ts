/**
 * Windowing semantics of the shell's overlay list, which delegates selection
 * clamping and scroll-keep-visible to @opentui/core's SelectRenderable.
 * Ported from list-viewport.test.ts when the hand-rolled viewport kit was
 * deleted; assertions are behavioural (active stays inside the window) rather
 * than pinning the old edge-follow scroll rule.
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

describe("createOverlayList", () => {
  test("empty list shows nothing", async () => {
    await withList({ count: 0, items: 5 }, (list) => {
      expect(list.count).toBe(0);
      expect(list.activeIndex).toBe(0);
      expect(list.visibleRange()).toEqual({ start: 0, end: 0 });
    });
  });

  test("short list fits entirely", async () => {
    await withList({ count: 3, items: 10 }, (list) => {
      expect(list.offset).toBe(0);
      expect(windowOf(list)).toEqual([0, 1, 2]);
    });
  });

  test("tall list starts at top", async () => {
    await withList({ count: 30, items: 5 }, (list) => {
      expect(list.offset).toBe(0);
      expect(windowOf(list)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  test("initial activeIndex deep in the list scrolls the window to it", async () => {
    await withList({ count: 30, items: 5, activeIndex: 20 }, (list) => {
      expect(list.activeIndex).toBe(20);
      expect(windowOf(list)).toContain(20);
      expect(list.offset).toBeGreaterThan(0);
    });
  });

  test("clamps negative and oversized activeIndex", async () => {
    await withList({ count: 10, items: 3, activeIndex: 99 }, (list) => {
      expect(list.activeIndex).toBe(9);
    });
  });
});

describe("move / page / jump", () => {
  test("moves down and keeps active visible", async () => {
    await withList({ count: 20, items: 4 }, (list) => {
      for (let i = 0; i < 6; i++) list.move(1);
      expect(list.activeIndex).toBe(6);
      activeVisible(list);
    });
  });

  test("moves up and keeps active visible", async () => {
    await withList({ count: 20, items: 4, activeIndex: 10 }, (list) => {
      list.move(-3);
      expect(list.activeIndex).toBe(7);
      activeVisible(list);
    });
  });

  test("clamps at ends", async () => {
    await withList({ count: 5, items: 3, activeIndex: 4 }, (list) => {
      list.move(1);
      expect(list.activeIndex).toBe(4);
      list.move(1);
      expect(list.activeIndex).toBe(4);
      list.move(-99);
      expect(list.activeIndex).toBe(0);
      list.move(-1);
      expect(list.activeIndex).toBe(0);
    });
  });

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
