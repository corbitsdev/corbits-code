import { test, expect } from "bun:test";
import { parseList } from "./parse.js";

// Reproduces the bug: surrounding whitespace and empty segments leak through.
test("parseList trims items and drops empties", () => {
  expect(parseList("a, b ,c")).toEqual(["a", "b", "c"]);
  expect(parseList("x, ,y,")).toEqual(["x", "y"]);
});
