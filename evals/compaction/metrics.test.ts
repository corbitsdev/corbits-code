import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  grade,
  Measurement,
  qualifyingFold,
  recoverEvidence,
  repeatedWork,
  type Fold,
} from "./metrics.js";

const fact = { id: "region", source: "operator:correction", value: "west" };
const folds: Fold[] = [10, 20, 30].map((call) => ({
  requestedAtCall: call,
  beforeHash: `before-${call}`,
  afterHash: `after-${call}`,
  beforeTurns: 20,
  afterTurns: 10,
  persisted: true,
  continuedAtCall: call + 1,
}));
const baseline = {
  expected: [fact],
  recovered: [fact],
  expectedArtifact: "west\n",
  artifact: "west\n",
  folds,
  trace: [],
};

describe("compaction baseline grading", () => {
  test("requires evidence actually visible to the scripted responder", () => {
    expect(recoverEvidence("[[evidence:region|operator:correction|west]]")).toEqual([fact]);
    expect(recoverEvidence("The region was mentioned earlier.")).toEqual([]);
    expect(
      grade({ ...baseline, recovered: recoverEvidence("evidence removed") }).factualRecovery,
    ).toBe(false);
  });

  test("rejects wrong values, sources, and altered artifacts independently", () => {
    expect(grade(baseline).passed).toBe(true);
    expect(grade({ ...baseline, recovered: [{ ...fact, value: "east" }] }).passed).toBe(false);
    expect(grade({ ...baseline, recovered: [{ ...fact, source: "invented" }] }).passed).toBe(false);
    const altered = grade({ ...baseline, artifact: "east\n" });
    expect(altered.completion).toBe(false);
    expect(altered.factualRecovery).toBe(true);
  });

  test("keeps failed fold denominators and rejects requests, no-ops, and missing continuation", () => {
    expect(grade({ ...baseline, folds: [] }).qualifying).toBe(false);
    for (const fold of folds) {
      expect(qualifyingFold({ ...fold, persisted: false })).toBe(false);
      expect(qualifyingFold({ ...fold, afterHash: fold.beforeHash })).toBe(false);
      expect(qualifyingFold({ ...fold, continuedAtCall: null })).toBe(false);
      expect(qualifyingFold({ ...fold, afterTurns: fold.beforeTurns })).toBe(false);
    }
    expect(grade({ ...baseline, recovered: [] }).requiredFacts).toBe(1);
  });

  test("counts repeated work separately from legitimate scheduled verification", () => {
    const read = {
      name: "read_file",
      argumentsKey: "a",
      outcome: "success",
      purpose: "action",
    } as const;
    const search = { ...read, name: "grep" };
    const failure = { ...read, name: "run_shell", outcome: "failure" } as const;
    const edit = { ...read, name: "edit_file" };
    const trace = [
      read,
      read,
      search,
      search,
      failure,
      failure,
      edit,
      edit,
      { ...read, purpose: "verification" } as const,
    ];
    expect(repeatedWork(trace)).toEqual({
      repeatedReads: 1,
      repeatedSearches: 1,
      repeatedFailedAttempts: 1,
      duplicatedEdits: 1,
      verificationCalls: 1,
    });
    expect(grade({ ...baseline, trace }).passed).toBe(false);
  });

  test("missing usage is unavailable, not zero or an unlabelled estimate", () => {
    expect(Measurement({ status: "unavailable", reason: "offline" }) instanceof type.errors).toBe(
      false,
    );
    expect(
      Measurement({ status: "reported", value: -1, unit: "tokens" }) instanceof type.errors,
    ).toBe(true);
    expect(Measurement({ value: 0, unit: "tokens" }) instanceof type.errors).toBe(true);
    expect(
      Measurement({ status: "synthetic", value: 200000, unit: "trigger tokens" }) instanceof
        type.errors,
    ).toBe(false);
  });
});
