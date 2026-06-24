import { expect, test } from "bun:test";
import {
  extraPromptChromeRows,
  promptContentWidth,
  promptInnerRowCount,
} from "../../../src/tui/prompt-layout.js";

test("promptContentWidth subtracts box chrome from columns", () => {
  expect(promptContentWidth(40)).toBe(32);
});

test("extraPromptChromeRows is zero for a single short line", () => {
  expect(extraPromptChromeRows("hello", 80, 24)).toBe(0);
});

test("extraPromptChromeRows grows with wrapped and multiline input", () => {
  const width = promptContentWidth(40);
  const long = "x".repeat(width + 10);
  expect(extraPromptChromeRows(long, 40, 24)).toBeGreaterThan(0);
  expect(extraPromptChromeRows("line one\nline two", 80, 24)).toBe(1);
});

test("promptInnerRowCount caps at 40% of terminal height", () => {
  const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const inner = promptInnerRowCount(many, 80, 20);
  expect(inner).toBeLessThanOrEqual(Math.max(3, Math.floor(20 * 0.4)) + 2);
});