import { test, expect, afterEach } from "bun:test";
import { color, color256, palette, supportsTrueColor } from "../../../src/tui/theme.js";

const originalColorterm = process.env.COLORTERM;

afterEach(() => {
  if (originalColorterm === undefined) {
    delete process.env.COLORTERM;
  } else {
    process.env.COLORTERM = originalColorterm;
  }
});

test("color returns the brand hex", () => {
  expect(color("brand")).toBe("#f5933a");
});

test("color returns the accent (summit blue) hex", () => {
  expect(color("accent")).toBe("#7ea2c4");
});

test("warning reuses the brand orange hex", () => {
  expect(color("warning")).toBe(color("brand"));
});

test("color256 returns the ANSI-256 index for each role", () => {
  expect(color256("brand")).toBe(173);
  expect(color256("accent")).toBe(74);
  expect(color256("success")).toBe(108);
  expect(color256("danger")).toBe(167);
});

test("every role maps to a valid ANSI-256 index", () => {
  for (const role of Object.keys(palette) as Array<keyof typeof palette>) {
    const idx = color256(role);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(255);
  }
});

test("every role exposes a six-digit hex value", () => {
  for (const role of Object.keys(palette) as Array<keyof typeof palette>) {
    expect(color(role)).toMatch(/^#[0-9a-fA-F]{6}$/);
  }
});

test("supportsTrueColor detects truecolor terminals", () => {
  process.env.COLORTERM = "truecolor";
  expect(supportsTrueColor()).toBe(true);
  process.env.COLORTERM = "24bit";
  expect(supportsTrueColor()).toBe(true);
});

test("supportsTrueColor is false when COLORTERM is absent or basic", () => {
  delete process.env.COLORTERM;
  expect(supportsTrueColor()).toBe(false);
  process.env.COLORTERM = "256color";
  expect(supportsTrueColor()).toBe(false);
});
