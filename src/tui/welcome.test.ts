import { describe, expect, test } from "bun:test";

import { MARK_LARGE, MARK_MID, MARK_SMALL } from "./mark-shape.js";
import { createHarness } from "./harness.js";
import { stringWidth } from "./view/height.js";
import { resolveWelcomeLine, resolveWelcomeMarkGrid, runWelcome, WELCOME_LINE } from "./welcome.js";

describe("resolveWelcomeMarkGrid", () => {
  test("picks the largest mark that fits the terminal", () => {
    expect(resolveWelcomeMarkGrid(24, 80)).toBe(MARK_LARGE);
    expect(resolveWelcomeMarkGrid(14, 80)).toBe(MARK_MID);
    expect(resolveWelcomeMarkGrid(10, 40)).toBe(MARK_SMALL);
    expect(resolveWelcomeMarkGrid(4, 80)).toBeNull();
  });
});

describe("runWelcome", () => {
  test("continues on Enter keypress", async () => {
    const harness = await createHarness({ width: 80, height: 30 });
    const done = runWelcome({
      createRenderer: async () => harness.renderer,
      autoAdvanceMs: 60_000,
      now: () => 2_000,
    });
    try {
      await harness.renderOnce();
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
