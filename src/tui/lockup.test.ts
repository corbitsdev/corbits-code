import { describe, expect, test } from "bun:test";

import {
  LOCKUP_FADE_MS,
  lockupCells,
  lockupText,
  lockupWidth,
  type LockupInput,
} from "./lockup";
import {
  STALL_BLINK_BURST_MS,
  STALL_BLINK_CYCLE_MS,
  type RampPhase,
} from "./ramp";
import { UI } from "./theme";

const idle = (nowMs: number): LockupInput => ({
  nowMs,
  still: true,
  phase: null,
  changedMs: 0,
  rampPhase: null,
  stalledForMs: null,
});

const live = (
  nowMs: number,
  phase: string,
  rampPhase: RampPhase,
  stalledForMs: number | null,
): LockupInput => ({
  nowMs,
  still: false,
  phase,
  changedMs: 0,
  rampPhase,
  stalledForMs,
});

const still = (nowMs = 0) => lockupCells(idle(nowMs));

describe("brand lockup", () => {
  test("idle paints a single unadorned word row", () => {
    const cells = still();
    expect(cells).toHaveLength(lockupWidth(idle(0)));
    expect(lockupText(cells).trim().length).toBeGreaterThan(0);
    // The mountain lives on the landing; one row cannot hold a silhouette.
    expect(lockupText(cells)).not.toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  test("idle is genuinely still", () => {
    const a = still(0);
    const b = still(9_000);
    expect(lockupText(b)).toBe(lockupText(a));
    expect(b.map((cell) => cell.fg)).toEqual(a.map((cell) => cell.fg));
  });

  test("a live turn swaps the wordmark for the phase", () => {
    const input: LockupInput = {
      nowMs: 0,
      still: false,
      phase: "thinking",
      changedMs: 0,
      rampPhase: null,
      stalledForMs: null,
    };
    expect(lockupText(lockupCells(input))).toBe("thinking");
    expect(lockupWidth(input)).toBe(lockupCells(input).length);
  });

  test("a state change fades in through the dim tones", () => {
    const at = (elapsed: number) =>
      lockupCells({
        nowMs: elapsed,
        still: false,
        phase: "bash",
        changedMs: 0,
        rampPhase: null,
        stalledForMs: null,
      });
    const tone = (elapsed: number) => at(elapsed)[0]?.fg;
    expect(tone(0)).toBe(UI.textFaint);
    expect(tone(LOCKUP_FADE_MS / 2)).toBe(UI.textDim);
    expect(tone(LOCKUP_FADE_MS)).toBe(UI.text);
    // Every cell rides the one ramp together.
    const last = (elapsed: number) => at(elapsed).at(-1)?.fg;
    expect(last(0)).toBe(UI.textFaint);
    expect(last(LOCKUP_FADE_MS)).toBe(UI.text);
    // The word never changes mid-fade: only the tone moves.
    expect(lockupText(at(0))).toBe(lockupText(at(LOCKUP_FADE_MS)));
  });
});

describe("the live phase slot's pulse cell", () => {
  test("working keeps the word and leads it with a density cell", () => {
    const cells = lockupCells(live(0, "streaming 3 tok", "working", null));
    expect(lockupText(cells)).toMatch(/^[░▒▓█] streaming 3 tok$/);
    for (const cell of cells) expect(cell.fg).toBe(UI.inFlight);
  });

  test("working's cell moves — the slot's glyphs change over a cycle", () => {
    const seen = new Set(
      [0, 300, 600, 900].map((nowMs) =>
        lockupText(lockupCells(live(nowMs, "working", "working", null))),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  test("blocked holds one static cell — stillness is the signal", () => {
    const at = (nowMs: number) =>
      lockupText(lockupCells(live(nowMs, "blocked", "blocked", null)));
    expect(at(STALL_BLINK_CYCLE_MS)).toBe(at(0));
    expect(at(60_000)).toBe(at(0));
  });

  test("working and blocked differ in glyph, not only in colour", () => {
    // Same word and instant, colour stripped: only the cell tells them apart.
    const distinct = new Set(
      [0, 300, 600, 900].map(
        (nowMs) =>
          `${lockupText(lockupCells(live(nowMs, "working", "working", null)))}|${lockupText(
            lockupCells(live(nowMs, "working", "blocked", null)),
          )}`,
      ),
    );
    for (const pair of distinct) {
      const [moving, waiting] = pair.split("|");
      expect(moving).not.toBe(waiting);
    }
  });

  test("stalled visibly alternates its cell while the burst runs", () => {
    const on = lockupText(lockupCells(live(0, "working", "stalled", 0)));
    const off = lockupText(
      lockupCells(live(STALL_BLINK_CYCLE_MS / 2, "working", "stalled", 0)),
    );
    expect(on).not.toBe(off);
    // The word stays put; only the pulse cell blinks.
    expect(on).toContain("working");
    expect(off).toContain("working");
  });

  test("stalled settles to one static cell once the burst has spent itself", () => {
    const past = STALL_BLINK_BURST_MS;
    const at = (nowMs: number) =>
      lockupText(lockupCells(live(nowMs, "working", "stalled", past + nowMs)));
    expect(at(STALL_BLINK_CYCLE_MS / 2)).toBe(at(0));
    expect(at(120_000)).toBe(at(0));
  });

  test("a stall already older than the burst never blinks at all", () => {
    // A resumed session inherits stale activity; bursting would alarm about
    // silence the operator missed.
    const resumed = STALL_BLINK_BURST_MS * 4;
    const at = (nowMs: number) =>
      lockupText(lockupCells(live(nowMs, "working", "stalled", resumed)));
    for (const nowMs of [225, 450, 675]) {
      expect(at(nowMs)).toBe(at(0));
    }
  });

  test("the stalled word stays legible — only the cell blinks", () => {
    for (const nowMs of [0, STALL_BLINK_CYCLE_MS / 2]) {
      expect(
        lockupText(lockupCells(live(nowMs, "bash", "stalled", 0))),
      ).toContain("bash");
    }
  });

  test("working, blocked and stalled all read apart with no colour at all", () => {
    const glyph = (rampPhase: RampPhase, stalledForMs: number | null) =>
      lockupText(lockupCells(live(0, "working", rampPhase, stalledForMs)))[0];
    expect(new Set([glyph("blocked", null), glyph("stalled", 0)]).size).toBe(2);
    // Working sweeps the density glyphs; neither of the other two is one.
    const workingGlyphs = new Set(
      [0, 300, 600, 900].map(
        (nowMs) =>
          lockupText(lockupCells(live(nowMs, "working", "working", null)))[0],
      ),
    );
    expect(workingGlyphs.has(glyph("blocked", null))).toBe(false);
  });

  test("the slot's width never changes across a blink", () => {
    // Wide (CJK) and astral labels: the reservation is measured in columns,
    // whatever the label is made of.
    for (const label of ["読み込み中", "a😀b", "working"]) {
      const on = lockupWidth(live(0, label, "stalled", 0));
      const off = lockupWidth(
        live(STALL_BLINK_CYCLE_MS / 2, label, "stalled", 0),
      );
      expect(off).toBe(on);
    }
  });
});
