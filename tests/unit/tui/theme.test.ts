import { test, expect, afterEach, beforeEach } from "bun:test";
import { color, color256, palette, supportsTrueColor } from "../../../src/tui/semantic-theme.js";

const originalColorterm = process.env.COLORTERM;

// `color()` answers hex only on a truecolor terminal and ANSI-256 otherwise, so
// every hex assertion below is really an assertion about the environment it
// runs in. A developer's terminal sets COLORTERM and a CI runner does not, which
// is why these passed locally and failed in CI. State the terminal rather than
// inherit it; the two tests that exercise detection set it themselves.
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

test("diff foregrounds alias the semantic status colors", () => {
  expect(palette.diffAdded).toEqual(palette.success);
  expect(palette.diffRemoved).toEqual(palette.danger);
  expect(palette.diffContext).toEqual(palette.dim);
  expect(palette.diffHunkHeader).toEqual(palette.accent);
});

test("diff backgrounds are distinct dark tints", () => {
  expect(palette.diffAddedBg.hex).not.toBe(palette.diffRemovedBg.hex);
  // The tints must stay apart in the 256-color tier too; the nearest-match
  // fallback for both hexes is the same neutral gray, which would erase the
  // added/removed distinction on non-truecolor terminals.
  expect(palette.diffAddedBg.ansi256).not.toBe(palette.diffRemovedBg.ansi256);
  for (const role of ["diffAddedBg", "diffRemovedBg", "userMessageBg"] as const) {
    // Backgrounds must stay dark enough that every foreground reads on top.
    const channels = [1, 3, 5].map((i) => parseInt(color(role).slice(i, i + 2), 16));
    for (const channel of channels) expect(channel).toBeLessThan(0x60);
  }
});

test("markdown tokens reuse the prose brightness ladder", () => {
  expect(palette.markdownHeading).toEqual(palette.emphasis);
  expect(palette.markdownStrong).toEqual(palette.emphasis);
  expect(palette.markdownLink).toEqual(palette.accent);
  expect(palette.markdownBlockquote).toEqual(palette.muted);
  expect(palette.markdownCode).toEqual(palette.brand);
});

test("syntax comments recede to the dim rung and strings match success green", () => {
  expect(palette.syntaxComment).toEqual(palette.dim);
  expect(palette.syntaxString).toEqual(palette.success);
  expect(palette.syntaxVariable).toEqual(palette.text);
});

test("userMessageBg preserves the established user box gray", () => {
  expect(color("userMessageBg")).toBe("#45454a");
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
