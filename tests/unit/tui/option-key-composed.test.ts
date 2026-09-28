import { test, expect } from "bun:test";
import { parseKeypress, type KeyEvent } from "@opentui/core";
import { withTestRenderer, type Harness } from "../../../src/tui/harness.js";
import { appendStreamRow } from "../../../src/tui/shell/chrome.js";
import { createAppShell } from "../../../src/tui/shell/index.js";
import type { AppShell } from "../../../src/tui/shell/internals.js";
import {
  isAddProviderShortcutKey,
  isSetDefaultShortcutKey,
  normalizeOptionKey,
} from "../../../src/tui/shell/palette.js";

function ev(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
    ...overrides,
  } as KeyEvent;
}

/** ESC-prefixed delivery: Option-as-Meta terminals, already flagged. */
function flagged(name: string): KeyEvent {
  return ev({ name, sequence: `\x1b${name}`, meta: true });
}

/** Bare-glyph delivery: Option-not-Meta terminals, no flags (per parseKeypress). */
function composed(glyph: string): KeyEvent {
  return ev({ name: glyph, sequence: glyph, raw: glyph });
}

/**
 * Same chord for every dispatcher in keys.ts, which all gate on
 * (key.meta || key.option) && !key.ctrl plus the base name.
 */
function expectSameChord(actual: KeyEvent, expected: KeyEvent): void {
  expect(actual.name).toBe(expected.name);
  expect(actual.ctrl).toBe(expected.ctrl);
  expect(actual.meta || actual.option).toBe(expected.meta || expected.option);
}

const CHORD_ROWS: {
  glyph: string;
  base: string;
  flaggedName: string;
}[] = [
  { glyph: "∂", base: "d", flaggedName: "d" },
  { glyph: "¥", base: "y", flaggedName: "y" },
  { glyph: "ç", base: "c", flaggedName: "c" },
  { glyph: "µ", base: "m", flaggedName: "m" },
];

for (const { glyph, base, flaggedName } of CHORD_ROWS) {
  test(`composed ${glyph} folds to the flagged Alt+${flaggedName.toUpperCase()} chord`, () => {
    const folded = normalizeOptionKey(composed(glyph));
    expect(folded.name).toBe(base);
    expect(folded.option).toBe(true);
    expect(folded.ctrl).toBe(false);
    expect(folded.sequence).toBe(glyph);
    expectSameChord(folded, flagged(flaggedName));
  });
}

test("folded Alt+D/Alt+Y carry the kill-ring gate flags (keys.ts Alt+D/Alt+Y)", () => {
  for (const glyph of ["∂", "¥"]) {
    const folded = normalizeOptionKey(composed(glyph));
    expect(folded.meta || folded.option).toBe(true);
    expect(folded.ctrl).toBe(false);
  }
});

type OptionKeyVariant = {
  readonly label: string;
  readonly press: (harness: Harness) => void;
};

function optionKeyVariants(glyph: string, base: string): OptionKeyVariant[] {
  return [
    { label: "composed", press: (harness) => harness.pressKey(glyph) },
    {
      label: "flagged",
      press: (harness) => harness.pressKey(base, { meta: true }),
    },
  ];
}

async function withWiredShell(
  run: (shell: AppShell, harness: Harness) => Promise<void> | void,
): Promise<void> {
  await withTestRenderer(
    async (harness) => {
      const shell = createAppShell(harness.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
      });
      try {
        shell.prompt.focus();
        await run(shell, harness);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

for (const variant of optionKeyVariants("ç", "c")) {
  test(`${variant.label} Alt+C opens copy mode through the global dispatcher`, async () => {
    await withWiredShell((shell, harness) => {
      appendStreamRow(shell, { role: "assistant", text: "copy this" });
      variant.press(harness);
      expect(shell.overlayKind).toBe("copy");
    });
  });
}

for (const variant of optionKeyVariants("µ", "m")) {
  test(`${variant.label} Alt+M toggles mouse capture through the global dispatcher`, async () => {
    await withWiredShell((shell, harness) => {
      let captured = false;
      shell.mouseCapture = {
        get: () => captured,
        set: (enabled) => {
          captured = enabled;
        },
      };
      variant.press(harness);
      expect(captured).toBe(true);
    });
  });
}

for (const variant of optionKeyVariants("∂", "d")) {
  test(`${variant.label} Alt+D deletes the next word through the global dispatcher`, async () => {
    await withWiredShell((shell, harness) => {
      shell.prompt.value = "foo bar";
      shell.prompt.cursorOffset = 0;
      variant.press(harness);
      expect(shell.prompt.value).toBe("bar");
    });
  });
}

for (const variant of optionKeyVariants("¥", "y")) {
  test(`${variant.label} Alt+Y rotates the yank through the global dispatcher`, async () => {
    await withWiredShell((shell, harness) => {
      shell.prompt.value = "older";
      shell.prompt.cursorOffset = 0;
      harness.pressKey("k", { ctrl: true });
      harness.pressKey("b", { ctrl: true });
      shell.prompt.value = "newer";
      shell.prompt.cursorOffset = 0;
      harness.pressKey("k", { ctrl: true });
      harness.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("newer");
      variant.press(harness);
      expect(shell.prompt.value).toBe("older");
    });
  });
}

test("palette Alt+A fires identically for å/Å and flagged Alt+A", () => {
  for (const glyph of ["å", "Å"]) {
    expect(isAddProviderShortcutKey(composed(glyph))).toBe(true);
  }
  expect(isAddProviderShortcutKey(flagged("a"))).toBe(true);
  expect(isAddProviderShortcutKey(ev({ name: "a", sequence: "a" }))).toBe(
    false,
  );
  expect(
    isAddProviderShortcutKey(ev({ name: "å", sequence: "å", ctrl: true })),
  ).toBe(false);
});

test("palette Alt+D accepts normalized and flagged chords", () => {
  expect(isSetDefaultShortcutKey(normalizeOptionKey(composed("∂")))).toBe(true);
  expect(isSetDefaultShortcutKey(flagged("d"))).toBe(true);
  expect(isSetDefaultShortcutKey(composed("∂"))).toBe(false);
  expect(isSetDefaultShortcutKey(ev({ name: "d", sequence: "d" }))).toBe(false);
});

test("folded chords are not printable inserts (printable-insert guard)", () => {
  for (const { glyph } of CHORD_ROWS) {
    const folded = normalizeOptionKey(composed(glyph));
    expect(folded.option).toBe(true);
  }
});

test("NFD Alt+A is recognized contextually and passes through globally", () => {
  const nfd = "Å";
  expect(nfd.normalize("NFC")).toBe("Å");
  const key = composed(nfd);
  expect(isAddProviderShortcutKey(key)).toBe(true);
  expect(normalizeOptionKey(key)).toBe(key);
  expect(key.name).toBe(nfd);
  expect(key.sequence).toBe(nfd);
  expect(key.option).toBe(false);

  const parsed = parseKeypress(Buffer.from(nfd, "utf8"));
  if (parsed === null) throw new Error("parseKeypress returned null for NFD");
  expect(isAddProviderShortcutKey(parsed as KeyEvent)).toBe(true);
});

test("unclaimed å passes through unchanged and remains insertable", () => {
  for (const glyph of ["å", "Å"]) {
    const key = composed(glyph);
    expect(normalizeOptionKey(key)).toBe(key);
    expect(key.name).toBe(glyph);
    expect(key.sequence).toBe(glyph);
    expect(key.meta).toBe(false);
    expect(key.option).toBe(false);
  }
});

test("literal å inserts outside the picker through the global dispatcher", async () => {
  await withWiredShell((shell, harness) => {
    harness.pressKey("å");
    expect(shell.prompt.value).toBe("å");
  });
});

test("real parser output folds end to end: ∂ ≡ flagged Alt+D", () => {
  const parsed = parseKeypress(Buffer.from("∂", "utf8"));
  if (parsed === null) throw new Error("parseKeypress returned null for ∂");
  expect(parsed.meta).toBe(false);
  expect(parsed.option).toBe(false);
  const folded = normalizeOptionKey(parsed as KeyEvent);
  expectSameChord(folded, flagged("d"));
});

test("unmapped glyphs pass through untouched, still insertable", () => {
  for (const glyph of ["é", "ñ", "ü", "—"]) {
    const key = composed(glyph);
    expect(normalizeOptionKey(key)).toBe(key);
    expect(key.name).toBe(glyph);
    expect(key.meta).toBe(false);
    expect(key.option).toBe(false);
    expect(key.sequence).toBe(glyph);
  }
});

test("flagged and plain ASCII keys pass through untouched", () => {
  const kitty = ev({ name: "d", sequence: "d", meta: true, option: true });
  expect(normalizeOptionKey(kitty)).toBe(kitty);
  expect(kitty.name).toBe("d");
  const plain = ev({ name: "c", sequence: "c" });
  expect(normalizeOptionKey(plain)).toBe(plain);
});

test("Ctrl chords are never remapped", () => {
  const key = ev({ name: "∂", sequence: "∂", ctrl: true });
  expect(normalizeOptionKey(key)).toBe(key);
  expect(key.name).toBe("∂");
  expect(key.option).toBe(false);
});
