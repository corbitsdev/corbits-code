import { describe, test, expect } from "bun:test";
import {
  STACK_FORM_COLUMNS,
  fitTrailingText,
  formContentWidth,
  wrapHelpSegments,
} from "./form-reflow.js";

describe("fitTrailingText", () => {
  test("returns the full string when it fits", () => {
    expect(fitTrailingText("hello", 10)).toBe("hello");
  });

  test("keeps the trailing slice with an ellipsis when truncated", () => {
    expect(fitTrailingText("abcdefghijklmnopqrstuvwxyz", 10)).toBe("…rstuvwxyz");
  });

  test("handles a one-cell budget", () => {
    expect(fitTrailingText("long-value", 1)).toBe("…");
  });

  test("returns empty for non-positive budgets", () => {
    expect(fitTrailingText("x", 0)).toBe("");
    expect(fitTrailingText("x", -3)).toBe("");
  });
});

describe("wrapHelpSegments", () => {
  const formHelp = [
    "Up/Down fields",
    "Left/Right toggle keyless",
    "Enter next/save",
    "Esc cancel",
  ];

  test("keeps a short help line as a single row", () => {
    expect(wrapHelpSegments(formHelp, 80)).toEqual([
      "Up/Down fields · Left/Right toggle keyless · Enter next/save · Esc cancel",
    ]);
  });

  test("splits help into multiple rows at ~40 columns", () => {
    const lines = wrapHelpSegments(formHelp, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(lines.join(" · ")).toContain("Up/Down fields");
    expect(lines.join(" · ")).toContain("Esc cancel");
  });

  test("fits each segment at ~40–60 columns used by split panes", () => {
    for (const width of [40, 48, 56, 60]) {
      const lines = wrapHelpSegments(formHelp, width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(Math.max(8, width));
      }
    }
  });
});

describe("formContentWidth", () => {
  test("accounts for margin and padding chrome", () => {
    // wide: margin 2 + padding 4 = 6
    expect(formContentWidth(80, false)).toBe(74);
    // narrow: margin 2 + padding 2 = 4
    expect(formContentWidth(40, true)).toBe(36);
  });

  test("never drops below a usable minimum", () => {
    expect(formContentWidth(8, true)).toBe(12);
  });
});

describe("STACK_FORM_COLUMNS", () => {
  test("threshold sits inside the 40–60 column manual-check band", () => {
    expect(STACK_FORM_COLUMNS).toBeGreaterThanOrEqual(40);
    expect(STACK_FORM_COLUMNS).toBeLessThanOrEqual(60);
  });
});
