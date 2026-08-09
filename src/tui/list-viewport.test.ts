import { describe, expect, test } from "bun:test";
import {
  createListViewport,
  jump,
  keepActiveVisible,
  moveActive,
  page,
  setCount,
  setHeight,
  visibleSlice,
  type ListViewportState,
} from "./list-viewport.js";

function windowOf(state: ListViewportState): number[] {
  const { start, end } = visibleSlice(state);
  const indices: number[] = [];
  for (let i = start; i < end; i++) indices.push(i);
  return indices;
}

describe("createListViewport", () => {
  test("empty list", () => {
    const s = createListViewport({ count: 0, height: 5 });
    expect(s).toEqual({ count: 0, height: 5, offset: 0, activeIndex: 0 });
    expect(visibleSlice(s)).toEqual({ start: 0, end: 0, activeIndex: 0 });
  });

  test("short list fits entirely", () => {
    const s = createListViewport({ count: 3, height: 10 });
    expect(s.offset).toBe(0);
    expect(s.activeIndex).toBe(0);
    expect(visibleSlice(s)).toEqual({ start: 0, end: 3, activeIndex: 0 });
  });

  test("tall list starts at top", () => {
    const s = createListViewport({ count: 30, height: 5 });
    expect(s.offset).toBe(0);
    expect(windowOf(s)).toEqual([0, 1, 2, 3, 4]);
  });

  test("initial activeIndex near bottom scrolls window down", () => {
    const s = createListViewport({ count: 30, height: 5, activeIndex: 20 });
    expect(s.activeIndex).toBe(20);
    // active must be visible: offset = 20 - 5 + 1 = 16
    expect(s.offset).toBe(16);
    expect(windowOf(s)).toEqual([16, 17, 18, 19, 20]);
  });

  test("clamps negative and oversized activeIndex", () => {
    expect(createListViewport({ count: 10, height: 3, activeIndex: -5 }).activeIndex).toBe(0);
    expect(createListViewport({ count: 10, height: 3, activeIndex: 99 }).activeIndex).toBe(9);
  });
});

describe("keep-active-visible", () => {
  test("scrolls down when active falls below the window", () => {
    const base: ListViewportState = {
      count: 20,
      height: 4,
      offset: 0,
      activeIndex: 10,
    };
    const s = keepActiveVisible(base);
    expect(s.offset).toBe(10 - 4 + 1); // 7
    expect(s.activeIndex).toBe(10);
    expect(windowOf(s)).toContain(10);
  });

  test("scrolls up when active is above the window", () => {
    const base: ListViewportState = {
      count: 20,
      height: 4,
      offset: 10,
      activeIndex: 2,
    };
    const s = keepActiveVisible(base);
    expect(s.offset).toBe(2);
    expect(windowOf(s)).toContain(2);
  });

  test("leaves offset alone when active already visible", () => {
    const base: ListViewportState = {
      count: 20,
      height: 5,
      offset: 3,
      activeIndex: 5,
    };
    const s = keepActiveVisible(base);
    expect(s.offset).toBe(3);
  });

  test("clamps offset when list is shorter than height", () => {
    const s = keepActiveVisible({
      count: 3,
      height: 10,
      offset: 50,
      activeIndex: 1,
    });
    expect(s.offset).toBe(0);
    expect(visibleSlice(s).end).toBe(3);
  });
});

describe("moveActive", () => {
  test("moves down and keeps active visible", () => {
    let s = createListViewport({ count: 20, height: 4 });
    for (let i = 0; i < 6; i++) s = moveActive(s, 1);
    expect(s.activeIndex).toBe(6);
    expect(s.offset).toBe(6 - 4 + 1); // 3
    expect(windowOf(s)).toEqual([3, 4, 5, 6]);
  });

  test("moves up and keeps active visible", () => {
    let s = createListViewport({ count: 20, height: 4, activeIndex: 10 });
    s = moveActive(s, -3);
    expect(s.activeIndex).toBe(7);
    expect(windowOf(s)).toContain(7);
  });

  test("clamps at ends", () => {
    let s = createListViewport({ count: 5, height: 3 });
    s = moveActive(s, -10);
    expect(s.activeIndex).toBe(0);
    s = moveActive(s, 100);
    expect(s.activeIndex).toBe(4);
  });

  test("empty list is a no-op", () => {
    const s = moveActive(createListViewport({ count: 0, height: 5 }), 1);
    expect(s.activeIndex).toBe(0);
    expect(s.offset).toBe(0);
  });
});

describe("page", () => {
  test("pages down by height - 1", () => {
    const s0 = createListViewport({ count: 50, height: 10 });
    const s1 = page(s0, 1);
    expect(s1.activeIndex).toBe(9); // 10 - 1
    expect(windowOf(s1)).toContain(9);
  });

  test("pages up by height - 1", () => {
    let s = createListViewport({ count: 50, height: 10, activeIndex: 20 });
    s = page(s, -1);
    expect(s.activeIndex).toBe(11); // 20 - 9
    expect(windowOf(s)).toContain(11);
  });

  test("height 1 pages by 1", () => {
    let s = createListViewport({ count: 10, height: 1 });
    s = page(s, 1);
    expect(s.activeIndex).toBe(1);
    expect(s.offset).toBe(1);
  });

  test("page does not overshoot ends", () => {
    let s = createListViewport({ count: 12, height: 5 });
    s = page(s, 1);
    s = page(s, 1);
    s = page(s, 1);
    expect(s.activeIndex).toBe(11);
    s = page(s, -1);
    s = page(s, -1);
    s = page(s, -1);
    expect(s.activeIndex).toBe(0);
  });
});

describe("jump", () => {
  test("jumps mid-list and re-windows", () => {
    const s = jump(createListViewport({ count: 40, height: 6 }), 25);
    expect(s.activeIndex).toBe(25);
    expect(s.offset).toBe(25 - 6 + 1);
    expect(windowOf(s)).toContain(25);
  });

  test("clamps out-of-range jump", () => {
    expect(jump(createListViewport({ count: 10, height: 3 }), -3).activeIndex).toBe(0);
    expect(jump(createListViewport({ count: 10, height: 3 }), 99).activeIndex).toBe(9);
  });
});

describe("setHeight / height resize", () => {
  test("shrinking height keeps active visible", () => {
    let s = createListViewport({ count: 30, height: 10, activeIndex: 8 });
    expect(s.offset).toBe(0);
    s = setHeight(s, 4);
    expect(s.height).toBe(4);
    expect(s.activeIndex).toBe(8);
    // 8 was visible at offset 0 with height 10; with height 4 it is not → offset = 5
    expect(s.offset).toBe(8 - 4 + 1);
    expect(windowOf(s)).toEqual([5, 6, 7, 8]);
  });

  test("growing height may lower offset only via clamp", () => {
    let s = createListViewport({ count: 20, height: 3, activeIndex: 18 });
    expect(s.offset).toBe(16);
    s = setHeight(s, 10);
    expect(s.height).toBe(10);
    // max offset = 20 - 10 = 10; active 18 still visible in [10,20)
    expect(s.offset).toBe(10);
    expect(windowOf(s)).toContain(18);
  });

  test("height zero yields empty slice", () => {
    const s = setHeight(createListViewport({ count: 10, height: 5 }), 0);
    expect(visibleSlice(s)).toEqual({ start: 0, end: 0, activeIndex: 0 });
  });
});

describe("setCount", () => {
  test("shrinking list clamps active and offset", () => {
    let s = createListViewport({ count: 30, height: 5, activeIndex: 25 });
    s = setCount(s, 8);
    expect(s.count).toBe(8);
    expect(s.activeIndex).toBe(7);
    expect(s.offset).toBe(maxOffsetLike(8, 5));
    expect(windowOf(s)).toContain(7);
  });
});

function maxOffsetLike(count: number, height: number): number {
  return Math.max(0, count - height);
}

describe("visibleSlice", () => {
  test("end is exclusive", () => {
    const s = createListViewport({ count: 10, height: 3 });
    const slice = visibleSlice(s);
    expect(slice.end - slice.start).toBe(3);
    expect(slice.end).toBe(3);
  });

  test("short list end equals count", () => {
    const s = createListViewport({ count: 2, height: 8 });
    expect(visibleSlice(s)).toEqual({ start: 0, end: 2, activeIndex: 0 });
  });
});
