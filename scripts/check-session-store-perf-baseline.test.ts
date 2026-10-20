import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  COUNTED_OP_TOLERANCE,
  GIT_FANOUT_TOLERANCE,
  type BaselineFile,
  type CensusMeasurement,
  type PerfMeasurement,
  gateSessionStoreBaseline,
  gateSessionStoreBaselineJson,
} from "./check-session-store-perf-baseline.js";

const repoRoot = join(import.meta.dir, "..");
const baselinePath = join(
  repoRoot,
  "scripts",
  "results",
  "session-store-perf-baseline.json",
);
const baselineRaw = readFileSync(baselinePath, "utf8");
const ci = readFileSync(
  join(repoRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);

function parsedBaseline(): {
  baseline: BaselineFile;
  perf: PerfMeasurement;
  census: CensusMeasurement;
} {
  const failures = gateSessionStoreBaselineJson(
    baselineRaw,
    JSON.stringify(JSON.parse(baselineRaw).contextStorePerf),
    JSON.stringify(JSON.parse(baselineRaw).turnPersistenceCensus),
  );
  expect(failures).toEqual([]);
  const baseline = JSON.parse(baselineRaw) as BaselineFile;
  return {
    baseline,
    perf: baseline.contextStorePerf,
    census: baseline.turnPersistenceCensus,
  };
}

describe("session-store perf baseline", () => {
  test("checked-in snapshot matches the gate, ignoring wall time", () => {
    expect(COUNTED_OP_TOLERANCE).toBe(0);
    expect(GIT_FANOUT_TOLERANCE).toBe(64);
    const { baseline, perf, census } = parsedBaseline();
    const noisy = {
      ...perf,
      wallMs: 1,
      perTurn: { wallMs: 99, fsOps: 0 },
    };
    expect(gateSessionStoreBaseline(baseline, noisy, census)).toEqual([]);
  });

  test("a per-turn access outside .git fails; git fanout within slack passes", () => {
    const { baseline, perf, census } = parsedBaseline();
    const extraAccess: PerfMeasurement = {
      ...perf,
      fsOps: { ...perf.fsOps, access: (perf.fsOps.access ?? 0) + 1 },
    };
    expect(gateSessionStoreBaseline(baseline, extraAccess, census)).not.toEqual(
      [],
    );

    const fanout = GIT_FANOUT_TOLERANCE;
    const within: PerfMeasurement = {
      ...perf,
      fsOps: {
        ...perf.fsOps,
        mkdir: (perf.fsOps.mkdir ?? 0) + fanout,
        writeFile: (perf.fsOps.writeFile ?? 0) + fanout,
      },
      gitPathFsOpsByName: {
        ...perf.gitPathFsOpsByName,
        mkdir: (perf.gitPathFsOpsByName.mkdir ?? 0) + fanout,
        writeFile: (perf.gitPathFsOpsByName.writeFile ?? 0) + fanout,
      },
    };
    expect(gateSessionStoreBaseline(baseline, within, census)).toEqual([]);

    const past: PerfMeasurement = {
      ...perf,
      fsOps: {
        ...perf.fsOps,
        mkdir: (perf.fsOps.mkdir ?? 0) + fanout + 1,
      },
      gitPathFsOpsByName: {
        ...perf.gitPathFsOpsByName,
        mkdir: (perf.gitPathFsOpsByName.mkdir ?? 0) + fanout + 1,
      },
    };
    const failures = gateSessionStoreBaseline(baseline, past, census);
    expect(failures.some((line) => line.includes(".git mkdir"))).toBe(true);
  });

  test("CI runs both session-store perf scripts", () => {
    expect(ci).toContain("bun scripts/context-store-perf.ts 200 --json");
    expect(ci).toContain(
      "bun scripts/turn-persistence-census.ts 200 --flow=coalesced --json",
    );
  });
});
