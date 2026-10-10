/**
 * Version badge with an off-tag build identity: the long display version must
 * render right-aligned and unclipped at the 60-column floor, and the
 * visibility gate must still hide the whole badge below it.
 *
 * `LANDING_VERSION` is a live re-export of `DISPLAY_VERSION` (see landing.ts),
 * so mocking `version.js` at file scope reaches both `LANDING_VERSION` and the
 * shell's version row even though those modules may already be evaluated with
 * the plain dev fallback by the time this file runs — the value is read at
 * access time, not captured at module-evaluation time.
 */
import { describe, expect, test } from "bun:test";

import { defined } from "../../testkit/defined.js";
import { withMockedModule } from "../../testkit/mock-module.js";

const LONG_DISPLAY_VERSION = "v0.3.36-7-g9af7e1e3";

await withMockedModule(
  import.meta.resolve("../version.js"),
  (real: typeof import("../version.js")) => ({
    ...real,
    DISPLAY_VERSION: LONG_DISPLAY_VERSION,
  }),
);

const { withAppShell } = await import("./test-helpers.js");
const {
  LANDING_VERSION,
  VERSION_BADGE_MIN_COLUMNS,
  VERSION_BADGE_MIN_ROWS,
  versionBadgeVisible,
} = await import("./landing.js");

describe("version badge with an off-tag build identity", () => {
  test("LANDING_VERSION carries the long build identity", () => {
    expect(LANDING_VERSION).toBe(LONG_DISPLAY_VERSION);
  });

  test("the badge renders right-aligned and unclipped at 60 columns", async () => {
    const size = {
      width: VERSION_BADGE_MIN_COLUMNS,
      height: VERSION_BADGE_MIN_ROWS,
    };
    await withAppShell(
      async (_shell, h) => {
        await h.renderOnce();
        await h.renderOnce();
        const frame = h.captureCharFrame();
        expect(frame).toContain(LONG_DISPLAY_VERSION);

        const painted = frame.split("\n");
        const versionRow = painted.findIndex((row) =>
          row.includes(LONG_DISPLAY_VERSION),
        );
        expect(versionRow).toBeGreaterThanOrEqual(0);
        // Unclipped: the badge sits on a real terminal row, not past it.
        expect(versionRow).toBeLessThan(size.height);
        // Right-aligned: the badge's right edge hugs the terminal's right
        // edge (the existing landing assertion uses the same slack).
        const versionCol = defined(painted[versionRow]).lastIndexOf(
          LONG_DISPLAY_VERSION,
        );
        expect(versionCol + LONG_DISPLAY_VERSION.length).toBeGreaterThan(
          size.width - 4,
        );
      },
      { ...size, shell: { run: "idle" } },
    );
  });

  test("versionBadgeVisible still hides the badge below 60 columns", () => {
    expect(
      versionBadgeVisible(
        VERSION_BADGE_MIN_COLUMNS - 1,
        VERSION_BADGE_MIN_ROWS,
      ),
    ).toBe(false);
    expect(
      versionBadgeVisible(VERSION_BADGE_MIN_COLUMNS, VERSION_BADGE_MIN_ROWS),
    ).toBe(true);
    expect(
      versionBadgeVisible(
        VERSION_BADGE_MIN_COLUMNS,
        VERSION_BADGE_MIN_ROWS - 1,
      ),
    ).toBe(false);
  });
});
