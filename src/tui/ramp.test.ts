import { describe, expect, test } from "bun:test";

import {
  RAMP_CYCLE_MS,
  RAMP_WIDTH,
  rampFor,
  rampLine,
  rampAnimating,
  rampPulse,
  renderIndeterminateRamp,
  renderRamp,
  STALL_BLINK_BURST_MS,
  STALL_BLINK_CYCLE_MS,
} from "./ramp";
import { UI } from "./theme";

const BRAILLE = /[⠀-⣿]/;

describe("renderRamp", () => {
  test("is always the requested width", () => {
    for (const p of [0, 0.13, 0.5, 0.77, 1]) {
      expect(renderRamp(p).length).toBe(RAMP_WIDTH);
    }
  });

  test("empty at zero", () => {
    expect(renderRamp(0)).not.toContain("█");
  });

  test("fills monotonically toward the leading edge", () => {
    const filled = (s: string) => (s.match(/█/g) ?? []).length;
    expect(filled(renderRamp(0.9))).toBeGreaterThan(filled(renderRamp(0.2)));
  });

  test("a complete ramp is solid", () => {
    expect(new Set(renderRamp(1)).size).toBe(1);
  });

  test("clamps out-of-range and non-finite progress", () => {
    expect(renderRamp(5)).toBe(renderRamp(1));
    expect(renderRamp(-1)).toBe(renderRamp(0));
    expect(renderRamp(Number.NaN)).toBe(renderRamp(0));
  });

  test("honors a custom width", () => {
    expect(renderRamp(1, 4)).toHaveLength(4);
    expect(renderRamp(0.5, 0)).toBe("");
  });
});

describe("renderIndeterminateRamp", () => {
  test("is always the requested width", () => {
    for (let t = 0; t < RAMP_CYCLE_MS; t += 97) {
      expect(renderIndeterminateRamp(t).length).toBe(RAMP_WIDTH);
    }
  });

  test("the comet travels left to right", () => {
    const early = renderIndeterminateRamp(0);
    const later = renderIndeterminateRamp(RAMP_CYCLE_MS / 2);
    expect(early.indexOf("█")).toBeLessThan(later.indexOf("█"));
  });

  test("wraps on the cycle", () => {
    expect(renderIndeterminateRamp(RAMP_CYCLE_MS + 40)).toBe(
      renderIndeterminateRamp(40),
    );
  });

  test("never fakes a completed ramp", () => {
    for (let t = 0; t < RAMP_CYCLE_MS; t += 13) {
      expect(renderIndeterminateRamp(t)).not.toBe(renderRamp(1));
    }
  });
});

describe("rampFor", () => {
  test("working animates in the in-flight bronze", () => {
    const ramp = rampFor({ phase: "working", nowMs: 0 });
    expect(ramp.fg).toBe(UI.inFlight);
    expect(ramp.animating).toBe(true);
  });

  test("working advances with the clock", () => {
    const a = rampFor({ phase: "working", nowMs: 0 });
    const b = rampFor({ phase: "working", nowMs: RAMP_CYCLE_MS / 2 });
    expect(a.cells).not.toBe(b.cells);
  });

  test("working with known progress fills rather than travels", () => {
    expect(rampFor({ phase: "working", nowMs: 0, progress: 0.7 }).cells).toBe(
      renderRamp(0.7),
    );
  });

  test("done is solid and stops animating", () => {
    const ramp = rampFor({ phase: "done", nowMs: 12_345 });
    expect(ramp.cells).toBe(renderRamp(1));
    expect(ramp.fg).toBe(UI.done);
    expect(ramp.animating).toBe(false);
  });

  test("done ignores the clock", () => {
    expect(rampFor({ phase: "done", nowMs: 0 }).cells).toBe(
      rampFor({ phase: "done", nowMs: 99_999 }).cells,
    );
  });

  test("blocked freezes mid-fill", () => {
    const ramp = rampFor({ phase: "blocked", nowMs: 0 });
    expect(ramp.fg).toBe(UI.action);
    expect(ramp.animating).toBe(false);
    // Mid-fill: neither the empty nor the solid ramp.
    expect(ramp.cells).not.toBe(renderRamp(0));
    expect(ramp.cells).not.toBe(renderRamp(1));
  });

  test("blocked ignores the clock", () => {
    expect(rampFor({ phase: "blocked", nowMs: 500 }).cells).toBe(
      rampFor({ phase: "blocked", nowMs: 900_000 }).cells,
    );
  });

  test("no phase emits a braille spinner glyph", () => {
    for (const phase of ["working", "done", "blocked"] as const) {
      expect(rampFor({ phase, nowMs: 400 }).cells).not.toMatch(BRAILLE);
    }
  });
});

describe("rampPulse", () => {
  test("working cycles the density glyphs, so the cell visibly moves", () => {
    const seen = new Set(
      [0, 300, 600, 900].map((nowMs) =>
        rampPulse({ phase: "working", nowMs, stalledForMs: null }),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
    for (const glyph of seen) expect(glyph).toHaveLength(1);
  });

  test("blocked is one static glyph that working never paints", () => {
    const blocked = rampPulse({
      phase: "blocked",
      nowMs: 0,
      stalledForMs: null,
    });
    expect(
      rampPulse({ phase: "blocked", nowMs: 77_000, stalledForMs: null }),
    ).toBe(blocked);
    const workingGlyphs = new Set(
      [0, 300, 600, 900].map((nowMs) =>
        rampPulse({ phase: "working", nowMs, stalledForMs: null }),
      ),
    );
    expect(workingGlyphs.has(blocked)).toBe(false);
  });

  test("stalled alternates its cell while the burst runs", () => {
    const on = rampPulse({ phase: "stalled", nowMs: 0, stalledForMs: 0 });
    const off = rampPulse({
      phase: "stalled",
      nowMs: STALL_BLINK_CYCLE_MS / 2,
      stalledForMs: 0,
    });
    expect(on).not.toBe(off);
  });

  test("stalled settles to one static cell once the burst is spent", () => {
    const settled = rampPulse({
      phase: "stalled",
      nowMs: 0,
      stalledForMs: STALL_BLINK_BURST_MS,
    });
    for (const nowMs of [STALL_BLINK_CYCLE_MS / 2, 9_999]) {
      expect(
        rampPulse({
          phase: "stalled",
          nowMs,
          stalledForMs: STALL_BLINK_BURST_MS,
        }),
      ).toBe(settled);
    }
  });

  test("every glyph is a spinner-free single cell", () => {
    for (const phase of ["working", "done", "blocked", "stalled"] as const) {
      const glyph = rampPulse({ phase, nowMs: 400, stalledForMs: 0 });
      expect(glyph).not.toMatch(BRAILLE);
      expect(glyph).toHaveLength(1);
    }
  });
});

describe("rampAnimating", () => {
  test("terminal and waiting states cost no frames", () => {
    expect(rampAnimating("done", null)).toBe(false);
    expect(rampAnimating("blocked", null)).toBe(false);
    expect(rampAnimating("working", null)).toBe(true);
  });

  test("a stall stops asking for frames once its burst has spent itself", () => {
    expect(rampAnimating("stalled", 0)).toBe(true);
    expect(rampAnimating("stalled", STALL_BLINK_BURST_MS - 1)).toBe(true);
    expect(rampAnimating("stalled", STALL_BLINK_BURST_MS)).toBe(false);
    // A resumed session inherits an already-old stall and never bursts.
    expect(rampAnimating("stalled", STALL_BLINK_BURST_MS * 100)).toBe(false);
  });
});

describe("rampLine", () => {
  test("composes ramp, lowercase label and elapsed seconds", () => {
    const ramp = rampFor({ phase: "working", nowMs: 0, progress: 0.7 });
    const line = rampLine(ramp, "working", 14_400);
    expect(line).toContain(ramp.cells);
    expect(line).toContain("working");
    expect(line).toContain("14");
  });

  test("omits elapsed when unknown", () => {
    const ramp = rampFor({ phase: "done", nowMs: 0 });
    const line = rampLine(ramp, "done");
    expect(line).toContain(ramp.cells);
    expect(line).toContain("done");
    expect(line).not.toMatch(/\d/);
  });
});
