import { afterEach, describe, expect, test } from "bun:test";

import {
  BRAND,
  corbitsDark,
  corbitsLight,
  resolveThemeName,
  setTheme,
  UI,
  type Theme,
} from "./theme";

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const ROLES: (keyof Theme)[] = [
  "ground",
  "text",
  "textDim",
  "textFaint",
  "action",
  "actionDim",
  "inFlight",
  "inFlightBright",
  "heading",
  "done",
  "warning",
  "error",
];

afterEach(() => {
  setTheme("corbits-dark");
});

describe("theme roles", () => {
  test("dark and light share the same role keys", () => {
    for (const role of ROLES) {
      expect(typeof corbitsLight[role]).toBe("string");
      expect(corbitsLight[role]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("light ground is light, dark ground is dark", () => {
    expect(luminance(corbitsLight.ground)).toBeGreaterThan(0.5);
    expect(luminance(corbitsDark.ground)).toBeLessThan(0.1);
  });

  test("light body text holds dark-grade contrast", () => {
    expect(contrast(corbitsLight.text, corbitsLight.ground)).toBeGreaterThan(
      10,
    );
  });

  test("every light role separates from the ground", () => {
    for (const role of ROLES) {
      if (role === "ground") continue;
      expect(contrast(corbitsLight[role], corbitsLight.ground)).toBeGreaterThan(
        3,
      );
    }
  });

  test("orange is spent once per light screen", () => {
    const orangeHue = (hex: string): boolean => {
      const r = Number.parseInt(hex.slice(1, 3), 16);
      const g = Number.parseInt(hex.slice(3, 5), 16);
      const b = Number.parseInt(hex.slice(5, 7), 16);
      return r > 140 && g > 70 && g < 130 && b < 60;
    };
    const orangeRoles = (
      Object.entries(corbitsLight) as [string, string][]
    ).filter(([role, hex]) => role !== "name" && orangeHue(hex));
    expect(orangeRoles.map(([role]) => role).sort()).toEqual([
      "action",
      "actionDim",
    ]);
  });
});

describe("live UI binding", () => {
  test("defaults to corbitsDark", () => {
    expect(UI.name).toBe("corbits-dark");
    expect(UI.text).toBe(BRAND.canvasCream);
  });

  test("setTheme swaps the palette on the same reference", () => {
    const ref = UI;
    setTheme("corbits-light");
    expect(UI).toBe(ref);
    expect(UI.name).toBe("corbits-light");
    expect(UI.ground).toBe(corbitsLight.ground);
    expect(UI.text).toBe(corbitsLight.text);
  });

  test("switching back restores dark without touching corbitsDark", () => {
    setTheme("corbits-light");
    setTheme("corbits-dark");
    expect(UI.text).toBe(corbitsDark.text);
    expect(corbitsDark.ground).toBe(BRAND.ground);
    expect(corbitsDark.text).toBe(BRAND.canvasCream);
  });

  test("resolveThemeName falls back to dark for unknown names", () => {
    expect(resolveThemeName("nope")).toBe(corbitsDark);
    expect(resolveThemeName("corbits-light")).toBe(corbitsLight);
  });
});
