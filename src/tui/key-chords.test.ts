import { describe, expect, test } from "bun:test";
import { type KeyEvent } from "@opentui/core";
import {
  ALT_CHORD_LETTERS,
  OPTION_CHORD_GLYPHS,
  type AltChordLetter,
  altChordLetterForKey,
} from "./key-chords.js";

function key(fields: Partial<KeyEvent>): KeyEvent {
  return {
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    option: false,
    ...fields,
  } as KeyEvent;
}

/** Shape B: a bare composed glyph, no modifier bits. */
function charKey(glyph: string): KeyEvent {
  return key({ name: glyph, sequence: glyph });
}

// Proven subset (`å/Å`, `∂`, `®`) is pinned end-to-end by CL-8635's
// composed-glyph tests in product-host.test.ts. The other rows match the
// macOS built-in U.S./ABC Option layer as documented by Apple's keyboard
// modifier set (Option+C ç/Ç, Option+T †/‡, Option+V √, Option+W ∑/◊,
// Option+X ≈). ‰ (⇧Option+W) stays text: SOLUTION_SCOPE.md §3 lists exactly
// the glyphs below, and an unlisted glyph is never a chord (I-4).
const PICKER: readonly AltChordLetter[] = ["a", "d", "r"];

describe("altChordLetterForKey", () => {
  test("shape A: modifier bit plus ASCII letter", () => {
    expect(altChordLetterForKey(key({ name: "d", option: true }), PICKER)).toBe(
      "d",
    );
    expect(altChordLetterForKey(key({ name: "d", meta: true }), PICKER)).toBe(
      "d",
    );
  });

  test("shape A: ctrl always wins", () => {
    expect(
      altChordLetterForKey(
        key({ name: "d", ctrl: true, option: true }),
        PICKER,
      ),
    ).toBeNull();
  });

  test("shape B: composed glyph as name, or riding the sequence only", () => {
    expect(altChordLetterForKey(charKey("∂"), PICKER)).toBe("d");
    expect(
      altChordLetterForKey(key({ name: "a", sequence: "å" }), PICKER),
    ).toBe("a");
    expect(altChordLetterForKey(charKey("Å"), ["a"])).toBe("a");
  });

  test("an undeclared letter is never a chord", () => {
    expect(altChordLetterForKey(charKey("∂"), ["a"])).toBeNull();
    expect(altChordLetterForKey(charKey("∂"), [])).toBeNull();
    expect(
      altChordLetterForKey(key({ name: "d", option: true }), []),
    ).toBeNull();
  });

  test("bare ASCII is never a chord", () => {
    expect(altChordLetterForKey(charKey("a"), PICKER)).toBeNull();
    expect(altChordLetterForKey(charKey("r"), PICKER)).toBeNull();
  });

  test("unknown glyphs never fuzzy-match", () => {
    // ç is Option+C on macOS US — a real chord letter elsewhere, but not
    // declared here, and never folded into "d".
    expect(altChordLetterForKey(charKey("ç"), ["d"])).toBeNull();
    // µ is Option+M; no surface declares m.
    expect(altChordLetterForKey(charKey("µ"), PICKER)).toBeNull();
    expect(altChordLetterForKey(charKey("é"), PICKER)).toBeNull();
    // ƒ is Option+F — favorites is excluded from the union (§5), so the
    // glyph has no chord path on any surface, whatever is declared.
    expect(altChordLetterForKey(charKey("ƒ"), ALT_CHORD_LETTERS)).toBeNull();
    // ‰ is the ⇧Option+W layer glyph; §3 lists ∑/◊ for w and stops there.
    expect(altChordLetterForKey(charKey("‰"), ["v", "w"])).toBeNull();
    // ◊ is the listed shifted form of w — a chord only where w is declared.
    expect(altChordLetterForKey(charKey("◊"), ["w"])).toBe("w");
    expect(altChordLetterForKey(charKey("◊"), ["v"])).toBeNull();
  });

  test("ctrl plus a composed glyph is never a chord", () => {
    expect(
      altChordLetterForKey(key({ ...charKey("®"), ctrl: true }), PICKER),
    ).toBeNull();
  });
});

describe("ALT_CHORD_LETTERS / OPTION_CHORD_GLYPHS", () => {
  test("never advertises f or the dead-key letters e u i n g", () => {
    for (const letter of ["f", "e", "u", "i", "n", "g"]) {
      expect(ALT_CHORD_LETTERS.includes(letter as AltChordLetter)).toBe(false);
    }
  });

  test("every glyph-table letter is a declared chord letter", () => {
    for (const letter of Object.keys(OPTION_CHORD_GLYPHS)) {
      expect(ALT_CHORD_LETTERS.includes(letter as AltChordLetter)).toBe(true);
    }
  });

  test("every declared glyph maps back to its letter", () => {
    for (const letter of Object.keys(OPTION_CHORD_GLYPHS) as AltChordLetter[]) {
      for (const glyph of OPTION_CHORD_GLYPHS[letter] ?? []) {
        expect(altChordLetterForKey(charKey(glyph), ALT_CHORD_LETTERS)).toBe(
          letter,
        );
      }
    }
  });
});
