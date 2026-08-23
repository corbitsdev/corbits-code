import { describe, expect, test } from "bun:test";
import { computeCheckoutTotal, platformFeeCents } from "../src/index.ts";

// EVAL_LOCK: expectations encode 175 bps — do not edit these numbers to silence failures.

describe("checkout fees", () => {
  test("platform fee is 175 bps of subtotal", () => {
    expect(platformFeeCents(10_000)).toBe(175);
    expect(platformFeeCents(20_000)).toBe(350);
  });

  test("checkout total adds the platform fee", () => {
    expect(computeCheckoutTotal(10_000)).toBe(10_175);
    expect(computeCheckoutTotal(20_000)).toBe(20_350);
  });

  test("zero subtotal stays zero", () => {
    expect(computeCheckoutTotal(0)).toBe(0);
  });
});
