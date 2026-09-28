import { test, expect, afterEach } from "bun:test";
import { defined } from "../../helpers/defined.js";
import {
  color,
  color256,
  palette,
  supportsTrueColor,
} from "../../../src/tui/semantic-theme.js";
import { setTheme } from "../../../src/tui/theme.js";

const originalColorterm = process.env.COLORTERM;

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function ansi256Hex(index: number): string {
  const base = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];
  if (index < 16) return defined(base[index]);
  if (index < 232) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = defined(levels[Math.floor(offset / 36)]);
    const green = defined(levels[Math.floor((offset % 36) / 6)]);
    const blue = defined(levels[offset % 6]);
    return `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  const gray = 8 + (index - 232) * 10;
  const channel = gray.toString(16).padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

const SURFACE_ROLES = [
  "text",
  "muted",
  "brand",
  "accent",
  "success",
  "danger",
  "warning",
  "live",
  "emphasis",
  "syntaxKeyword",
  "syntaxString",
  "syntaxFunction",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxVariable",
  "markdownHeading",
  "markdownLink",
  "markdownCode",
  "markdownBlockquote",
  "markdownEmphasis",
  "markdownStrong",
  "diffAdded",
  "diffRemoved",
  "diffHunkHeader",
] as const;

const EXPLICIT_SURFACE_PAIRS = [
  ["diffAdded", "diffAddedBg"],
  ["diffRemoved", "diffRemovedBg"],
  ["text", "userMessageBg"],
  ["text", "toolPendingBg"],
  ["text", "toolSuccessBg"],
  ["text", "toolErrorBg"],
] as const;

afterEach(() => {
  setTheme("corbits-dark");
  if (originalColorterm === undefined) {
    delete process.env.COLORTERM;
  } else {
    process.env.COLORTERM = originalColorterm;
  }
});

test("warning reuses the brand orange hex", () => {
  expect(color("warning")).toBe(color("brand"));
});

test("semantic foregrounds are readable on their rendered surfaces", () => {
  for (const theme of ["corbits-dark", "corbits-light"] as const) {
    setTheme(theme);
    for (const tier of ["truecolor", "ansi256"] as const) {
      const rendered = (role: keyof typeof palette): string =>
        tier === "truecolor"
          ? palette[role].hex
          : ansi256Hex(palette[role].ansi256);
      for (const role of SURFACE_ROLES) {
        expect(
          contrast(rendered(role), rendered("surface")),
          `${theme} ${tier} ${role} on surface`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const [foreground, background] of EXPLICIT_SURFACE_PAIRS) {
        expect(
          contrast(rendered(foreground), rendered(background)),
          `${theme} ${tier} ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("ANSI brand, accent, and live preserve semantic hierarchy", () => {
  for (const theme of ["corbits-dark", "corbits-light"] as const) {
    setTheme(theme);
    expect(
      new Set([
        palette.brand.ansi256,
        palette.accent.ansi256,
        palette.live.ansi256,
      ]).size,
      theme,
    ).toBe(3);
  }
});

test("every role maps to a valid ANSI-256 index", () => {
  for (const role of Object.keys(palette) as (keyof typeof palette)[]) {
    const idx = color256(role);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(255);
  }
});

test("every role exposes a six-digit hex value", () => {
  for (const role of Object.keys(palette) as (keyof typeof palette)[]) {
    expect(palette[role].hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  }
});

test("diff foregrounds alias the semantic status colors", () => {
  expect(palette.diffAdded).toEqual(palette.success);
  expect(palette.diffRemoved).toEqual(palette.danger);
  expect(palette.diffContext).toEqual(palette.dim);
  expect(palette.diffHunkHeader).toEqual(palette.accent);
});

test("diff backgrounds are distinct dark tints", () => {
  expect(palette.diffAddedBg.hex).not.toBe(palette.diffRemovedBg.hex);
  // The tints must stay apart in the 256-color tier too; the nearest-match
  // fallback for both hexes is the same neutral gray, which would erase the
  // added/removed distinction on non-truecolor terminals.
  expect(palette.diffAddedBg.ansi256).not.toBe(palette.diffRemovedBg.ansi256);
  for (const role of [
    "diffAddedBg",
    "diffRemovedBg",
    "userMessageBg",
  ] as const) {
    // Backgrounds must stay dark enough that every foreground reads on top.
    const channels = [1, 3, 5].map((i) =>
      parseInt(palette[role].hex.slice(i, i + 2), 16),
    );
    for (const channel of channels) expect(channel).toBeLessThan(0x60);
  }
});

test("markdown tokens reuse the prose brightness ladder", () => {
  expect(palette.markdownHeading).toEqual(palette.emphasis);
  expect(palette.markdownStrong).toEqual(palette.emphasis);
  expect(palette.markdownLink).toEqual(palette.accent);
  expect(palette.markdownBlockquote).toEqual(palette.muted);
  expect(palette.markdownCode).toEqual(palette.brand);
});

test("syntax comments recede to the dim rung and strings match success green", () => {
  expect(palette.syntaxComment).toEqual(palette.dim);
  expect(palette.syntaxString).toEqual(palette.success);
  expect(palette.syntaxVariable).toEqual(palette.text);
});

test("supportsTrueColor detects truecolor terminals", () => {
  process.env.COLORTERM = "truecolor";
  expect(supportsTrueColor()).toBe(true);
  process.env.COLORTERM = "24bit";
  expect(supportsTrueColor()).toBe(true);
});

test("palette roles preserve identity and truthful reflection", () => {
  setTheme("corbits-light");
  const brand = palette.brand;
  expect(palette.brand).toBe(brand);
  expect(Object.keys(palette)).toContain("brand");
  expect(Object.entries(palette)).toContainEqual(["brand", brand]);
  expect(Object.getOwnPropertyDescriptor(palette, "brand")?.value).toBe(brand);
});

test("a frozen palette record remains readable across theme changes", () => {
  setTheme("corbits-light");
  const brand = palette.brand;
  const lightHex = brand.hex;
  Object.freeze(palette);
  expect(() => palette.brand.hex).not.toThrow();
  setTheme("corbits-dark");
  expect(palette.brand).toBe(brand);
  expect(palette.brand.hex).not.toBe(lightHex);
});

test("supportsTrueColor is false when COLORTERM is absent or basic", () => {
  delete process.env.COLORTERM;
  expect(supportsTrueColor()).toBe(false);
  process.env.COLORTERM = "256color";
  expect(supportsTrueColor()).toBe(false);
});
