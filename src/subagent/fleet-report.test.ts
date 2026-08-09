import { describe, expect, test } from "bun:test";
import {
  createFleetWatch,
  fleetDigest,
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
    ...overrides,
  };
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

  test("a finished lane is reported with what it produced", () => {
    const seeded = observeFleet(createFleetWatch(), [lane({ id: "api" })], T0).watch;
    const { updates } = observeFleet(
      seeded,
      [
        lane({
          id: "api",
          status: "done",
          report: "## Summary\nRewired the reporter and added six tests.",
        }),
      ],
      T0 + 1000,
    );
    expect(updates[0]).toBe(
      "fleet · api done — Rewired the reporter and added six tests.",
    );
  });

  test("the last lane finishing says so, which is the silence the operator hit", () => {
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
    expect(updates).toEqual([
      "fleet · api done — done",
      "fleet · 2 done — nothing running",
    ]);
  });

  test("a failure names what went wrong", () => {
    const seeded = observeFleet(createFleetWatch(), [lane({ id: "build" })], T0).watch;
    const { updates } = observeFleet(
      seeded,
      [lane({ id: "build", status: "failed", error: "typecheck exited 1" })],
      T0 + 1000,
    );
    expect(updates[0]).toContain("build failed — typecheck exited 1");
  });

  test("a dispatch carries the load it was decided against", () => {
    const seeded = observeFleet(createFleetWatch(), [lane({ id: "api" })], T0).watch;
    const { updates } = observeFleet(
      seeded,
      [lane({ id: "api" }), lane({ id: "docs" })],
      T0 + 1000,
    );
    expect(updates).toEqual(["fleet · dispatched docs (2 running)"]);
  });

  test("a quiet lane is announced once, not on every tick it stays quiet", () => {
    const quiet = lane({ id: "api", lastActivityAt: T0 });
    const seeded = observeFleet(createFleetWatch(), [quiet], T0).watch;
    const first = observeFleet(seeded, [quiet], T0 + 60_000);
    expect(first.updates[0]).toContain("api stalled");
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

  test("a dozen lanes landing at once collapse into one tally", () => {
    const before = Array.from({ length: 12 }, (_, i) => lane({ id: `l${i}` }));
    const seeded = observeFleet(createFleetWatch(), before, T0).watch;
    const after = before.map((l, i) =>
      i < 9
        ? { ...l, status: "done" as const, report: "ok" }
        : { ...l, status: "failed" as const, error: "boom" },
    );
    const { updates } = observeFleet(seeded, after, T0 + 1000);
    expect(updates).toEqual([
      "fleet · 9 done, 3 failed",
      "fleet · 9 done, 3 failed — nothing running",
    ]);
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
    expect(digest).toBe("fleet · 2 running (api 1:20, docs 0:20 stalled) · 1 done · 1 failed");
  });

  test("a fleet with nothing left running says so rather than going blank", () => {
    expect(fleetDigest([lane({ id: "api", status: "done" })], T0)).toBe(
      "fleet · nothing running · 1 done",
    );
    expect(fleetDigest([], T0)).toBe("fleet · no lanes dispatched");
  });
});
