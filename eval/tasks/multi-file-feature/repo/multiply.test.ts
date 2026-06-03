import { test, expect } from "bun:test";
import { multiply } from "./index.js";

test("multiply returns the product", () => {
  expect(multiply(3, 4)).toBe(12);
  expect(multiply(0, 9)).toBe(0);
});
