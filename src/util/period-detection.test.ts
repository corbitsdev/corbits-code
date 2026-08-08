import { describe, expect, test } from "bun:test";
import { detectSequencePeriod } from "./period-detection.js";

describe("detectSequencePeriod", () => {
  test("finds a period-1 (identical) run at the required repeat count", () => {
    const result = detectSequencePeriod(["a", "a", "a"], {
      minPeriod: 1,
      maxPeriod: 8,
      minRepeats: 3,
    });
    expect(result).toEqual({ repeating: true, period: 1, repeats: 3 });
  });

  test("finds a period-2 cycle a plain consecutive-identical check would miss", () => {
    const result = detectSequencePeriod(["a", "b", "a", "b", "a", "b"], {
      minPeriod: 1,
      maxPeriod: 8,
      minRepeats: 3,
    });
    expect(result).toEqual({ repeating: true, period: 2, repeats: 3 });
  });

  test("finds a period-3 cycle", () => {
    const result = detectSequencePeriod(["a", "b", "c", "a", "b", "c", "a", "b", "c"], {
      minPeriod: 1,
      maxPeriod: 8,
      minRepeats: 3,
    });
    expect(result).toEqual({ repeating: true, period: 3, repeats: 3 });
  });

  test("varied sequences never register as periodic", () => {
    const seq = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    const result = detectSequencePeriod(seq, { minPeriod: 1, maxPeriod: 8, minRepeats: 3 });
    expect(result.repeating).toBe(false);
  });

  test("minRepeats can vary by period", () => {
    // Period 1 needs 5 repeats, period 2+ only needs 3 — 4 identical items
    // should not register even though a fixed threshold of 3 would catch it.
    const identical = detectSequencePeriod(["a", "a", "a", "a"], {
      minPeriod: 1,
      maxPeriod: 8,
      minRepeats: (period) => (period === 1 ? 5 : 3),
    });
    expect(identical.repeating).toBe(false);

    const cycle = detectSequencePeriod(["a", "b", "a", "b", "a", "b"], {
      minPeriod: 1,
      maxPeriod: 8,
      minRepeats: (period) => (period === 1 ? 5 : 3),
    });
    expect(cycle).toEqual({ repeating: true, period: 2, repeats: 3 });
  });

  test("minDistinct rejects a degenerate monochrome match at a longer period", () => {
    // "aaaa" is trivially periodic at every period, but period 1 already
    // satisfies minRepeats first (ascending scan), so it never reaches a
    // longer period where a distinct-unit floor would matter. Confirm the
    // floor is still enforced when period 1 is excluded from the scan.
    const result = detectSequencePeriod(["a", "a", "a", "a", "a", "a"], {
      minPeriod: 2,
      maxPeriod: 8,
      minRepeats: 3,
      minDistinct: () => 2,
    });
    expect(result.repeating).toBe(false);
  });
});
