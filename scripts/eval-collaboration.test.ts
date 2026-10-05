import { describe, expect, test } from "bun:test";
import scenariosJson from "../evals/collaboration/scenarios.json" with { type: "json" };
import { parseScenarioSetFile } from "../evals/collaboration/lib.js";
import {
  assertSupportedVersion,
  filterScenarios,
  parseArgs,
} from "./eval-collaboration.js";

describe("parseArgs validation", () => {
  test("rejects NaN, zero, and negative repeats", () => {
    expect(() => parseArgs(["--repeats", "NaN"])).toThrow(/--repeats/);
    expect(() => parseArgs(["--repeats", "0"])).toThrow(/--repeats/);
    expect(() => parseArgs(["--repeats", "-2"])).toThrow(/--repeats/);
  });

  test("rejects NaN and negative seeds", () => {
    expect(() => parseArgs(["--seed", "NaN"])).toThrow(/--seed/);
    expect(() => parseArgs(["--seed", "-1"])).toThrow(/--seed/);
  });

  test("accepts positive repeats and a zero seed", () => {
    const opts = parseArgs(["--repeats", "3", "--seed", "0"]);
    expect(opts.repeats).toBe(3);
    expect(opts.seed).toBe(0);
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["--model", "x"])).toThrow(/Unknown argument/);
  });
});

describe("filterScenarios", () => {
  const set = parseScenarioSetFile(scenariosJson);

  test("keeps the whole set for --case all", () => {
    expect(filterScenarios(set, "all").scenarios.length).toBe(
      set.scenarios.length,
    );
  });

  test("narrows to a single scenario id", () => {
    const filtered = filterScenarios(set, "collab-mailbox-yield");
    expect(filtered.scenarios.map((s) => s.id)).toEqual([
      "collab-mailbox-yield",
    ]);
  });

  test("rejects an unknown scenario id", () => {
    expect(() => filterScenarios(set, "no-such-scenario")).toThrow(
      /No scenario matches/,
    );
  });
});

describe("assertSupportedVersion", () => {
  const set = parseScenarioSetFile(scenariosJson);

  test("accepts the frozen set version", () => {
    expect(() => assertSupportedVersion(set)).not.toThrow();
  });

  test("refuses a bumped set version", () => {
    expect(() => assertSupportedVersion({ ...set, version: 2 })).toThrow(
      /refusing to record an incomparable baseline/,
    );
  });
});
