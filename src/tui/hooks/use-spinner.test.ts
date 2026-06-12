import { test, expect } from "bun:test";
import { computeAnchor } from "./use-spinner.js";

// C2: the elapsed clock must not reset to zero on every brief re-arm.
// computeAnchor encapsulates the anchor computation so we can verify
// the cumulative-clock invariant without a React test harness.

test("C2: anchor is approximately now when pausedElapsedMs is 0 (fresh start)", () => {
  const before = Date.now();
  const anchor = computeAnchor(0);
  const after = Date.now();
  // A fresh start computes anchor ≈ now (Date.now() - 0 = now).
  expect(anchor).toBeGreaterThanOrEqual(before - 1); // 1 ms tolerance
  expect(anchor).toBeLessThanOrEqual(after + 1);
});

test("C2: anchor is set in the past by pausedElapsedMs so the clock continues", () => {
  const accumulatedMs = 5000;
  const before = Date.now();
  const anchor = computeAnchor(accumulatedMs);
  const after = Date.now();
  // Date.now() - anchor should equal ~accumulatedMs so elapsed resumes from 5 s.
  const elapsed = Date.now() - anchor;
  expect(elapsed).toBeGreaterThanOrEqual(accumulatedMs - 5); // 5 ms tolerance
  expect(elapsed).toBeLessThanOrEqual(accumulatedMs + (after - before) + 5);
});

test("C2: computeAnchor returns a number", () => {
  expect(typeof computeAnchor(0)).toBe("number");
  expect(typeof computeAnchor(1234)).toBe("number");
});
