/**
 * Every wrap and truncate path in the shell budgets terminal columns, not
 * UTF-16 code units. These tests feed each path the glyphs where the two
 * disagree — CJK (two columns) and the ambiguous-width em dash / arrow /
 * ellipsis / box rule (one column) — and assert on measured columns, so a
 * regression back to `String.length` fails here rather than on screen.
 */

import { describe, expect, test } from "bun:test";

import {
  prefixIndexForWidth,
  sliceTailToWidth,
  sliceToWidth,
  stringWidth,
  AMBIGUOUS_IS_NARROW,
  WIDTH_PROBE,
} from "./view/height.js";
import { middleEllipsis } from "./command-display.js";
import { renderDiff } from "./diff.js";
import { wrapLanding } from "./landing.js";
import { lockupWidth } from "./lockup.js";
import type { RampPhase } from "./ramp.js";
import { formatPaletteRows } from "./command-catalog.js";
import { composeDecisionBody, decisionChoiceRows, wrapWords } from "./overlay-body.js";
import { thinkingLivePreviewLines, thinkingSettledLine } from "./thinking.js";

const CJK = "検索結果を確認する";
const AMBIGUOUS = "│╭—→…┆●▍";

describe("the width contract", () => {
  test("ambiguous glyphs are one column, and stated as such", () => {
    expect(AMBIGUOUS_IS_NARROW).toBe(true);
    expect(stringWidth(AMBIGUOUS)).toBe([...AMBIGUOUS].length);
  });

  test("the probe carries both an ambiguous run and a wide character", () => {
    expect(stringWidth(WIDTH_PROBE)).toBe([...WIDTH_PROBE].length + 1);
  });

  test("CJK counts two columns per glyph", () => {
    expect(stringWidth(CJK)).toBe(CJK.length * 2);
  });
});

describe("column slicing", () => {
  test("never splits a wide glyph across the budget", () => {
    expect(sliceToWidth(CJK, 5)).toBe("検索");
    expect(stringWidth(sliceToWidth(CJK, 5))).toBeLessThanOrEqual(5);
    expect(prefixIndexForWidth(CJK, 5)).toBe(2);
  });

  test("tail slicing is symmetric", () => {
    expect(sliceTailToWidth(CJK, 5)).toBe("する");
    expect(sliceTailToWidth("abc—def", 3)).toBe("def");
  });

  test("surrogate pairs stay whole from both ends", () => {
    const emoji = "a🙂b";
    expect(sliceToWidth(emoji, 2)).toBe("a");
    expect(sliceTailToWidth(emoji, 2)).toBe("b");
  });
});

describe("overlay wrapWords (the permission approval body)", () => {
  test("no wrapped row exceeds the column budget with CJK", () => {
    const rows = wrapWords(`${CJK} ${CJK} ${CJK}`, 20);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(20);
    expect(rows.length).toBeGreaterThan(1);
  });

  test("ambiguous glyphs do not cost the operator a row", () => {
    // Eight one-column glyphs plus a space fits a 12-column line whole; a
    // `.length` budget would agree, but a wide reading would break it in two.
    expect(wrapWords(`${AMBIGUOUS} ok`, 12)).toEqual([`${AMBIGUOUS} ok`]);
  });

  test("a long CJK token is broken on a column boundary, losing nothing", () => {
    const rows = wrapWords(CJK, 8);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(8);
    expect(rows.join("")).toBe(CJK);
  });

  test("a wide path breaks at the separator inside the column budget", () => {
    const rows = wrapWords("/検索/結果/確認/report.txt", 10);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(10);
    expect(rows.join("")).toBe("/検索/結果/確認/report.txt");
  });

  test("a single glyph wider than the budget still makes progress", () => {
    const rows = wrapWords(CJK, 4);
    expect(rows.join("")).toBe(CJK);
    expect(rows.length).toBeLessThanOrEqual([...CJK].length);
  });
});

describe("the decision body", () => {
  test("every row of a wide-character approval fits the frame", () => {
    const body = composeDecisionBody(`run_shell ${CJK}\ngrep — ${CJK} → ${CJK}\n… more`, 36, 8);
    for (const row of body) expect(stringWidth(row.text)).toBeLessThanOrEqual(36);
  });

  test("a choice label wraps by columns, not code units", () => {
    const rows = decisionChoiceRows(`Allow ${CJK} always`, true, 20);
    for (const row of rows) expect(stringWidth(row.text)).toBeLessThanOrEqual(20);
    const joined = rows.map((r) => r.text).join("");
    expect(joined).not.toContain("...");
    expect(joined).not.toContain("…");
  });

  test("a label that fits in columns is not truncated", () => {
    const label = `Accept — ${AMBIGUOUS}`;
    const [row] = decisionChoiceRows(label, false, 40);
    expect(row?.text).toBe(`  ${label}`);
  });
});

describe("middleEllipsis", () => {
  test("returns a string of at most `max` columns", () => {
    const out = middleEllipsis(`${CJK}-${CJK}`, 11);
    expect(stringWidth(out)).toBeLessThanOrEqual(11);
    expect(out).toContain("…");
  });

  test("an ambiguous-glyph label inside budget is left alone", () => {
    const label = `Allow — bash → ${AMBIGUOUS}`;
    expect(middleEllipsis(label, stringWidth(label))).toBe(label);
  });

  test("keeps both ends distinguishable", () => {
    const out = middleEllipsis("prefix—shared—tailA", 12);
    expect(out.startsWith("p")).toBe(true);
    expect(out.endsWith("A")).toBe(true);
  });
});

describe("diff wrapping", () => {
  test("uses the canonical wrapper, so wide code never overflows the gutter", () => {
    const lines = renderDiff("", `const label = "${CJK}${CJK}"\n`, 24, {
      lineNumbers: false,
    });
    for (const line of lines) {
      const width = line.reduce((n, seg) => n + stringWidth(seg.text), 0);
      expect(width).toBeLessThanOrEqual(24);
    }
  });
});

describe("landing wrap", () => {
  test("a CJK notice wraps on columns", () => {
    const rows = wrapLanding(`${CJK} ${CJK}`, 20);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(20);
  });

  test("an ambiguous-glyph line keeps its single row", () => {
    expect(wrapLanding(`usage — data → sent`, 20)).toEqual(["usage — data → sent"]);
  });
});

describe("thinking rows", () => {
  test("each live preview line fits its columns", () => {
    for (const line of thinkingLivePreviewLines(CJK.repeat(4), 8)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(8);
    }
  });

  test("the settled line fits its columns including the ellipsis", () => {
    const line = thinkingSettledLine(`${CJK} — ${CJK}`, 12);
    expect(stringWidth(line)).toBeLessThanOrEqual(12);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("palette rows", () => {
  test("rows are exactly `width` columns wide with CJK labels", () => {
    const rows = formatPaletteRows([CJK, "resume"], 48);
    for (const row of rows) expect(stringWidth(row)).toBe(48);
  });

  test("a too-wide label is cut to columns", () => {
    const [row] = formatPaletteRows([`${CJK}${CJK}`], 12);
    expect(stringWidth(row ?? "")).toBe(12);
  });
});

describe("lockup", () => {
  const slot = (phase: string | null, rampPhase: RampPhase | null) => ({
    nowMs: 0,
    still: phase === null,
    phase,
    changedMs: 0,
    rampPhase,
    stalledForMs: null,
  });

  test("reports painted columns", () => {
    expect(lockupWidth(slot(null, null))).toBe(stringWidth("corbits code"));
    expect(lockupWidth(slot(CJK, null))).toBe(stringWidth(CJK));
  });

  test("a live slot reserves the pulse cell and its space too", () => {
    // Reserved off the cells that get painted, so a wide label cannot make
    // the reservation and the paint disagree by a column.
    expect(lockupWidth(slot(CJK, "working"))).toBe(stringWidth(CJK) + 2);
  });
});
