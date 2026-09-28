import { afterEach, describe, expect, test } from "bun:test";

import {
  BRAND,
  configureTransparentBackground,
  corbitsDark,
  corbitsLight,
  resetTransparentBackgroundLogForTests,
  resolveGround,
  setTheme,
  TRANSPARENT_BACKGROUND,
  UI,
  type Theme,
  type TransparentBackgroundEnv,
} from "./theme.js";

const SUPPORTED: TransparentBackgroundEnv = {
  CORBITS_TRANSPARENT_BACKGROUND: "1",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "kitty",
};

const NO_TRUECOLOR: TransparentBackgroundEnv = {
  CORBITS_TRANSPARENT_BACKGROUND: "1",
  TERM_PROGRAM: "kitty",
};

const UNKNOWN_TERMINAL: TransparentBackgroundEnv = {
  CORBITS_TRANSPARENT_BACKGROUND: "true",
  COLORTERM: "truecolor",
  TERM: "xterm-256color",
};

afterEach(() => {
  configureTransparentBackground({});
  setTheme("corbits-dark");
  resetTransparentBackgroundLogForTests();
});

describe("resolveGround", () => {
  test("default stays opaque without logging", () => {
    let logged = 0;
    for (const theme of [corbitsDark, corbitsLight]) {
      expect(resolveGround(theme, {}, () => logged++)).toBe(theme.ground);
    }
    expect(logged).toBe(0);
  });

  test("requested and supported resolves transparent for both themes", () => {
    let logged = 0;
    const onFallback = () => logged++;
    expect(resolveGround(corbitsDark, SUPPORTED, onFallback)).toBe(
      TRANSPARENT_BACKGROUND,
    );
    expect(resolveGround(corbitsLight, SUPPORTED, onFallback)).toBe(
      TRANSPARENT_BACKGROUND,
    );
    expect(logged).toBe(0);
  });

  test("truthy env spellings opt in when supported", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      const env = { ...SUPPORTED, CORBITS_TRANSPARENT_BACKGROUND: value };
      expect(resolveGround(corbitsDark, env)).toBe(TRANSPARENT_BACKGROUND);
    }
  });

  test("falsy env spellings stay opaque without logging", () => {
    let logged = 0;
    for (const value of ["0", "false", "off", "", "no"]) {
      const env = { ...SUPPORTED, CORBITS_TRANSPARENT_BACKGROUND: value };
      expect(resolveGround(corbitsDark, env, () => logged++)).toBe(
        corbitsDark.ground,
      );
    }
    expect(logged).toBe(0);
  });

  test("requested without truecolor falls back to opaque with one log line", () => {
    const lines: string[] = [];
    expect(resolveGround(corbitsDark, NO_TRUECOLOR, (m) => lines.push(m))).toBe(
      corbitsDark.ground,
    );
    expect(
      resolveGround(corbitsLight, NO_TRUECOLOR, (m) => lines.push(m)),
    ).toBe(corbitsLight.ground);
    expect(lines).toHaveLength(1);
  });

  test("requested on an unknown terminal falls back to opaque", () => {
    const lines: string[] = [];
    expect(
      resolveGround(corbitsDark, UNKNOWN_TERMINAL, (m) => lines.push(m)),
    ).toBe(corbitsDark.ground);
    expect(lines).toHaveLength(1);
  });

  test("24bit colorterm with a TERM hint counts as supported", () => {
    const env: TransparentBackgroundEnv = {
      CORBITS_TRANSPARENT_BACKGROUND: "on",
      COLORTERM: "24bit",
      TERM: "xterm-ghostty",
    };
    expect(resolveGround(corbitsDark, env)).toBe(TRANSPARENT_BACKGROUND);
  });
});

describe("configureTransparentBackground", () => {
  test("default leaves UI opaque", () => {
    const lines: string[] = [];
    expect(configureTransparentBackground({}, (m) => lines.push(m))).toBe(
      false,
    );
    expect(UI.ground).toBe(corbitsDark.ground);
    expect(lines).toHaveLength(0);
  });

  test("supported request publishes transparent on UI", () => {
    expect(configureTransparentBackground(SUPPORTED)).toBe(true);
    expect(UI.ground).toBe(TRANSPARENT_BACKGROUND);
  });

  test("default restores opaque ground after a transparent configuration", () => {
    expect(configureTransparentBackground(SUPPORTED)).toBe(true);
    expect(configureTransparentBackground({})).toBe(false);
    expect(UI.ground).toBe(corbitsDark.ground);
  });

  test("unsupported request keeps UI opaque and logs once", () => {
    const lines: string[] = [];
    const onFallback = (m: string) => lines.push(m);
    expect(configureTransparentBackground(NO_TRUECOLOR, onFallback)).toBe(
      false,
    );
    expect(configureTransparentBackground(NO_TRUECOLOR, onFallback)).toBe(
      false,
    );
    expect(UI.ground).toBe(corbitsDark.ground);
    expect(lines).toHaveLength(1);
  });

  test("never mutates the dark theme's own ground", () => {
    configureTransparentBackground(SUPPORTED);
    expect(corbitsDark.ground).toBe(BRAND.ground);
  });
});

describe("theme and transparency composition", () => {
  const matrix: [string, Theme, TransparentBackgroundEnv, string][] = [
    ["corbits-dark", corbitsDark, {}, corbitsDark.ground],
    ["corbits-dark", corbitsDark, SUPPORTED, TRANSPARENT_BACKGROUND],
    ["corbits-light", corbitsLight, {}, corbitsLight.ground],
    ["corbits-light", corbitsLight, SUPPORTED, TRANSPARENT_BACKGROUND],
  ];

  for (const [name, theme, env, expectedGround] of matrix) {
    const background =
      expectedGround === TRANSPARENT_BACKGROUND ? "transparent" : "default";
    test(`${name} with ${background} background`, () => {
      setTheme(name);
      configureTransparentBackground(env);
      expect(UI.name).toBe(theme.name);
      expect(UI.text).toBe(theme.text);
      expect(UI.ground).toBe(expectedGround);
    });
  }

  test("sync setTheme preserves the transparency overlay", () => {
    configureTransparentBackground(SUPPORTED);
    setTheme("corbits-light");
    expect(UI.name).toBe("corbits-light");
    expect(UI.text).toBe(corbitsLight.text);
    expect(UI.ground).toBe(TRANSPARENT_BACKGROUND);
  });

  test("configure after setTheme uses the selected theme fallback", () => {
    setTheme("corbits-light");
    configureTransparentBackground({});
    expect(UI.ground).toBe(corbitsLight.ground);
  });

  test("async-equivalent theme transition preserves transparency", async () => {
    configureTransparentBackground(SUPPORTED);
    await Promise.resolve();
    setTheme("corbits-light");
    expect(UI.name).toBe("corbits-light");
    expect(UI.text).toBe(corbitsLight.text);
    expect(UI.ground).toBe(TRANSPARENT_BACKGROUND);
  });

  test("disabling transparency restores the selected light ground", () => {
    setTheme("corbits-light");
    configureTransparentBackground(SUPPORTED);
    configureTransparentBackground({});
    expect(UI.name).toBe("corbits-light");
    expect(UI.ground).toBe(corbitsLight.ground);
  });
});
