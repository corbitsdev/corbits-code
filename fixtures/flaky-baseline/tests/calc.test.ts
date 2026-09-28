import { describe, test, expect } from "bun:test";
import { add, multiply, divide } from "../src/calc.js";

describe("calc", () => {
  test("add", () => {
    expect(add(2, 3)).toBe(5);
  });

  test("multiply", () => {
    expect(multiply(4, 5)).toBe(20);
  });

  // Intentionally failing baseline test
  test("divide", () => {
    expect(divide(10, 2)).toBe(3);
  });
});
