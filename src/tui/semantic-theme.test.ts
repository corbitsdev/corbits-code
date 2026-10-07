import { test, expect, afterEach, beforeEach } from "bun:test";
import {
  color,
  color256,
  palette,
  supportsTrueColor,
} from "./semantic-theme.js";

const originalColorterm = process.env.COLORTERM;

// `color()` answers hex only on a truecolor terminal and ANSI-256 otherwise,
// so every hex assertion below asserts the terminal it runs in. State the
// terminal rather than inherit it; the two tests that exercise detection set
// it themselves.
beforeEach(() => {
  process.env.COLORTERM = "truecolor";
});

afterEach(() => {
  if (originalColorterm === undefined) {
    delete process.env.COLORTERM;
  } else {
    process.env.COLORTERM = originalColorterm;
  }
});

test("every role maps to a valid ANSI-256 index", () => {
  for (const role of Object.keys(palette) as (keyof typeof palette)[]) {
    const idx = color256(role);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(255);
  }
});

test("every role exposes a six-digit hex value", () => {
  for (const role of Object.keys(palette) as (keyof typeof palette)[]) {
    expect(color(role)).toMatch(/^#[0-9a-fA-F]{6}$/);
  }
});

test("diff backgrounds are distinct dark tints", () => {
  expect(palette.diffAddedBg.hex).not.toBe(palette.diffRemovedBg.hex);
  // The tints must stay apart in the 256-color tier too; the nearest-match
  // fallback for both hexes is the same neutral gray, which would erase the
  // added/removed distinction on non-truecolor terminals.
  expect(palette.diffAddedBg.ansi256).not.toBe(palette.diffRemovedBg.ansi256);
  for (const role of [
    "diffAddedBg",
    "diffRemovedBg",
    "userMessageBg",
  ] as const) {
    // Backgrounds must stay dark enough that every foreground reads on top.
    const channels = [1, 3, 5].map((i) =>
      parseInt(color(role).slice(i, i + 2), 16),
    );
    for (const channel of channels) expect(channel).toBeLessThan(0x60);
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
