import { describe, expect, test } from "bun:test";
import {
  createFleetWatch,
  fleetDigest,
  liveFleetCount,
  observeFleet,
  type FleetLane,
} from "./fleet-report.js";

const T0 = 1_000_000;

function lane(overrides: Partial<FleetLane> & { id: string }): FleetLane {
  return {
    description: overrides.id,
    status: "running",
    startedAt: T0,
    lastActivityAt: T0,
    currentToolName: null,
    currentToolPreview: null,
    currentToolStartedAt: null,
    ...overrides,
  };
}

describe("liveFleetCount", () => {
  test("counts only running lanes — the idle-with-fleet hold reads the same definition", () => {
    const lanes = [
      lane({ id: "a" }),
      lane({ id: "b", status: "done", report: "## Summary\nDone." }),
      lane({ id: "c", status: "failed", error: "boom" }),
      lane({ id: "d", status: "cancelled" }),
      lane({ id: "e" }),
    ];
    expect(liveFleetCount(lanes)).toBe(2);
  });

  test("interrupted leftovers are not live occupancy", () => {
    const lanes = [
      lane({ id: "a", lifecycleStatus: "interrupted" }),
      lane({ id: "b", status: "done", report: "x" }),
      lane({ id: "c" }),
    ];
    expect(liveFleetCount(lanes)).toBe(1);
  });

  test("interrupt-all with no running workers is live count 0", () => {
    const lanes = [
      lane({ id: "a", lifecycleStatus: "interrupted" }),
      lane({ id: "b", lifecycleStatus: "interrupted" }),
    ];
    expect(liveFleetCount(lanes)).toBe(0);
  });

  test("an empty or fully-terminal fleet counts zero", () => {
    expect(liveFleetCount([])).toBe(0);
    expect(
      liveFleetCount([lane({ id: "a", status: "done", report: "x" })]),
    ).toBe(0);
  });
});

function observeAfter(before: FleetLane[], after: FleetLane[]) {
  const seeded = observeFleet(createFleetWatch(), before, T0).watch;
  return observeFleet(seeded, after, T0 + 1000);
}

function mixedDryUpdates(docs: {
  status: FleetLane["status"];
  lifecycleStatus: NonNullable<FleetLane["lifecycleStatus"]>;
}): readonly string[] {
  const seeded = observeFleet(
    createFleetWatch(),
    [lane({ id: "api" }), lane({ id: "docs" })],
    T0,
  ).watch;
  const { updates } = observeFleet(
    seeded,
    [
      lane({
        id: "api",
        status: "done",
        lifecycleStatus: "completed",
        report: "ok",
      }),
      lane({
        id: "docs",
        status: docs.status,
        lifecycleStatus: docs.lifecycleStatus,
      }),
    ],
    T0 + 1000,
  );
  return updates;
}

describe("observeFleet", () => {
  test("the first observation seeds without announcing an in-flight fleet", () => {
    const { watch, updates } = observeFleet(
      createFleetWatch(),
      [lane({ id: "api" }), lane({ id: "docs" })],
      T0,
    );
    expect(updates).toEqual([]);
    expect(watch.running).toBe(2);
  });

  test("a finished lane does not dump a done-summary into the transcript", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" })],
      [
        lane({
          id: "api",
          status: "done",
          report: "## Summary\nRewired the reporter and added six tests.",
        }),
        lane({ id: "docs" }),
      ],
    );
    // Board still has a live lane; parent prose owns the success narrative.
    expect(updates).toEqual([]);
  });

  test("the last lane finishing is one dry-fleet line, not per-lane prose", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs", status: "done" })],
      [
        lane({ id: "api", status: "done", report: "done" }),
        lane({ id: "docs", status: "done" }),
      ],
    );
    expect(updates).toEqual(["2 done"]);
  });

  test("a failure names what went wrong while the fleet is still live", () => {
    const { updates } = observeAfter(
      [lane({ id: "build" }), lane({ id: "docs" })],
      [
        lane({ id: "build", status: "failed", error: "typecheck exited 1" }),
        lane({ id: "docs" }),
      ],
    );
    expect(updates[0]).toContain("build failed — typecheck exited 1");
  });

  test("a live dispatch does not re-announce into the transcript (board owns it)", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" })],
      [lane({ id: "api" }), lane({ id: "docs" })],
    );
    expect(updates).toEqual([]);
  });

  test("a quiet lane is not announced into the transcript (rollup owns it)", () => {
    const quiet = lane({ id: "api", lastActivityAt: T0 });
    const seeded = observeFleet(createFleetWatch(), [quiet], T0).watch;
    const first = observeFleet(seeded, [quiet], T0 + 60_000);
    expect(first.updates).toEqual([]);
    const second = observeFleet(first.watch, [quiet], T0 + 90_000);
    expect(second.updates).toEqual([]);
  });

  test("routine activity that changes nothing produces no update", () => {
    const seeded = observeFleet(
      createFleetWatch(),
      [lane({ id: "api" })],
      T0,
    ).watch;
    const busy = observeFleet(
      seeded,
      [lane({ id: "api", lastActivityAt: T0 + 4000, currentToolName: "grep" })],
      T0 + 5000,
    );
    expect(busy.updates).toEqual([]);
  });

  test("fleet going dry collapses a burst into one tally line", () => {
    const before = Array.from({ length: 12 }, (_, i) => lane({ id: `l${i}` }));
    const after = before.map((l, i) =>
      i < 9
        ? { ...l, status: "done" as const, report: "ok" }
        : { ...l, status: "failed" as const, error: "boom" },
    );
    expect(observeAfter(before, after).updates).toEqual(["9 done, 3 failed"]);
  });

  test("a cancelled-only dry fleet counts cancelled, not failed", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" })],
      [
        lane({ id: "api", status: "cancelled" }),
        lane({ id: "docs", status: "cancelled" }),
      ],
    );
    expect(updates).toEqual(["0 done, 2 cancelled"]);
  });

  test("a mixed dry fleet names done, failed, and cancelled separately", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" }), lane({ id: "web" })],
      [
        lane({ id: "api", status: "done", report: "ok" }),
        lane({ id: "docs", status: "failed", error: "boom" }),
        lane({ id: "web", status: "cancelled" }),
      ],
    );
    expect(updates).toEqual(["1 done, 1 failed, 1 cancelled"]);
  });

  test("a burst of live cancels coalesces as cancelled, not failed", () => {
    const before = Array.from({ length: 5 }, (_, i) => lane({ id: `l${i}` }));
    const after = before.map((l, i) =>
      i < 4 ? { ...l, status: "cancelled" as const } : l,
    );
    expect(observeAfter(before, after).updates).toEqual(["4 cancelled"]);
  });

  test("a mixed live burst names failed and cancelled separately", () => {
    const before = Array.from({ length: 5 }, (_, i) => lane({ id: `l${i}` }));
    const after = before.map((l, i) => {
      if (i < 2) return { ...l, status: "failed" as const, error: "boom" };
      if (i < 4) return { ...l, status: "cancelled" as const };
      return l;
    });
    expect(observeAfter(before, after).updates).toEqual([
      "2 failed, 2 cancelled",
    ]);
  });

  test("interrupt-all does not tally interrupted leftovers as 0 done", () => {
    const { watch, updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" })],
      [
        lane({
          id: "api",
          status: "running",
          lifecycleStatus: "interrupted",
        }),
        lane({
          id: "docs",
          status: "running",
          lifecycleStatus: "interrupted",
        }),
      ],
    );
    expect(watch.running).toBe(0);
    expect(updates.join(" ")).not.toContain("0 done");
    expect(updates).toEqual([]);
  });

  test("cancel-all counts cancelled even when lifecycleStatus is interrupted", () => {
    const { watch, updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" })],
      [
        lane({
          id: "api",
          status: "cancelled",
          lifecycleStatus: "interrupted",
        }),
        lane({
          id: "docs",
          status: "cancelled",
          lifecycleStatus: "interrupted",
        }),
      ],
    );
    expect(watch.running).toBe(0);
    expect(updates).toEqual(["0 done, 2 cancelled"]);
  });

  test("a mixed dry fleet counts done and cancelled with interrupted lifecycle", () => {
    expect(
      mixedDryUpdates({ status: "cancelled", lifecycleStatus: "interrupted" }),
    ).toEqual(["1 done, 1 cancelled"]);
  });

  test("a mixed dry fleet does not count interrupted leftovers as done", () => {
    expect(
      mixedDryUpdates({ status: "running", lifecycleStatus: "interrupted" }),
    ).toEqual(["1 done"]);
  });
});

describe("fleetDigest", () => {
  test("one row carries running lanes, their clocks, and the finished tally", () => {
    const digest = fleetDigest(
      [
        lane({ id: "api", startedAt: T0 - 80_000, lastActivityAt: T0 - 1000 }),
        lane({
          id: "docs",
          startedAt: T0 - 20_000,
          lastActivityAt: T0 - 120_000,
        }),
        lane({ id: "web", status: "done" }),
        lane({ id: "cli", status: "failed" }),
      ],
      T0,
    );
    expect(digest).toBe("2 running (api 1:20, docs 0:20) · 1 done · 1 failed");
  });

  test("a dry fleet is the outcome tally, not an idle claim", () => {
    expect(fleetDigest([lane({ id: "api", status: "done" })], T0)).toBe(
      "1 done",
    );
    expect(fleetDigest([], T0)).toBe("");
    expect(
      fleetDigest(
        [
          lane({
            id: "api",
            status: "running",
            lifecycleStatus: "interrupted",
          }),
          lane({
            id: "docs",
            status: "running",
            lifecycleStatus: "interrupted",
          }),
        ],
        T0,
      ),
    ).toBe("");
  });

  test("cancelled lanes are named separately from failed", () => {
    expect(
      fleetDigest(
        [
          lane({
            id: "api",
            status: "cancelled",
            lifecycleStatus: "interrupted",
          }),
          lane({
            id: "cli",
            status: "failed",
            lifecycleStatus: "shutdown",
          }),
        ],
        T0,
      ),
    ).toBe("1 failed · 1 cancelled");
  });

  test("a cancelled-only fleet names cancelled even when lifecycle is interrupted", () => {
    expect(
      fleetDigest(
        [
          lane({
            id: "api",
            status: "cancelled",
            lifecycleStatus: "interrupted",
          }),
          lane({
            id: "docs",
            status: "cancelled",
            lifecycleStatus: "interrupted",
          }),
        ],
        T0,
      ),
    ).toBe("2 cancelled");
  });

  test("mixed done and cancelled-with-interrupted lifecycle counts both", () => {
    expect(
      fleetDigest(
        [
          lane({
            id: "api",
            status: "done",
            lifecycleStatus: "completed",
          }),
          lane({
            id: "docs",
            status: "cancelled",
            lifecycleStatus: "interrupted",
          }),
        ],
        T0,
      ),
    ).toBe("1 done · 1 cancelled");
  });
});

describe("forced-stop reasons", () => {
  test("a lane finished by a forced stop announces the reason, not a bare done", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" })],
      [
        lane({ id: "api", status: "done", stopReason: "stalled" }),
        lane({ id: "docs" }),
      ],
    );
    expect(updates).toEqual(["api stopped — stalled"]);
  });

  test("a cancelled lane carries its recorded reason", () => {
    const { updates } = observeAfter(
      [lane({ id: "api" }), lane({ id: "docs" })],
      [
        lane({
          id: "api",
          status: "cancelled",
          stopReason: "cancelled — Session closed",
        }),
        lane({ id: "docs" }),
      ],
    );
    expect(updates).toEqual(["api stopped — cancelled — Session closed"]);
  });
});
