import { test, expect } from "bun:test";
import { sum } from "./sum.js";

test("sum adds its arguments", () => {
  expect(sum(2, 3)).toBe(5);
  expect(sum(-1, 1)).toBe(0);
});
