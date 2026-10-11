/**
 * Light-palette legibility: every `corbitsLight` role holds >=4.5:1 against
 * the cream ground, and warm roles separate by lightness first, hue and
 * saturation second. Assertions compare computed values, never pinned hex,
 * so the palette can be re-tuned without rewriting the contract.
 */

import { describe, expect, test } from "bun:test";

import { corbitsDark, corbitsLight, type Theme } from "./theme.js";

type Channel = readonly [number, number, number];

function channels(hex: string): Channel {
  const clean = hex.replace("#", "");
  const at = (i: number): number => parseInt(clean.slice(i, i + 2), 16) / 255;
  return [at(0), at(2), at(4)];
}

function linearChannel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  );
}

function contrast(foreground: string, background: string): number {
  const hi = Math.max(luminance(foreground), luminance(background));
  const lo = Math.min(luminance(foreground), luminance(background));
  return (hi + 0.05) / (lo + 0.05);
}

function saturation(hex: string): number {
  const [r, g, b] = channels(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const light = (mx + mn) / 2;
  return light > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const d = mx - mn;
  const h =
    mx === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : mx === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return h;
}

/** Painted roles: every Theme key except the ground and the name. */
function paintedRoles(theme: Theme): readonly [string, string][] {
  return (Object.entries(theme) as [string, string][]).filter(
    ([key, value]) =>
      key !== "ground" && key !== "name" && value.startsWith("#"),
  );
}

const onCream = (role: string): number =>
  contrast(corbitsLight[role as keyof Theme] as string, corbitsLight.ground);

describe("corbitsLight legibility on cream", () => {
  test("every painted role holds >=4.5:1 against the ground", () => {
    for (const [role, value] of paintedRoles(corbitsLight)) {
      expect(
        contrast(value, corbitsLight.ground),
        `${role} contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("body text keeps dark-theme parity within a narrow band", () => {
    const lightText = contrast(corbitsLight.text, corbitsLight.ground);
    const darkText = contrast(corbitsDark.text, corbitsDark.ground);
    expect(Math.abs(lightText - darkText)).toBeLessThan(2);
  });

  test("emphasis orderings run text > dim > faint within each ramp", () => {
    expect(onCream("text")).toBeGreaterThan(onCream("textDim"));
    expect(onCream("textDim")).toBeGreaterThan(onCream("textFaint"));
    expect(onCream("action")).toBeGreaterThan(onCream("actionDim"));
    expect(onCream("inFlight")).toBeGreaterThan(onCream("inFlightBright"));
  });

  test("each intra-ramp step spans >=1.5:1 so ramps read as ramps", () => {
    expect(onCream("action") / onCream("actionDim")).toBeGreaterThanOrEqual(
      1.5,
    );
    expect(
      onCream("inFlight") / onCream("inFlightBright"),
    ).toBeGreaterThanOrEqual(1.5);
    expect(onCream("text") / onCream("textDim")).toBeGreaterThanOrEqual(1.5);
  });

  test("the decision marker is the darkest warm on screen", () => {
    for (const role of ["actionDim", "inFlight", "inFlightBright", "heading"]) {
      expect(onCream("action"), `action vs ${role}`).toBeGreaterThan(
        onCream(role),
      );
    }
  });

  test("the heading sits in the lightest tier, apart from the dim tier", () => {
    expect(onCream("heading")).toBeLessThan(onCream("inFlight"));
    expect(onCream("heading")).toBeLessThan(onCream("actionDim"));
  });

  test("same-tier collisions are carried by hue and saturation, not lightness", () => {
    expect(saturation(corbitsLight.action)).toBeGreaterThan(
      saturation(corbitsLight.heading),
    );
    expect(saturation(corbitsLight.heading)).toBeGreaterThan(
      saturation(corbitsLight.inFlightBright),
    );
    expect(saturation(corbitsLight.actionDim)).toBeGreaterThan(
      saturation(corbitsLight.inFlight),
    );
    expect(
      Math.abs(hue(corbitsLight.actionDim) - hue(corbitsLight.inFlight)),
    ).toBeGreaterThanOrEqual(15);
  });
});

describe("dark/light role parity", () => {
  test("both themes expose the same role keys", () => {
    expect(Object.keys(corbitsLight).sort()).toEqual(
      Object.keys(corbitsDark).sort(),
    );
  });

  test("both themes paint on their own declared ground", () => {
    expect(corbitsLight.ground).not.toBe(corbitsDark.ground);
  });
});
