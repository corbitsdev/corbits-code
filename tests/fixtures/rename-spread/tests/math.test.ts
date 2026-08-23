import { describe, expect, test } from "bun:test";
import { addNumbers, double } from "../src/math.ts";
import { average, total } from "../src/calc.ts";
import { pairSum, report } from "../src/index.ts";

describe("math surface", () => {
  test("addNumbers", () => {
    expect(addNumbers(2, 3)).toBe(5);
  });

  test("double", () => {
    expect(double(4)).toBe(8);
  });

  test("total and average", () => {
    expect(total([1, 2, 3])).toBe(6);
    expect(average([2, 4])).toBe(3);
  });

  test("report and pairSum", () => {
    expect(report([2, 4])).toEqual({ sum: 6, mean: 3, twiceFirst: 4 });
    expect(pairSum(10, 1)).toBe(11);
  });
});
