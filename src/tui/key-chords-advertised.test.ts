/**
 * CL-8637 anti-drift lock (BUILD_PLAN.md Phase 6): every `Alt+<letter>` a
 * hint ladder advertises must be a letter that kind can declare, and no tier
 * anywhere may advertise `Alt+F` (favorites is excluded from
 * `AltChordLetter`, so the chord is modifier-only and unadvertised —
 * SOLUTION_SCOPE.md §5). String-level on purpose: this must fail when the
 * *copy* changes without a matching declaration, which a type cannot catch.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ALT_CHORD_LETTERS, type AltChordLetter } from "./key-chords";

const overlayViewSource = () =>
  Bun.file(join(import.meta.dir, "overlay-view.ts")).text();

/** Letters advertised as `Alt+<letter>` in `text`, lowercased, deduped. */
function advertisedLetters(text: string): Set<string> {
  const letters = new Set<string>();
  for (const match of text.matchAll(/Alt\+([A-Za-z])/g)) {
    const letter = (match[1] ?? "").toLowerCase();
    if (letter !== "") letters.add(letter);
  }
  return letters;
}

/** The string lines of one named hint-ladder const. */
async function ladderBlock(name: string): Promise<string> {
  const src = await overlayViewSource();
  const start = src.indexOf(`const ${name} = [`);
  expect(start, `hint ladder ${name} exists`).toBeGreaterThanOrEqual(0);
  // Every ladder closes with "\n]" (plain or `] as const`).
  const end = src.indexOf("\n]", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// The widest declaration each kind's open site can pass (Phase 5 derives the
// hint flags from exactly these letters).
const DECLARED: Readonly<Record<string, readonly AltChordLetter[]>> = {
  model_picker: ["a", "d", "r"],
  mcp: ["a", "d", "r"],
  plugins: ["a", "w", "c", "v", "t", "x"],
};

const LADDERS: readonly { readonly name: string; readonly kind: string }[] = [
  { name: "MODEL_PICKER_HINTS", kind: "model_picker" },
  { name: "MODEL_PICKER_HINTS_WITH_REMOVE", kind: "model_picker" },
  { name: "MODEL_PICKER_HINTS_DEFAULT_WITH_REMOVE", kind: "model_picker" },
  { name: "MODEL_PICKER_HINTS_FULL_WITH_REMOVE", kind: "model_picker" },
  { name: "MODEL_PICKER_HINTS_REMOVE_ONLY", kind: "model_picker" },
  { name: "PLUGINS_HINTS", kind: "plugins" },
  { name: "MCP_MANAGE_HINTS_WITH_ADD", kind: "mcp" },
  { name: "MCP_MANAGE_HINTS_WITHOUT_ADD", kind: "mcp" },
];

describe("advertised hint ladders match the declared letters (CL-8637)", () => {
  test("every ladder tier advertises only its kind's declared letters", async () => {
    for (const { name, kind } of LADDERS) {
      const declared = DECLARED[kind] ?? [];
      const letters = advertisedLetters(await ladderBlock(name));
      // Regex rot guard: a ladder in this table must advertise something.
      expect(letters.size, `${name} advertises chords`).toBeGreaterThan(0);
      for (const letter of letters) {
        expect(
          declared.includes(letter as AltChordLetter),
          `${name} advertises Alt+${letter.toUpperCase()} but ${kind} cannot declare it`,
        ).toBe(true);
      }
    }
  });

  test("the add-less mcp ladder advertises no Alt+A", async () => {
    const letters = advertisedLetters(
      await ladderBlock("MCP_MANAGE_HINTS_WITHOUT_ADD"),
    );
    expect(letters.has("a")).toBe(false);
  });

  test("inline picker ladders stay inside {a, d, r}", async () => {
    const src = await overlayViewSource();
    const start = src.indexOf('if (kind === "model_picker") {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('if (kind === "permissions")', start);
    expect(end).toBeGreaterThan(start);
    for (const letter of advertisedLetters(src.slice(start, end))) {
      expect(["a", "d", "r"].includes(letter)).toBe(true);
    }
  });

  test("no tier anywhere advertises Alt+F, and every letter is chordable", async () => {
    const letters = advertisedLetters(await overlayViewSource());
    expect(letters.has("f")).toBe(false);
    for (const letter of letters) {
      expect(ALT_CHORD_LETTERS.includes(letter as AltChordLetter)).toBe(true);
    }
  });

  test("non-chord kinds advertise no Alt+ letter at all", async () => {
    for (const name of ["DEFAULT_OVERLAY_HINTS", "PERMISSIONS_HINTS"]) {
      expect(advertisedLetters(await ladderBlock(name)).size).toBe(0);
    }
  });
});
