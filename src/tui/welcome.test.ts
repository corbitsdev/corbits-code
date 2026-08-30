import { describe, expect, test } from "bun:test";

import { PRODUCT_NAME } from "../branding.js";
import { MARK_PERIOD_SECONDS, markFrame, markText, renderMark } from "./mark-anim.js";
import { MARK_LARGE, MARK_MID, MARK_SMALL } from "./mark-shape.js";
import { createHarness } from "./harness.js";
import { stringWidth } from "./view/height.js";
import {
  resolveWelcomeLine,
  resolveWelcomeMarkGrid,
  runWelcome,
  WELCOME_AUTO_ADVANCE_MS,
  WELCOME_LINE,
  welcomeMarkStill,
} from "./welcome.js";

describe("WELCOME_LINE", () => {
  test("names the product as the local software factory", () => {
    expect(WELCOME_LINE).toBe(`${PRODUCT_NAME}, your local software factory`);
    expect(WELCOME_LINE).toContain("Corbits Code, your local software factory");
  });
});

describe("resolveWelcomeMarkGrid", () => {
  test("picks the largest mark that fits the terminal", () => {
    expect(resolveWelcomeMarkGrid(24, 80)).toBe(MARK_LARGE);
    expect(resolveWelcomeMarkGrid(14, 80)).toBe(MARK_MID);
    expect(resolveWelcomeMarkGrid(10, 40)).toBe(MARK_SMALL);
    expect(resolveWelcomeMarkGrid(4, 80)).toBeNull();
  });
});

describe("runWelcome", () => {
  test("paints the product line and continues on keypress", async () => {
    const harness = await createHarness({ width: 80, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 60_000,
      now: () => 2_000,
    });
    try {
      await harness.renderOnce();
      await harness.renderOnce();
      expect(harness.captureCharFrame()).toContain(WELCOME_LINE);

      harness.pressKey("Enter");
      await expect(done).resolves.toBe(true);
    } finally {
      // If the assertion failed before Enter, cancel so timers cannot leak.
      harness.pressKey("Ctrl+C");
      await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
      harness.destroy();
    }
  });

  test("cancels on Ctrl+C without continuing", async () => {
    const harness = await createHarness({ width: 80, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 60_000,
      now: () => 2_000,
    });
    try {
      await harness.renderOnce();
      harness.pressKey("Ctrl+C");
      await expect(done).resolves.toBe(false);
    } finally {
      harness.destroy();
    }
  });

  test("auto-advances when the timer fires", async () => {
    const harness = await createHarness({ width: 80, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 20,
      now: () => 2_000,
    });
    try {
      await expect(done).resolves.toBe(true);
    } finally {
      harness.destroy();
    }
  });
});

describe("welcomeMarkStill", () => {
  test("animates through fill, then freezes the full frame", () => {
    const fillMs = 0.76 * MARK_PERIOD_SECONDS * 1000;
    expect(welcomeMarkStill(fillMs - 1)).toBe(false);
    expect(welcomeMarkStill(fillMs)).toBe(true);
    expect(welcomeMarkStill(0.95 * MARK_PERIOD_SECONDS * 1000)).toBe(true);
    expect(welcomeMarkStill(MARK_PERIOD_SECONDS * 1000 + 900)).toBe(true);
  });
});

describe("WELCOME_AUTO_ADVANCE_MS", () => {
  test("lands on the held filled frame, not fade-out or a second draw-in", () => {
    const seconds = WELCOME_AUTO_ADVANCE_MS / 1000;
    expect(seconds).toBeGreaterThanOrEqual(0.76 * MARK_PERIOD_SECONDS);
    expect(seconds).toBeLessThan(MARK_PERIOD_SECONDS);

    const still = welcomeMarkStill(WELCOME_AUTO_ADVANCE_MS);
    const frame = markFrame(seconds, still);
    expect(still).toBe(true);
    expect(frame).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 });

    // Looping math at this delay must also still be the full hold — never the
    // fade (90–100%) or the wrapped second draw-in.
    const looping = markFrame(seconds, false);
    expect(looping.alpha).toBe(1);
    expect(looping.fillProg).toBe(1);
    expect(looping.drawProg).toBe(1);
    expect(seconds).toBeLessThan(0.9 * MARK_PERIOD_SECONDS + 1e-9);
  });
});

describe("resolveWelcomeLine", () => {
  test("keeps the full factory sentence or hides it, never a mid-word slice", () => {
    expect(resolveWelcomeLine(80)).toBe(WELCOME_LINE);
    expect(resolveWelcomeLine(stringWidth(WELCOME_LINE))).toBe(WELCOME_LINE);

    const truncated = WELCOME_LINE.slice(0, 39);
    expect(truncated).toContain("facto");
    expect(truncated).not.toBe(WELCOME_LINE);

    const narrow = resolveWelcomeLine(40);
    expect(narrow === "" || narrow === WELCOME_LINE).toBe(true);
    expect(narrow).not.toBe(truncated);
    expect(narrow.includes("facto") && !narrow.includes("factory")).toBe(false);
  });
});

describe("runWelcome hold and cancel", () => {
  test("paints a still full mark after fill instead of fading", async () => {
    const fadeMs = 0.95 * MARK_PERIOD_SECONDS * 1000;
    // First `now()` is mount (`startedAt`); later samples are elapsed fadeMs.
    let samples = 0;
    const harness = await createHarness({ width: 80, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 60_000,
      now: () => (samples++ === 0 ? 0 : fadeMs),
    });
    try {
      await harness.renderOnce();
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      const held = markText(renderMark({ nowMs: fadeMs, still: true, grid: MARK_LARGE }));
      const fading = markText(renderMark({ nowMs: fadeMs, still: false, grid: MARK_LARGE }));
      const mountain = (text: string) => (text.match(/[▁▂▃▄▅▆▇█]/g) ?? []).length;
      expect(mountain(frame)).toBe(mountain(held));
      expect(mountain(held)).toBeGreaterThan(mountain(fading));
    } finally {
      harness.pressKey("Ctrl+C");
      await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
      harness.destroy();
    }
  });

  test("cancels on Ctrl+D without continuing", async () => {
    const harness = await createHarness({ width: 80, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 60_000,
      now: () => 2_000,
    });
    try {
      await harness.renderOnce();
      harness.pressKey("d", { ctrl: true });
      await expect(done).resolves.toBe(false);
    } finally {
      harness.destroy();
    }
  });

  test("narrow terminals do not paint a sliced factory sentence", async () => {
    const harness = await createHarness({ width: 42, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 60_000,
      now: () => 2_000,
    });
    try {
      await harness.renderOnce();
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      expect(frame).not.toContain("software facto");
      expect(frame.includes("facto") && !frame.includes("factory")).toBe(false);
    } finally {
      harness.pressKey("Ctrl+C");
      await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
      harness.destroy();
    }
  });
});
