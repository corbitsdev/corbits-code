import { describe, expect, test } from "bun:test";
import scenariosJson from "./scenarios.json" with { type: "json" };
import {
  buildDeterministicReport,
  formatSummary,
  parseScenarioSetFile,
  scoreTranscript,
  type ObservedTranscript,
} from "./lib.js";

const set = parseScenarioSetFile(scenariosJson);

const EXPECTED_KINDS = [
  "misleading-summary",
  "buried-required-action",
  "conflicting-reports",
  "failed-checks",
  "report-overflow",
  "midflight-steering",
  "mailbox-yield",
  "changed-file-reread",
  "direct-question",
] as const;

describe("collaboration scenario set", () => {
  test("covers all nine collaboration kinds exactly once", () => {
    expect(set.version).toBe(1);
    expect(set.scenarios.map((s) => s.kind).sort()).toEqual(
      [...EXPECTED_KINDS].sort(),
    );
  });

  test("fixture versions are frozen and uniform", () => {
    for (const scenario of set.scenarios) {
      expect(scenario.fixtureVersion).toBe("collab-fixtures-v1");
      expect(scenario.prompt.trim().length).toBeGreaterThan(0);
      expect(scenario.expectedActions.length).toBeGreaterThan(0);
    }
  });
});

describe("positive controls", () => {
  test("every good transcript passes its scenario", () => {
    for (const scenario of set.scenarios) {
      const verdict = scoreTranscript(scenario, scenario.goodTranscript);
      expect(`${scenario.id}: ${JSON.stringify(verdict.results)}`).toBe(
        `${scenario.id}: ${JSON.stringify(
          verdict.results.map((r) => ({ ...r, ok: true })),
        )}`,
      );
      expect(verdict.passed).toBe(true);
    }
  });
});

describe("negative controls", () => {
  test("every bad transcript fails for its intended reasons", () => {
    for (const scenario of set.scenarios) {
      const verdict = scoreTranscript(scenario, scenario.badTranscript);
      expect(verdict.passed).toBe(false);
      const failedIds = verdict.results.filter((r) => !r.ok).map((r) => r.id);
      for (const miss of scenario.badMisses) {
        expect(failedIds).toContain(miss);
      }
    }
  });
});

describe("scorer sensitivity", () => {
  test("dropping a required tool call flips a good transcript to fail", () => {
    const scenario = set.scenarios.find(
      (s) => s.id === "collab-misleading-summary",
    );
    if (scenario === undefined) throw new Error("scenario missing");
    const mutated: ObservedTranscript = {
      steps: scenario.goodTranscript.steps.filter(
        (step) => !(step.step === "tool" && step.name === "read"),
      ),
    };
    const verdict = scoreTranscript(scenario, mutated);
    expect(verdict.passed).toBe(false);
  });

  test("altering the decisive reply value flips a good transcript to fail", () => {
    const scenario = set.scenarios.find(
      (s) => s.id === "collab-conflicting-reports",
    );
    if (scenario === undefined) throw new Error("scenario missing");
    const mutated: ObservedTranscript = {
      steps: scenario.goodTranscript.steps.map((step) =>
        step.step === "reply"
          ? { ...step, text: (step.text ?? "").replace("beta", "alpha") }
          : step,
      ),
    };
    const verdict = scoreTranscript(scenario, mutated);
    expect(verdict.passed).toBe(false);
  });

  test("an empty transcript passes nothing", () => {
    for (const scenario of set.scenarios) {
      expect(scoreTranscript(scenario, { steps: [] }).passed).toBe(false);
    }
  });
});

describe("deterministic report", () => {
  test("paired controls are all satisfied and live metrics stay unknown", () => {
    const report = buildDeterministicReport(set, {
      commitSha: "test-sha",
      repeats: 1,
      seed: 424242,
    });
    expect(report.totals.trialsTotal).toBe(set.scenarios.length * 2);
    expect(report.totals.controlsFailed).toBe(0);
    expect(report.totals.sensitivity).toBe(1);
    expect(report.live.status).toBe("not-run");
    expect(report.live.unknownMetrics).toContain("tokenUsage");
    expect(report.live.unknownMetrics).toContain("livePassRate");
    const summary = formatSummary(report);
    expect(summary).toContain("sensitivity 100.0%");
    expect(summary).toContain("unknown");
  });

  test("refuses a set with drifted fixture versions instead of recording a baseline", () => {
    const tampered = {
      ...set,
      scenarios: set.scenarios.map((scenario, index) =>
        index === 0
          ? { ...scenario, fixtureVersion: "tampered-v99" }
          : scenario,
      ),
    };
    expect(() =>
      buildDeterministicReport(tampered, {
        commitSha: "test-sha",
        repeats: 1,
        seed: 424242,
      }),
    ).toThrow(/tampered-v99.*refusing to record an incomparable baseline/);
  });
});
