import { describe, expect, test } from "bun:test";

import { PRODUCT_NAME } from "../branding.js";
import { MARK_LARGE, MARK_MID, MARK_SMALL } from "./mark-shape.js";
import { createHarness } from "./harness.js";
import { resolveWelcomeMarkGrid, runWelcome, WELCOME_LINE } from "./welcome.js";

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
