import { describe, test, expect } from "bun:test";
import {
  STACK_FORM_COLUMNS,
  fitTrailingText,
  formContentWidth,
  wrapHelpSegments,
} from "./form-reflow.js";

describe("fitTrailingText (PR #317)", () => {
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

  test("truncation is by JS code unit, not terminal display width", () => {
    const cjk = "日本語テスト文字列";
    const fitted = fitTrailingText(cjk, 5);
    expect(fitted.startsWith("…")).toBe(true);
    expect(fitted.length).toBe(5);
  });
});

describe("wrapHelpSegments (PR #317)", () => {
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

  test("oversized single segment is trailing-truncated not word-wrapped", () => {
    const long = "Left/Right toggle keyless and also something very long";
    const lines = wrapHelpSegments([long], 20);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(20);
    expect(lines[0]!.startsWith("…")).toBe(true);
  });

  test("provider help reflows at formContentWidth(40, true)", () => {
    const segs =
      "Up/Down navigate · Enter models · a add · e edit · x remove · t tiers · p profiles · Esc close".split(
        " · ",
      );
    const width = formContentWidth(40, true);
    const lines = wrapHelpSegments(segs, width);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(Math.max(8, width));
    }
  });

  test("empty segments are skipped", () => {
    expect(wrapHelpSegments(["a", "", "b"], 80)).toEqual(["a · b"]);
  });

  test("empty input yields empty output", () => {
    expect(wrapHelpSegments([], 40)).toEqual([]);
  });
});

describe("formContentWidth (PR #317)", () => {
  test("accounts for margin and padding chrome", () => {
    expect(formContentWidth(80, false)).toBe(74);
    expect(formContentWidth(40, true)).toBe(36);
  });

  test("never drops below a usable minimum", () => {
    expect(formContentWidth(8, true)).toBe(12);
  });

  test("content width is non-monotonic across stack threshold", () => {
    const at55 = formContentWidth(55, true);
    const at56 = formContentWidth(56, false);
    expect(at55).toBe(51);
    expect(at56).toBe(50);
    expect(at55).toBeGreaterThan(at56);
  });
});

describe("STACK_FORM_COLUMNS (PR #317)", () => {
  test("threshold sits inside the 40–60 column manual-check band", () => {
    expect(STACK_FORM_COLUMNS).toBeGreaterThanOrEqual(40);
    expect(STACK_FORM_COLUMNS).toBeLessThanOrEqual(60);
  });
});

describe("agent-modal value budgets", () => {
  const providerLabelWidth = 16;

  function valueWidth(columns: number): number {
    const stackFields = columns < STACK_FORM_COLUMNS;
    const contentWidth = formContentWidth(columns, stackFields);
    return stackFields
      ? contentWidth
      : Math.max(8, contentWidth - Math.max(providerLabelWidth, 14) - 1);
  }

  test("at 40 cols stacked value width equals content width", () => {
    expect(valueWidth(40)).toBe(36);
  });

  test("at 80 cols row layout reserves label column", () => {
    expect(valueWidth(80)).toBe(57);
  });

  test("caret reservation leaves fitted text within budget", () => {
    for (const cols of [40, 48, 56, 60, 80]) {
      const vw = valueWidth(cols);
      const fittedBudget = Math.max(1, vw - 1);
      const sample = fitTrailingText("https://api.example.com/v1/very/long/path", fittedBudget);
      expect(sample.length).toBeLessThanOrEqual(fittedBudget);
    }
  });

  // "Bifrost virtual key" label is 19 chars; fixed providerLabelWidth is 16
  test("longest field label exceeds fixed providerLabelWidth of 16", () => {
    const labels = [
      "Provider name",
      "Base URL",
      "Keyless",
      "API key",
      "Models",
      "Default model",
      "Bifrost virtual key",
    ];
    const longest = Math.max(...labels.map((l) => l.length));
    expect(longest).toBe(19);
    expect(longest).toBeGreaterThan(providerLabelWidth);
  });
});
