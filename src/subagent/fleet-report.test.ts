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

  test("an empty or fully-terminal fleet counts zero", () => {
    expect(liveFleetCount([])).toBe(0);
    expect(liveFleetCount([lane({ id: "a", status: "done", report: "x" })])).toBe(0);
  });
});

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
          report: "## Summary\nRewired the reporter and added six tests.",
        }),
        lane({ id: "docs" }),
      ],
      T0 + 1000,
    );
    // Board still has a live lane; parent prose owns the success narrative.
    expect(updates).toEqual([]);
  });

  test("the last lane finishing is one dry-fleet line, not per-lane prose", () => {
    const seeded = observeFleet(
      createFleetWatch(),
      [lane({ id: "api" }), lane({ id: "docs", status: "done" })],
      T0,
    ).watch;
    const { updates } = observeFleet(
      seeded,
      [lane({ id: "api", status: "done", report: "done" }), lane({ id: "docs", status: "done" })],
      T0 + 1000,
    );
    expect(updates).toEqual(["2 done · nothing running"]);
  });

  test("a failure names what went wrong while the fleet is still live", () => {
    const seeded = observeFleet(
      createFleetWatch(),
      [lane({ id: "build" }), lane({ id: "docs" })],
      T0,
    ).watch;
    const { updates } = observeFleet(
      seeded,
      [lane({ id: "build", status: "failed", error: "typecheck exited 1" }), lane({ id: "docs" })],
      T0 + 1000,
    );
    expect(updates[0]).toContain("build failed — typecheck exited 1");
  });

  test("a live dispatch does not re-announce into the transcript (board owns it)", () => {
    const seeded = observeFleet(createFleetWatch(), [lane({ id: "api" })], T0).watch;
    const { updates } = observeFleet(
      seeded,
      [lane({ id: "api" }), lane({ id: "docs" })],
      T0 + 1000,
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
    const seeded = observeFleet(createFleetWatch(), [lane({ id: "api" })], T0).watch;
    const busy = observeFleet(
      seeded,
      [lane({ id: "api", lastActivityAt: T0 + 4000, currentToolName: "grep" })],
      T0 + 5000,
    );
    expect(busy.updates).toEqual([]);
  });

  test("fleet going dry collapses a burst into one tally line", () => {
    const before = Array.from({ length: 12 }, (_, i) => lane({ id: `l${i}` }));
    const seeded = observeFleet(createFleetWatch(), before, T0).watch;
    const after = before.map((l, i) =>
      i < 9
        ? { ...l, status: "done" as const, report: "ok" }
        : { ...l, status: "failed" as const, error: "boom" },
    );
    const { updates } = observeFleet(seeded, after, T0 + 1000);
    expect(updates).toEqual(["9 done, 3 failed · nothing running"]);
  });

  test("a cancelled-only dry fleet counts cancelled, not failed", () => {
    const seeded = observeFleet(
      createFleetWatch(),
      [lane({ id: "api" }), lane({ id: "docs" })],
      T0,
    ).watch;
    const { updates } = observeFleet(
      seeded,
      [lane({ id: "api", status: "cancelled" }), lane({ id: "docs", status: "cancelled" })],
      T0 + 1000,
    );
    expect(updates).toEqual(["0 done, 2 cancelled · nothing running"]);
  });

  test("a mixed dry fleet names done, failed, and cancelled separately", () => {
    const seeded = observeFleet(
      createFleetWatch(),
      [lane({ id: "api" }), lane({ id: "docs" }), lane({ id: "web" })],
      T0,
    ).watch;
    const { updates } = observeFleet(
      seeded,
      [
        lane({ id: "api", status: "done", report: "ok" }),
        lane({ id: "docs", status: "failed", error: "boom" }),
        lane({ id: "web", status: "cancelled" }),
      ],
      T0 + 1000,
    );
    expect(updates).toEqual(["1 done, 1 failed, 1 cancelled · nothing running"]);
  });

  test("a burst of live cancels coalesces as cancelled, not failed", () => {
    const before = Array.from({ length: 5 }, (_, i) => lane({ id: `l${i}` }));
    const seeded = observeFleet(createFleetWatch(), before, T0).watch;
    const after = before.map((l, i) => (i < 4 ? { ...l, status: "cancelled" as const } : l));
    const { updates } = observeFleet(seeded, after, T0 + 1000);
    expect(updates).toEqual(["4 cancelled"]);
  });
});

describe("fleetDigest", () => {
  test("one row carries running lanes, their clocks, and the finished tally", () => {
    const digest = fleetDigest(
      [
        lane({ id: "api", startedAt: T0 - 80_000, lastActivityAt: T0 - 1000 }),
        lane({ id: "docs", startedAt: T0 - 20_000, lastActivityAt: T0 - 120_000 }),
        lane({ id: "web", status: "done" }),
        lane({ id: "cli", status: "failed" }),
      ],
      T0,
    );
    expect(digest).toBe("2 running (api 1:20, docs 0:20) · 1 done · 1 failed");
  });

  test("a fleet with nothing left running says so rather than going blank", () => {
    expect(fleetDigest([lane({ id: "api", status: "done" })], T0)).toBe("nothing running · 1 done");
    expect(fleetDigest([], T0)).toBe("nothing running");
  });

  test("cancelled lanes are named separately from failed", () => {
    expect(
      fleetDigest(
        [lane({ id: "api", status: "cancelled" }), lane({ id: "cli", status: "failed" })],
        T0,
      ),
    ).toBe("nothing running · 1 failed · 1 cancelled");
  });
});

describe("forced-stop reasons", () => {
  test("a lane finished by a forced stop announces the reason, not a bare done", () => {
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
          stopReason: "stalled",
        }),
        lane({ id: "docs" }),
      ],
      T0 + 1000,
    );
    expect(updates).toEqual(["api stopped — stalled"]);
  });

  test("a cancelled lane carries its recorded reason", () => {
    const seeded = observeFleet(
      createFleetWatch(),
      [lane({ id: "api" }), lane({ id: "docs" })],
      T0,
    ).watch;
    const { updates } = observeFleet(
      seeded,
      [
        lane({ id: "api", status: "cancelled", stopReason: "cancelled — Session closed" }),
        lane({ id: "docs" }),
      ],
      T0 + 1000,
    );
    expect(updates).toEqual(["api stopped — cancelled — Session closed"]);
  });
});
