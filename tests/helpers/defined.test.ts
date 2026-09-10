import { expect, test } from "bun:test";

import { defined } from "./defined.js";

test("returns a present value", () => {
  expect(defined("ok", "label")).toBe("ok");
  expect(defined(0, "zero")).toBe(0);
  expect(defined(false, "flag")).toBe(false);
});

test("throws when the value is null or undefined", () => {
  expect(() => defined(undefined, "missing")).toThrow(
    "expected missing to be defined",
  );
  expect(() => defined(null, "empty")).toThrow("expected empty to be defined");
});
