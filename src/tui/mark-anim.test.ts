import { describe, expect, test } from "bun:test";

import {
  MARK_PERIOD_SECONDS,
  SNOW_CHAR,
  markFrame,
  markText,
  renderMark,
  smooth,
} from "./mark-anim";
import { MARK_COLS, MARK_LARGE, MARK_ROWS, MARK_SMALL } from "./mark-shape";
import { UI } from "./theme";

const MOUNTAIN_CHARS = "▁▂▃▄▅▆▇█";

const isMountain = (char: string): boolean => MOUNTAIN_CHARS.includes(char);
const isSnow = (char: string): boolean => char === SNOW_CHAR;
const stripSnow = (text: string) => text.replaceAll(SNOW_CHAR, " ");
const SNOW_SAMPLE_CLOCKS_MS = [0, 1500, 3000, 4500, 6000, 7500] as const;

describe("smooth", () => {
  test("clamps outside [0, 1] and eases inside it", () => {
    expect(smooth(-3)).toBe(0);
    expect(smooth(0)).toBe(0);
    expect(smooth(0.5)).toBe(0.5);
    expect(smooth(1)).toBe(1);
    expect(smooth(9)).toBe(1);
    // Eased, not linear: the first quarter moves less than a quarter.
    expect(smooth(0.25)).toBeLessThan(0.25);
  });
});

describe("markFrame", () => {
  test("draws in, holds, fills bottom-up, holds, then fades", () => {
    const at = (phase: number) => markFrame(phase * MARK_PERIOD_SECONDS, false);

    expect(at(0)).toEqual({ drawProg: 0, fillProg: 0, alpha: 1 });
    expect(at(0.19).drawProg).toBeCloseTo(0.5, 6);
    expect(at(0.37).fillProg).toBe(0);

    // Hold: outline complete, nothing filled.
    expect(at(0.38)).toEqual({ drawProg: 1, fillProg: 0, alpha: 1 });
    expect(at(0.47)).toEqual({ drawProg: 1, fillProg: 0, alpha: 1 });

    // Fill.
    expect(at(0.48).fillProg).toBeCloseTo(0, 6);
    expect(at(0.62).fillProg).toBeCloseTo(0.5, 6);
    expect(at(0.75).fillProg).toBeGreaterThan(0.99);

    // Hold full.
    expect(at(0.76)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 });
    expect(at(0.89)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 });

    // Fade out.
    expect(at(0.9).alpha).toBe(1);
    expect(at(0.95).alpha).toBeCloseTo(0.5, 6);
    expect(at(0.999).alpha).toBeLessThan(0.01);
  });

  test("loops on the period and handles a negative clock", () => {
    expect(markFrame(1.2, false)).toEqual(markFrame(1.2 + MARK_PERIOD_SECONDS, false));
    expect(markFrame(-0.1, false).alpha).toBeLessThan(1);
  });

  test("still is a fully drawn, fully filled mark at any time", () => {
    for (const t of [0, 1.7, 4.59, 12345.678]) {
      expect(markFrame(t, true)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 });
    }
  });
});

describe("renderMark", () => {
  /** Mountain-block weight only — snow must not pollute silhouette metrics. */
  const mountainWeight = (grid: readonly (readonly { char: string }[])[]): number =>
    grid.flat().reduce((sum, cell) => sum + Math.max(0, MOUNTAIN_CHARS.indexOf(cell.char) + 1), 0);

  const mountainCells = (grid: readonly (readonly { char: string }[])[]): number =>
    grid.flat().filter((cell) => isMountain(cell.char)).length;

  test("is the mark's cell dimensions", () => {
    const grid = renderMark({ nowMs: 0, still: true });
    expect(grid).toHaveLength(MARK_ROWS);
    for (const row of grid) expect(row).toHaveLength(MARK_COLS);
  });

  test("sky is empty or snow; mountain cells never hold snow", () => {
    const grid = renderMark({ nowMs: 2000, still: false, grid: MARK_LARGE });
    grid.forEach((row, y) => {
      row.forEach((cell, x) => {
        const coverage = MARK_LARGE.coverage[y]?.[x] ?? 0;
        if (coverage === 0) {
          expect(cell.char === " " || isSnow(cell.char)).toBe(true);
          if (isSnow(cell.char)) expect(cell.fg).toBe(UI.textFaint);
        } else if (isMountain(cell.char)) {
          expect(cell.fg).toBe(UI.action);
          expect(isSnow(cell.char)).toBe(false);
        }
      });
    });
  });

  test("the silhouette is solid, with blocks only at partial coverage", () => {
    const grid = renderMark({ nowMs: 0, still: true, grid: MARK_LARGE });
    grid.forEach((row, y) => {
      row.forEach((cell, x) => {
        // Still mode freezes the mountain, but snow still drifts over the sky.
        expect(` ${MOUNTAIN_CHARS}${SNOW_CHAR}`).toContain(cell.char);
        if ((MARK_LARGE.coverage[y]?.[x] ?? 0) === 1) expect(cell.char).toBe("█");
      });
    });
  });

  test("still holds the mountain fixed while the clock advances", () => {
    // Snow moves with the clock even in still mode (the idle landing screen),
    // so isolate the mountain by stripping snow before comparing.
    const a = stripSnow(markText(renderMark({ nowMs: 0, still: true })));
    const b = stripSnow(markText(renderMark({ nowMs: 987_654, still: true })));
    expect(b).toBe(a);
    expect(a.replace(/[\s\n]/g, "").length).toBeGreaterThan(0);
  });

  test("snow keeps drifting in still mode while the mountain stays frozen", () => {
    const snowSets = SNOW_SAMPLE_CLOCKS_MS.map((nowMs) => {
      const grid = renderMark({ nowMs, still: true, grid: MARK_LARGE });
      const snow: string[] = [];
      grid.forEach((row, y) => {
        row.forEach((cell, x) => {
          if (isSnow(cell.char)) snow.push(`${y},${x}`);
        });
      });
      return snow.join("|");
    });
    const withSnow = snowSets.filter((s) => s.length > 0);
    expect(withSnow.length).toBeGreaterThan(1);
    expect(new Set(withSnow).size).toBeGreaterThan(1);
  });

  test("reducedMotion drops snow at a clock that otherwise snows, without reshaping the mountain", () => {
    const nowMs = SNOW_SAMPLE_CLOCKS_MS.find((t) =>
      renderMark({ nowMs: t, still: true, reducedMotion: false, grid: MARK_LARGE })
        .flat()
        .some((cell) => isSnow(cell.char)),
    );
    if (nowMs === undefined) {
      throw new Error("expected a still-mode clock that draws snow");
    }

    const snowing = renderMark({ nowMs, still: true, reducedMotion: false, grid: MARK_LARGE });
    const quiet = renderMark({ nowMs, still: true, reducedMotion: true, grid: MARK_LARGE });
    expect(snowing.flat().some((cell) => isSnow(cell.char))).toBe(true);
    expect(quiet.flat().some((cell) => isSnow(cell.char))).toBe(false);
    expect(stripSnow(markText(quiet))).toBe(stripSnow(markText(snowing)));
  });

  test("reducedMotion drops snow at a hold-full clock without reshaping the mountain", () => {
    const holdFullClocks = [0.76, 0.8, 0.85, 0.89].map(
      (phase) => phase * MARK_PERIOD_SECONDS * 1000,
    );
    const nowMs = holdFullClocks.find((t) =>
      renderMark({ nowMs: t, still: false, reducedMotion: false, grid: MARK_LARGE })
        .flat()
        .some((cell) => isSnow(cell.char)),
    );
    if (nowMs === undefined) {
      throw new Error("expected a hold-full clock that draws snow");
    }

    const snowing = renderMark({ nowMs, still: false, reducedMotion: false, grid: MARK_LARGE });
    const quiet = renderMark({ nowMs, still: false, reducedMotion: true, grid: MARK_LARGE });
    expect(snowing.flat().some((cell) => isSnow(cell.char))).toBe(true);
    expect(quiet.flat().some((cell) => isSnow(cell.char))).toBe(false);
    expect(stripSnow(markText(quiet))).toBe(stripSnow(markText(snowing)));
  });

  test("the animated frame advances with the injected clock", () => {
    const frames = [0, 400, 900, 1500, 2400, 3200].map((nowMs) =>
      markText(renderMark({ nowMs, still: false })),
    );
    expect(new Set(frames).size).toBeGreaterThan(1);
  });

  test("the outline reveals left to right", () => {
    // Early in the draw phase only the leftmost mountain columns may be lit.
    const grid = renderMark({ nowMs: 0.06 * MARK_PERIOD_SECONDS * 1000, still: false });
    const lit = grid.flatMap((row) =>
      row.flatMap((cell, col) => (isMountain(cell.char) ? [col] : [])),
    );
    expect(Math.max(...lit, -1)).toBeLessThan(MARK_COLS);
    const full = renderMark({ nowMs: 0.4 * MARK_PERIOD_SECONDS * 1000, still: false });
    expect(mountainCells(full)).toBeGreaterThan(mountainCells(grid));
  });

  test("the fade thins the mark out toward empty", () => {
    const held = renderMark({ nowMs: 0.8 * MARK_PERIOD_SECONDS * 1000, still: false });
    const fading = renderMark({
      nowMs: 0.995 * MARK_PERIOD_SECONDS * 1000,
      still: false,
    });
    expect(mountainCells(held)).toBeGreaterThan(mountainCells(fading));
  });

  test("filling makes the mark denser than its outline alone", () => {
    const outlineOnly = renderMark({
      nowMs: 0.42 * MARK_PERIOD_SECONDS * 1000,
      still: false,
    });
    const filled = renderMark({
      nowMs: 0.8 * MARK_PERIOD_SECONDS * 1000,
      still: false,
    });
    expect(mountainWeight(filled)).toBeGreaterThan(mountainWeight(outlineOnly));
  });

  test("snow drifts over time without overwriting the silhouette", () => {
    // Sample across several seconds so flakes advance even at a slow fall rate.
    const snowSets = SNOW_SAMPLE_CLOCKS_MS.map((nowMs) => {
      const grid = renderMark({ nowMs, still: false, grid: MARK_LARGE });
      const snow: string[] = [];
      grid.forEach((row, y) => {
        row.forEach((cell, x) => {
          if (isSnow(cell.char)) {
            snow.push(`${y},${x}`);
            // Flakes live only in sky cells — never on mountain coverage.
            expect(MARK_LARGE.coverage[y]?.[x] ?? 0).toBe(0);
          }
        });
      });
      return snow.join("|");
    });

    const withSnow = snowSets.filter((s) => s.length > 0);
    expect(withSnow.length).toBeGreaterThan(1);
    expect(new Set(withSnow).size).toBeGreaterThan(1);

    // During the full-hold phase the ridgeline dominates the flake field.
    const held = renderMark({
      nowMs: 0.82 * MARK_PERIOD_SECONDS * 1000,
      still: false,
      grid: MARK_LARGE,
    });
    let flakes = 0;
    let mountains = 0;
    held.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (isSnow(cell.char)) {
          flakes += 1;
          expect(MARK_LARGE.coverage[y]?.[x] ?? 0).toBe(0);
        }
        if (isMountain(cell.char)) mountains += 1;
      });
    });
    expect(mountains).toBeGreaterThan(20);
    expect(mountains).toBeGreaterThan(flakes);
  });

  test("still mode freezes the mountain but not the snow", () => {
    const a = renderMark({ nowMs: 0, still: true, grid: MARK_SMALL });
    const b = renderMark({ nowMs: 50_000, still: true, grid: MARK_SMALL });
    const mountainText = (grid: typeof a) =>
      grid
        .map((row) => row.map((cell) => (isMountain(cell.char) ? cell.char : " ")).join(""))
        .join("\n");
    expect(mountainText(b)).toBe(mountainText(a));
  });

  test("snow drops out during the fade-out phase, matching the mark", () => {
    const fading = renderMark({
      nowMs: 0.995 * MARK_PERIOD_SECONDS * 1000,
      still: false,
      grid: MARK_LARGE,
    });
    expect(fading.flat().some((cell) => isSnow(cell.char))).toBe(false);
  });
});
