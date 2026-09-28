import { describe, expect, test } from "bun:test";

import {
  detectOsAppearance,
  resolveDetectedTheme,
  resolveThemeSetting,
  settingTheme,
  sniffSyncTheme,
  syncEnvFromRecord,
  type ThemeResolution,
} from "./theme-detect";

const SYNC_UNKNOWN = { syncEnv: {}, os: null } as const;

function resolution(over: Partial<ThemeResolution>): ThemeResolution {
  return {
    setting: "auto",
    syncEnv: {},
    os: null,
    ...over,
  };
}

describe("resolveThemeSetting", () => {
  test("accepts auto, light, and dark", () => {
    expect(resolveThemeSetting("auto")).toBe("auto");
    expect(resolveThemeSetting("light")).toBe("light");
    expect(resolveThemeSetting("dark")).toBe("dark");
  });

  test("unknown values fall back to auto", () => {
    for (const raw of [undefined, null, "", "blue", 1, {}, []]) {
      expect(resolveThemeSetting(raw)).toBe("auto");
    }
  });
});

describe("sniffSyncTheme", () => {
  test("dark COLORFGBG backgrounds resolve dark", () => {
    expect(sniffSyncTheme({ COLORFGBG: "15;0" })).toBe("corbits-dark");
    expect(sniffSyncTheme({ COLORFGBG: "0;default;15" })).toBeNull();
    expect(sniffSyncTheme({ COLORFGBG: "7;8" })).toBe("corbits-dark");
  });

  test("light COLORFGBG backgrounds resolve light", () => {
    expect(sniffSyncTheme({ COLORFGBG: "0;15" })).toBe("corbits-light");
    expect(sniffSyncTheme({ COLORFGBG: "0;7" })).toBe("corbits-light");
  });

  test("default and missing backgrounds abstain", () => {
    expect(sniffSyncTheme({})).toBeNull();
    expect(sniffSyncTheme({ COLORFGBG: "" })).toBeNull();
    expect(sniffSyncTheme({ COLORFGBG: "0;default;15" })).toBeNull();
    expect(sniffSyncTheme({ COLORFGBG: "bogus" })).toBeNull();
  });

  test("TERM_PROGRAM alone never decides", () => {
    expect(sniffSyncTheme({ TERM_PROGRAM: "iTerm.app" })).toBeNull();
    expect(sniffSyncTheme({ TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
  });
});

describe("detectOsAppearance", () => {
  test("macOS Dark reads dark", () => {
    expect(detectOsAppearance("darwin", () => "Dark\n")).toBe("corbits-dark");
  });

  test("macOS without the key means the Light default", () => {
    expect(detectOsAppearance("darwin", () => null)).toBe("corbits-light");
  });

  test("detector failures abstain", () => {
    expect(detectOsAppearance("darwin", () => undefined)).toBeNull();
    expect(
      detectOsAppearance("darwin", () => {
        throw new Error("defaults unavailable");
      }),
    ).toBeNull();
  });

  test("other platforms abstain", () => {
    const fail = (): string | null => {
      throw new Error("must not run");
    };
    expect(detectOsAppearance("linux", fail)).toBeNull();
    expect(detectOsAppearance("win32", fail)).toBeNull();
  });
});

describe("resolveDetectedTheme precedence", () => {
  test("unknown everything stays dark", () => {
    expect(resolveDetectedTheme(resolution({}))).toBe("corbits-dark");
  });

  test("explicit setting beats every signal", () => {
    expect(
      resolveDetectedTheme(
        resolution({
          setting: "light",
          syncEnv: { COLORFGBG: "15;0" },
          os: "corbits-dark",
        }),
      ),
    ).toBe("corbits-light");
    expect(
      resolveDetectedTheme(
        resolution({
          setting: "dark",
          syncEnv: { COLORFGBG: "0;15" },
          os: "corbits-light",
        }),
      ),
    ).toBe("corbits-dark");
  });

  test("sync sniff beats OS appearance", () => {
    expect(
      resolveDetectedTheme(
        resolution({
          syncEnv: { COLORFGBG: "0;15" },
          os: "corbits-dark",
        }),
      ),
    ).toBe("corbits-light");
    expect(
      resolveDetectedTheme(
        resolution({
          syncEnv: { COLORFGBG: "15;0" },
          os: "corbits-light",
        }),
      ),
    ).toBe("corbits-dark");
  });

  test("OS appearance beats the dark fallback", () => {
    expect(resolveDetectedTheme(resolution({ os: "corbits-light" }))).toBe(
      "corbits-light",
    );
    expect(resolveDetectedTheme(resolution({ os: "corbits-dark" }))).toBe(
      "corbits-dark",
    );
  });

  test("setting helper defers on auto", () => {
    expect(settingTheme("auto")).toBeNull();
    expect(settingTheme("light")).toBe("corbits-light");
    expect(settingTheme("dark")).toBe("corbits-dark");
  });

  test("syncEnvFromRecord picks only the two sniffed vars", () => {
    expect(
      syncEnvFromRecord({
        COLORFGBG: "15;0",
        TERM_PROGRAM: "iTerm.app",
        PATH: "/bin",
      }),
    ).toEqual({ COLORFGBG: "15;0", TERM_PROGRAM: "iTerm.app" });
    expect(syncEnvFromRecord({})).toEqual({});
  });

  test("contrast direction: light ground reads light, dark reads dark", () => {
    expect({ ...SYNC_UNKNOWN }).toBeDefined();
    expect(
      resolveDetectedTheme(resolution({ syncEnv: { COLORFGBG: "0;15" } })),
    ).not.toBe(
      resolveDetectedTheme(resolution({ syncEnv: { COLORFGBG: "15;0" } })),
    );
  });
});
