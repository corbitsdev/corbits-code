import { afterEach, describe, expect, test } from "bun:test";
import { rgbToHex, type CapturedSpan, type RGBA } from "@opentui/core";

import { defined } from "../../tests/helpers/defined.js";
import { withTestRenderer } from "./harness.js";
import { createAppShell } from "./shell/index.js";
import { openSettingsOverlay } from "./shell/palette.js";
import {
  BRAND,
  configureTransparentBackground,
  corbitsDark,
  corbitsLight,
  isTransparentBackgroundRequested,
  setTheme,
  TRANSPARENT_BACKGROUND,
  UI,
  type Theme,
  type TransparentBackgroundEnv,
} from "./theme.js";

const REQUESTED: TransparentBackgroundEnv = {
  CORBITS_TRANSPARENT_BACKGROUND: "1",
};

const UNRECOGNIZED_TERMINAL: TransparentBackgroundEnv = {
  CORBITS_TRANSPARENT_BACKGROUND: "true",
  COLORTERM: "unknown",
  TERM: "unrecognized-terminal",
  TERM_PROGRAM: "unrecognized-emulator",
};

function alpha(color: RGBA): number {
  return color.toInts()[3];
}

function luminance(color: RGBA): number {
  const channels = color
    .toInts()
    .slice(0, 3)
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
  return (
    0.2126 * defined(channels[0]) +
    0.7152 * defined(channels[1]) +
    0.0722 * defined(channels[2])
  );
}

function contrast(foreground: RGBA, background: RGBA): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function findSpan(
  lines: readonly { spans: readonly CapturedSpan[] }[],
  text: string,
): CapturedSpan {
  return defined(
    lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes(text)),
    `span containing ${text}`,
  );
}

afterEach(() => {
  configureTransparentBackground({});
  setTheme("corbits-dark");
});

describe("transparent background opt-in", () => {
  test("default stays opaque", () => {
    for (const theme of [corbitsDark, corbitsLight]) {
      setTheme(theme.name);
      expect(configureTransparentBackground({})).toBe(false);
      expect(UI.ground).toBe(theme.ground);
      expect(UI.canvasGround).toBe(theme.ground);
    }
  });

  test("explicit request is honored without terminal capability proxies", () => {
    for (const env of [REQUESTED, UNRECOGNIZED_TERMINAL]) {
      expect(isTransparentBackgroundRequested(env)).toBe(true);
      expect(configureTransparentBackground(env)).toBe(true);
      expect(UI.canvasGround).toBe(TRANSPARENT_BACKGROUND);
      expect(UI.ground).toBe(corbitsDark.ground);
    }
  });

  test("truthy env spellings opt in and falsy spellings stay opaque", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      expect(
        configureTransparentBackground({
          CORBITS_TRANSPARENT_BACKGROUND: value,
        }),
      ).toBe(true);
      expect(UI.canvasGround).toBe(TRANSPARENT_BACKGROUND);
    }
    for (const value of ["0", "false", "off", "", "no"]) {
      expect(
        configureTransparentBackground({
          CORBITS_TRANSPARENT_BACKGROUND: value,
        }),
      ).toBe(false);
      expect(UI.canvasGround).toBe(corbitsDark.ground);
    }
  });

  test("never mutates palette ground", () => {
    configureTransparentBackground(REQUESTED);
    expect(corbitsDark.ground).toBe(BRAND.ground);
    expect(UI.ground).toBe(BRAND.ground);
  });
});

describe("theme and transparency composition", () => {
  const matrix: [string, Theme, TransparentBackgroundEnv, string][] = [
    ["corbits-dark", corbitsDark, {}, corbitsDark.ground],
    ["corbits-dark", corbitsDark, REQUESTED, TRANSPARENT_BACKGROUND],
    ["corbits-light", corbitsLight, {}, corbitsLight.ground],
    ["corbits-light", corbitsLight, REQUESTED, TRANSPARENT_BACKGROUND],
  ];

  for (const [name, theme, env, expectedCanvasGround] of matrix) {
    const background =
      expectedCanvasGround === TRANSPARENT_BACKGROUND
        ? "transparent"
        : "default";
    for (const order of [
      "theme-before-configure",
      "configure-before-theme",
    ] as const) {
      test(`${name} with ${background}, ${order}`, () => {
        if (order === "theme-before-configure") {
          setTheme(name);
          configureTransparentBackground(env);
        } else {
          configureTransparentBackground(env);
          setTheme(name);
        }
        expect(UI.name).toBe(theme.name);
        expect(UI.text).toBe(theme.text);
        expect(UI.ground).toBe(theme.ground);
        expect(UI.canvasGround).toBe(expectedCanvasGround);
      });
    }
  }

  test("async-equivalent theme transition preserves transparency", async () => {
    configureTransparentBackground(REQUESTED);
    await Promise.resolve();
    setTheme("corbits-light");
    expect(UI.name).toBe("corbits-light");
    expect(UI.text).toBe(corbitsLight.text);
    expect(UI.ground).toBe(corbitsLight.ground);
    expect(UI.canvasGround).toBe(TRANSPARENT_BACKGROUND);
  });

  test("disabling transparency restores the selected canvas ground", () => {
    setTheme("corbits-light");
    configureTransparentBackground(REQUESTED);
    configureTransparentBackground({});
    expect(UI.name).toBe("corbits-light");
    expect(UI.ground).toBe(corbitsLight.ground);
    expect(UI.canvasGround).toBe(corbitsLight.ground);
  });
});

describe("rendered semantic surfaces", () => {
  for (const [themeName, theme] of [
    ["corbits-dark", corbitsDark],
    ["corbits-light", corbitsLight],
  ] as const) {
    for (const [mode, env, expectedCanvasAlpha] of [
      ["default", {}, 255],
      ["transparent", REQUESTED, 0],
    ] as const) {
      test(`${themeName} ${mode} canvas keeps controls opaque`, async () => {
        setTheme(themeName);
        configureTransparentBackground(env);

        await withTestRenderer(
          async (h) => {
            const shell = createAppShell(h.renderer, {
              terminal: { columns: 80, rows: 24 },
              wireKeys: false,
              run: "idle",
            });
            try {
              shell.prompt.value = "prompt text";
              shell.prompt.focus();
              await h.renderOnce();
              await h.renderOnce();

              const promptFrame = h.captureSpans();
              const root = defined(defined(promptFrame.lines[0]).spans[0]);
              const prompt = findSpan(promptFrame.lines, "prompt text");
              expect(alpha(root.bg)).toBe(expectedCanvasAlpha);
              expect(alpha(prompt.bg)).toBe(255);
              expect(rgbToHex(prompt.bg).toLowerCase().slice(0, 7)).toBe(
                theme.ground,
              );
              expect(contrast(prompt.fg, prompt.bg)).toBeGreaterThanOrEqual(7);

              openSettingsOverlay(shell, {
                items: ["Selected setting", "Other setting"],
              });
              await h.renderOnce();
              await h.renderOnce();

              const overlayFrame = h.captureSpans();
              const selected = findSpan(overlayFrame.lines, "Selected setting");
              const overlay = findSpan(overlayFrame.lines, "Other setting");

              for (const control of [selected, overlay]) {
                expect(alpha(control.bg)).toBe(255);
                expect(rgbToHex(control.bg).toLowerCase().slice(0, 7)).toBe(
                  theme.ground,
                );
              }
              expect(contrast(selected.fg, selected.bg)).toBeGreaterThanOrEqual(
                7,
              );
            } finally {
              shell.dispose();
            }
          },
          { width: 80, height: 24 },
        );
      });
    }
  }
});
