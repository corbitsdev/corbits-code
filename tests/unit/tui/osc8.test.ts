import { test, expect } from "bun:test";
import { osc8Hyperlink } from "../../../src/tui/osc8.js";

test("wraps label with OSC 8 hyperlink sequences", () => {
  const out = osc8Hyperlink("https://example.com", "docs");
  expect(out).toContain("https://example.com");
  expect(out).toContain("docs");
  expect(out).toContain("\x1b]8;;");
});