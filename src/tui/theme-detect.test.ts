/**
 * Theme detection contract: pin beats terminal sniff beats OS appearance
 * beats the dark default; the COLORFGBG table and the OS probe map their
 * edges the documented way. Everything here feeds injected inputs — no
 * `process.env`, no `process.platform`, no spawned commands — so the matrix
 * stays deterministic. Values asserted are resolved palette names and
 * precedence outcomes, never internals.
 */

import { describe, expect, test } from "bun:test";

import {
  detectOsAppearance,
  resolveDetectedTheme,
  sniffSyncTheme,
} from "./theme-detect.js";

describe("detection precedence pin > COLORFGBG > OS > dark", () => {
  test("an explicit pin wins over every signal below it", () => {
    expect(
      resolveDetectedTheme({
        setting: "dark",
        syncEnv: { COLORFGBG: "15;15" },
        os: "corbits-light",
      }),
    ).toBe("corbits-dark");
    expect(
      resolveDetectedTheme({
        setting: "light",
        syncEnv: { COLORFGBG: "15;0" },
        os: "corbits-dark",
      }),
    ).toBe("corbits-light");
  });

  test("the terminal sniff wins over OS appearance", () => {
    expect(
      resolveDetectedTheme({
        setting: "auto",
        syncEnv: { COLORFGBG: "15;15" },
        os: "corbits-dark",
      }),
    ).toBe("corbits-light");
    expect(
      resolveDetectedTheme({
        setting: "auto",
        syncEnv: { COLORFGBG: "15;0" },
        os: "corbits-light",
      }),
    ).toBe("corbits-dark");
  });

  test("OS appearance decides when the pin is auto and the sniff abstains", () => {
    expect(
      resolveDetectedTheme({
        setting: "auto",
        syncEnv: {},
        os: "corbits-light",
      }),
    ).toBe("corbits-light");
  });

  test("silence everywhere falls back to dark", () => {
    expect(
      resolveDetectedTheme({ setting: "auto", syncEnv: {}, os: null }),
    ).toBe("corbits-dark");
  });
});

describe("COLORFGBG edge table", () => {
  test.each([
    ["dark ground 0", "15;0", "corbits-dark"],
    ["light ground 7", "15;7", "corbits-light"],
    ["dark ground 8", "15;8", "corbits-dark"],
    ["bright ground 9", "15;9", "corbits-light"],
    ["bright ground 15", "0;15", "corbits-light"],
    ["xterm cursor field still reads the middle bg", "0;15;0", "corbits-light"],
    ["whitespace around the bg still parses", "15; 7 ", "corbits-light"],
    ["default bg abstains, never guesses", "15;default", null],
    ["out-of-table bg abstains", "15;16", null],
    ["non-numeric bg abstains", "15;red", null],
    ["missing fg;bg separator abstains", "15", null],
    ["empty value abstains", "", null],
  ] as const)("%s", (_label, colorfgbg, expected) => {
    expect(sniffSyncTheme({ COLORFGBG: colorfgbg })).toBe(expected);
  });

  test("a missing COLORFGBG abstains", () => {
    expect(sniffSyncTheme({})).toBe(null);
  });

  test("TERM_PROGRAM alone never decides", () => {
    expect(sniffSyncTheme({ TERM_PROGRAM: "iTerm.app" })).toBe(null);
    expect(
      sniffSyncTheme({ TERM_PROGRAM: "iTerm.app", COLORFGBG: "15;0" }),
    ).toBe("corbits-dark");
  });
});

describe("OS appearance probe", () => {
  const runner = (out: string | null | undefined) => () => out;

  test("a missing macOS key means the Light default", () => {
    expect(detectOsAppearance("darwin", runner(null))).toBe("corbits-light");
  });

  test("Dark means dark, anything else means light", () => {
    expect(detectOsAppearance("darwin", runner("Dark\n"))).toBe("corbits-dark");
    expect(detectOsAppearance("darwin", runner("dark"))).toBe("corbits-dark");
    expect(detectOsAppearance("darwin", runner(""))).toBe("corbits-light");
  });

  test("a failed lookup abstains instead of guessing", () => {
    expect(detectOsAppearance("darwin", runner(undefined))).toBe(null);
    expect(
      detectOsAppearance("darwin", () => {
        throw new Error("defaults unavailable");
      }),
    ).toBe(null);
  });

  test("non-Darwin platforms abstain without probing", () => {
    for (const platform of ["linux", "win32", "freebsd"]) {
      let probed = false;
      expect(
        detectOsAppearance(platform, () => {
          probed = true;
          return "Dark";
        }),
      ).toBe(null);
      expect(probed).toBe(false);
    }
  });
});
