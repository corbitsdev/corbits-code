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
// composed-glyph tests in product-host.test.ts. The remaining rows are the
// SOLUTION_SCOPE.md §3 allowlist for the macOS built-in U.S./ABC Option
// layer (Option+C ç/Ç, Option+T †, Option+V √, Option+W ∑, Option+X ≈).
// Neither `t` nor `w` carries a shifted form: their ⇧Option layers compose
// `ˇ` and `„`, while `‡` and `◊` are the shifted glyphs of Option+**7** and
// Option+**V** — printables that belong to another key (I-4).
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
    // Shifted-layer glyphs belong to other keys on macOS US: „ is
    // ⇧Option+W, ◊ is ⇧Option+V, ‰ is ⇧Option+R and ‡ is ⇧Option+**7** —
    // none of them is the glyph of its own letter, so none is a chord
    // wherever w, v, r or t is declared (I-4). ‡ in particular once
    // hijacked the /plugins trust chord: a printable keystroke granted
    // trust and enabled plugin code with no confirmation.
    expect(altChordLetterForKey(charKey("„"), ALT_CHORD_LETTERS)).toBeNull();
    expect(altChordLetterForKey(charKey("◊"), ALT_CHORD_LETTERS)).toBeNull();
    expect(altChordLetterForKey(charKey("‰"), ALT_CHORD_LETTERS)).toBeNull();
    expect(altChordLetterForKey(charKey("‡"), ALT_CHORD_LETTERS)).toBeNull();
    expect(altChordLetterForKey(charKey("‡"), ["t"])).toBeNull();
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

  // Provenance lock (I-4): the independent ground truth for the macOS
  // built-in U.S./ABC Option layer, letter by letter — plain glyph and,
  // where the layout composes one, the ⇧Option glyph. Every table entry
  // must be its OWN letter's glyph here; `‡` (⇧Option+7) and `◊`
  // (⇧Option+V) failed this and were dropped, and `‰` (⇧Option+R) was
  // never declared. Adding a row to the table means adding its verified
  // layout pair here first.
  const MACOS_US_OPTION_LAYER: Readonly<
    Record<AltChordLetter, readonly string[]>
  > = {
    a: ["å", "Å"],
    c: ["ç", "Ç"],
    d: ["∂", "Î"],
    r: ["®", "‰"],
    t: ["†", "ˇ"],
    v: ["√", "◊"],
    w: ["∑", "„"],
    x: ["≈", "˛"],
  };

  test("every table entry is its own letter's macOS US/ABC Option glyph", () => {
    for (const letter of ALT_CHORD_LETTERS) {
      const layoutGlyphs = MACOS_US_OPTION_LAYER[letter];
      expect(layoutGlyphs, `no layout provenance for ${letter}`).toBeDefined();
      for (const glyph of OPTION_CHORD_GLYPHS[letter] ?? []) {
        expect(
          layoutGlyphs.includes(glyph),
          `${glyph} is not an Option-layer glyph of ${letter} on macOS US/ABC`,
        ).toBe(true);
      }
    }
  });
});
