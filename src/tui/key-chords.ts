import { type KeyEvent } from "@opentui/core";

/**
 * Letters any Corbits popup may claim as an `Alt+<letter>` chord.
 * Deliberately excludes `f` (favorites stays modifier-only, never advertised)
 * and the macOS-US dead-key letters `e u i n g` (their Option layer starts a
 * compose sequence, and a chord there would fight accent entry). Letters with
 * no advertised chord (`b j k l m o p q s y z`) join only together with a
 * footer that advertises them.
 */
export type AltChordLetter = "a" | "c" | "d" | "r" | "t" | "v" | "w" | "x";

/** Runtime mirror of the union, so a test can assert membership. */
export const ALT_CHORD_LETTERS: readonly AltChordLetter[] = [
  "a",
  "c",
  "d",
  "r",
  "t",
  "v",
  "w",
  "x",
];

/**
 * macOS built-in U.S./ABC Option-layer glyphs per letter: the plain form and,
 * where the layout composes one, the shifted form — CL-8635's precedent of
 * accepting both cases of `å`. An allowlist, never a Unicode fold: unknown
 * glyphs stay text (invariant I-4).
 */
export const OPTION_CHORD_GLYPHS: Readonly<
  Partial<Record<AltChordLetter, readonly string[]>>
> = {
  a: ["å", "Å"],
  c: ["ç", "Ç"],
  d: ["∂"],
  r: ["®"],
  t: ["†", "‡"],
  v: ["√"],
  w: ["∑", "◊"],
  x: ["≈"],
};

const LETTER_BY_GLYPH: ReadonlyMap<string, AltChordLetter> = new Map(
  Object.entries(OPTION_CHORD_GLYPHS).flatMap(([letter, glyphs]) =>
    (glyphs ?? []).map((glyph) => [glyph, letter as AltChordLetter] as const),
  ),
);

/**
 * The only place that decides "this key event is the surface's Alt+<letter>".
 * Covers shape A (`option`/`meta` + ASCII letter — Option-as-Meta or Kitty)
 * and shape B (composed glyph with no modifier bits, either as `name` or as
 * `sequence`). Ctrl always wins; a glyph counts only when its letter is in
 * `declared`, so a glyph is a chord solely on the surface that declared it.
 */
export function altChordLetterForKey(
  key: KeyEvent,
  declared: readonly AltChordLetter[],
): AltChordLetter | null {
  if (key.ctrl) return null;
  const name = typeof key.name === "string" ? key.name : "";
  if (key.meta || key.option) {
    const letter = name.length === 1 ? name.toLowerCase() : "";
    return declared.find((candidate) => candidate === letter) ?? null;
  }
  const seq = typeof key.sequence === "string" ? key.sequence : "";
  const glyphLetter = LETTER_BY_GLYPH.get(seq) ?? LETTER_BY_GLYPH.get(name);
  if (glyphLetter === undefined) return null;
  return declared.find((candidate) => candidate === glyphLetter) ?? null;
}
