import { describe, expect, test } from "bun:test";

import { createAdmissionQueue } from "./admission.js";

describe("createAdmissionQueue", () => {
  test("FIFO: capacity 1, second job starts only after release", () => {
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 1 });
    expect(
      queue.enqueue({
        id: "a",
        provider: "p",
        start: () => {
          started.push("a");
        },
      }),
    ).toBe("running");
    expect(
      queue.enqueue({
        id: "b",
        provider: "p",
        start: () => {
          started.push("b");
        },
      }),
    ).toBe("queued");
    expect(started).toEqual(["a"]);
    queue.release("a");
    expect(started).toEqual(["a", "b"]);
  });

  test("a throwing start thunk does not leak the slot", () => {
    const queue = createAdmissionQueue({ capacity: 1 });
    expect(() =>
      queue.enqueue({
        id: "a",
        provider: "p",
        start: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    expect(queue.occupied("a")).toBe(false);
    const started: string[] = [];
    expect(
      queue.enqueue({
        id: "b",
        provider: "p",
        start: () => {
          started.push("b");
        },
      }),
    ).toBe("running");
    expect(started).toEqual(["b"]);
  });

  test("setCapacity lower does not cancel the running job", () => {
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 2 });
    queue.enqueue({
      id: "a",
      provider: "p",
      start: () => {
        started.push("a");
      },
    });
    queue.enqueue({
      id: "b",
      provider: "p",
      start: () => {
        started.push("b");
      },
    });
    expect(
      queue.enqueue({
        id: "c",
        provider: "p",
        start: () => {
          started.push("c");
        },
      }),
    ).toBe("queued");
    queue.setCapacity(1);
    expect(started).toEqual(["a", "b"]);
    queue.release("a");
    expect(started).toEqual(["a", "b"]);
    queue.release("b");
    expect(started).toEqual(["a", "b", "c"]);
  });

  test("notePressure delays the next admit; quota_exhausted is not this module's job", () => {
    let t = 1_000;
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 2, now: () => t });
    queue.enqueue({
      id: "a",
      provider: "p",
      start: () => {
        started.push("a");
      },
    });
    queue.release("a");
    queue.notePressure("p", t + 5_000);
    expect(
      queue.enqueue({
        id: "b",
        provider: "p",
        start: () => {
          started.push("b");
        },
      }),
    ).toBe("queued");
    expect(started).toEqual(["a"]);
    t = 6_000;
    queue.release("missing");
    expect(started).toEqual(["a", "b"]);
  });

  test("cancel on queued never invokes the start thunk", () => {
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 1 });
    queue.enqueue({
      id: "a",
      provider: "p",
      start: () => {
        started.push("a");
      },
    });
    queue.enqueue({
      id: "b",
      provider: "p",
      start: () => {
        started.push("b");
      },
    });
    queue.cancel("b");
    queue.release("a");
    expect(started).toEqual(["a"]);
    queue.cancel("a");
    expect(started).toEqual(["a"]);
  });

  test("nested-parent child bypasses capacity", () => {
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 1 });
    queue.enqueue({
      id: "parent",
      provider: "p",
      start: () => {
        started.push("parent");
      },
    });
    expect(
      queue.enqueue({
        id: "child",
        provider: "p",
        bypass: true,
        start: () => {
          started.push("child");
        },
      }),
    ).toBe("running");
    expect(started).toEqual(["parent", "child"]);
    expect(
      queue.enqueue({
        id: "root-extra",
        provider: "p",
        start: () => {
          started.push("root-extra");
        },
      }),
    ).toBe("queued");
    expect(started).toEqual(["parent", "child"]);
  });

  test("capacity bypass still waits on a provider pause", () => {
    const t = 1_000;
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 1, now: () => t });
    queue.enqueue({
      id: "parent",
      provider: "p",
      start: () => {
        started.push("parent");
      },
    });
    queue.notePressure("p", t + 5_000);
    expect(
      queue.enqueue({
        id: "child",
        provider: "p",
        bypass: true,
        start: () => {
          started.push("child");
        },
      }),
    ).toBe("queued");
    expect(started).toEqual(["parent"]);
  });

  test("drain skips a paused provider so another provider can start", () => {
    const t = 1_000;
    const started: string[] = [];
    const queue = createAdmissionQueue({ capacity: 1, now: () => t });
    queue.enqueue({
      id: "a",
      provider: "p1",
      start: () => {
        started.push("a");
      },
    });
    queue.release("a");
    queue.notePressure("p1", t + 5_000);
    expect(
      queue.enqueue({
        id: "b",
        provider: "p1",
        start: () => {
          started.push("b");
        },
      }),
    ).toBe("queued");
    expect(
      queue.enqueue({
        id: "c",
        provider: "p2",
        start: () => {
          started.push("c");
        },
      }),
    ).toBe("running");
    expect(started).toEqual(["a", "c"]);
  });

  test("duplicate enqueue of an in-flight id does not start twice", () => {
    let starts = 0;
    const queue = createAdmissionQueue({ capacity: 1 });
    expect(
      queue.enqueue({
        id: "a",
        provider: "p",
        start: () => {
          starts += 1;
        },
      }),
    ).toBe("running");
    expect(queue.occupied("a")).toBe(true);
    expect(
      queue.enqueue({
        id: "a",
        provider: "p",
        start: () => {
          starts += 1;
        },
      }),
    ).toBe("running");
    expect(starts).toBe(1);
  });
});
