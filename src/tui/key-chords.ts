import { type KeyEvent } from "@opentui/core";

export type AltChordLetter = "a" | "c" | "d" | "r" | "t" | "v" | "w" | "x";

/**
 * Allowlist, never a Unicode fold: unknown glyphs stay text (invariant I-4).
 * `f` and dead-key letters `e u i n g` are absent: Option+F is favorites
 * (modifier only) and those dead keys start a compose sequence.
 */
export const OPTION_CHORD_GLYPHS: Readonly<
  Partial<Record<AltChordLetter, readonly string[]>>
> = {
  a: ["å", "Å"],
  c: ["ç", "Ç"],
  d: ["∂"],
  r: ["®"],
  // No shifted form: macOS US composes ⇧Option+T as `ˇ`, and `‡` is the
  // shifted glyph of Option+**7**, so claiming either for `t` would turn a
  // printable that belongs to another key into the trust chord (I-4).
  t: ["†"],
  v: ["√"],
  // No shifted form: macOS US composes ⇧Option+W as `„`, and `◊` is the
  // shifted glyph of Option+**V**, so claiming either for `w` would turn a
  // printable that belongs to another key into this chord (CL-8637, I-4).
  w: ["∑"],
  x: ["≈"],
};

const LETTER_BY_GLYPH: ReadonlyMap<string, AltChordLetter> = new Map(
  Object.entries(OPTION_CHORD_GLYPHS).flatMap(([letter, glyphs]) =>
    (glyphs ?? []).map((glyph) => [glyph, letter as AltChordLetter] as const),
  ),
);

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
