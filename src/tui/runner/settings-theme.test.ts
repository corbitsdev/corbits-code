/**
 * Settings-pin live-apply: cycling the theme pin repaints the shell at once
 * — never records-and-waits-for-relaunch. Pins resolve exactly as startup
 * does; explicit pins are deterministic regardless of terminal state, so
 * these tests never touch `process.env` or spawn an OS probe.
 *
 * Assertions read painted content or the live style registry — never a
 * repaint counter. The pin cycle runs with no cost movement, so a
 * meter-gated repaint (or a stale cached SyntaxStyle) leaves the old
 * palette on screen and fails.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RGBA, SyntaxStyle, type CapturedSpan } from "@opentui/core";

import { corbitsDark, corbitsLight, setTheme, UI } from "../theme.js";
import { transcriptSyntaxStyle } from "../stream.js";
import { withTestRenderer, type Harness } from "../harness.js";
import { settleSpans } from "../test-helpers.js";
import { appendStreamRow } from "../shell/chrome.js";
import { createAppShell } from "../shell/index.js";
import { setPromptRecognitionSource } from "../shell/internals.js";
import { syncPromptHighlights } from "../shell/prompt.js";
import { applyThemePinLive, repaintShellForTheme } from "./settings.js";

afterEach(() => {
  setTheme("corbits-dark");
});

/** Live heading colour in the transcript registry. */
function registryHeadingFg(h: Harness): RGBA | undefined {
  return transcriptSyntaxStyle(h.renderer)
    .getAllStyles()
    .get("markup.heading.1")?.fg;
}

/** `destroy()` frees the native style and there is no finalizer; a later
 * read throws instead of returning a palette. */
function syntaxStyleAlive(style: SyntaxStyle): boolean {
  try {
    style.getStyleCount();
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes("destroyed")) return false;
    throw err;
  }
}

function painted(spans: CapturedSpan[], text: string, fg: RGBA): boolean {
  return spans.some((s) => s.text.includes(text) && s.fg.equals(fg));
}

describe("applyThemePinLive", () => {
  test("a light pin swaps the binding, rebuilds the registry, and repaints", async () => {
    await withTestRenderer(
      async (h) => {
        setTheme("corbits-dark");
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 40 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "assistant", text: "# pin cycle" });
          const darkHeading = RGBA.fromHex(corbitsDark.heading);
          const lightHeading = RGBA.fromHex(corbitsLight.heading);
          const darkGround = UI.ground;
          const before = await settleSpans(h, (spans) =>
            painted(spans, "pin cycle", darkHeading),
          );
          expect(painted(before, "pin cycle", darkHeading)).toBe(true);
          expect(registryHeadingFg(h)?.equals(darkHeading)).toBe(true);

          // No cost movement anywhere in this cycle: the meter never moves,
          // so only an unconditional repaint repaints anything.
          const applied = applyThemePinLive("light", () =>
            repaintShellForTheme(shell),
          );
          expect(applied).toBe("corbits-light");
          expect(UI.name).toBe("corbits-light");
          expect(UI.ground).not.toBe(darkGround);
          expect(registryHeadingFg(h)?.equals(lightHeading)).toBe(true);

          const after = await settleSpans(h, (spans) =>
            painted(spans, "pin cycle", lightHeading),
          );
          expect(painted(after, "pin cycle", lightHeading)).toBe(true);
          expect(painted(after, "pin cycle", darkHeading)).toBe(false);
        } finally {
          shell.dispose();
          setTheme("corbits-dark");
        }
      },
      { width: 80, height: 40 },
    );
  }, 30000);

  test("pinning back to dark restores dark content", async () => {
    await withTestRenderer(
      async (h) => {
        setTheme("corbits-light");
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 40 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "assistant", text: "# pin cycle" });
          const darkHeading = RGBA.fromHex(corbitsDark.heading);
          const lightHeading = RGBA.fromHex(corbitsLight.heading);
          const before = await settleSpans(h, (spans) =>
            painted(spans, "pin cycle", lightHeading),
          );
          expect(painted(before, "pin cycle", lightHeading)).toBe(true);
          expect(registryHeadingFg(h)?.equals(lightHeading)).toBe(true);

          const applied = applyThemePinLive("dark", () =>
            repaintShellForTheme(shell),
          );
          expect(applied).toBe("corbits-dark");
          expect(UI.name).toBe("corbits-dark");
          expect(registryHeadingFg(h)?.equals(darkHeading)).toBe(true);

          const after = await settleSpans(h, (spans) =>
            painted(spans, "pin cycle", darkHeading),
          );
          expect(painted(after, "pin cycle", darkHeading)).toBe(true);
          expect(painted(after, "pin cycle", lightHeading)).toBe(false);
        } finally {
          shell.dispose();
          setTheme("corbits-dark");
        }
      },
      { width: 80, height: 40 },
    );
  }, 30000);

  test("auto re-resolves through the startup path and rebuilds the registry", async () => {
    setTheme("corbits-dark");
    await withTestRenderer(async (h) => {
      const applied = applyThemePinLive("auto", () => undefined);
      expect(["corbits-dark", "corbits-light"]).toContain(applied);
      expect(UI.name).toBe(applied);
      expect(registryHeadingFg(h)?.equals(RGBA.fromHex(UI.heading))).toBe(true);
    });
  });

  test("a second pin destroys the transcript style the rows dropped", async () => {
    await withTestRenderer(
      async (h) => {
        setTheme("corbits-dark");
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 40 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "assistant", text: "# pin cycle" });
          const first = transcriptSyntaxStyle(h.renderer);
          applyThemePinLive("light", () => repaintShellForTheme(shell));
          const second = transcriptSyntaxStyle(h.renderer);
          expect(second).not.toBe(first);
          expect(syntaxStyleAlive(first)).toBe(false);
          expect(syntaxStyleAlive(second)).toBe(true);

          applyThemePinLive("dark", () => repaintShellForTheme(shell));
          const third = transcriptSyntaxStyle(h.renderer);
          expect(third).not.toBe(second);
          expect(syntaxStyleAlive(second)).toBe(false);
          expect(syntaxStyleAlive(third)).toBe(true);
        } finally {
          shell.dispose();
          setTheme("corbits-dark");
        }
      },
      { width: 80, height: 40 },
    );
  });

  test("refreshing the transcript cache leaves a style rows still paint", async () => {
    await withTestRenderer(
      async (h) => {
        setTheme("corbits-dark");
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 40 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "assistant", text: "# pin cycle" });
          const painted = transcriptSyntaxStyle(h.renderer);
          setTheme("corbits-light");
          const rebuilt = transcriptSyntaxStyle(h.renderer);
          expect(rebuilt).not.toBe(painted);
          expect(syntaxStyleAlive(painted)).toBe(true);
          repaintShellForTheme(shell);
          expect(syntaxStyleAlive(painted)).toBe(false);
          expect(syntaxStyleAlive(transcriptSyntaxStyle(h.renderer))).toBe(
            true,
          );
        } finally {
          shell.dispose();
          setTheme("corbits-dark");
        }
      },
      { width: 80, height: 40 },
    );
  });

  test("a pin destroys the prompt style only after the prompt drops it", async () => {
    await withTestRenderer(
      async (h) => {
        setTheme("corbits-dark");
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 40 },
          wireKeys: false,
        });
        setPromptRecognitionSource(shell, () => ({
          commandNames: ["implement"],
        }));
        const originalDestroy = SyntaxStyle.prototype.destroy;
        let destroyedWhileHeld = false;
        try {
          shell.prompt.value = "/implement";
          syncPromptHighlights(shell);
          const painted = shell.prompt.syntaxStyle;
          expect(painted).not.toBeNull();
          if (painted === null) return;
          SyntaxStyle.prototype.destroy = function destroy(this: SyntaxStyle) {
            if (this === painted && shell.prompt.syntaxStyle === painted) {
              destroyedWhileHeld = true;
            }
            return originalDestroy.call(this);
          };
          applyThemePinLive("light", () => repaintShellForTheme(shell));
          expect(shell.prompt.syntaxStyle).toBe(painted);
          expect(syntaxStyleAlive(painted)).toBe(true);
          syncPromptHighlights(shell);
          expect(destroyedWhileHeld).toBe(false);
          expect(shell.prompt.syntaxStyle).not.toBe(painted);
          expect(syntaxStyleAlive(painted)).toBe(false);
          const current = shell.prompt.syntaxStyle;
          expect(current).not.toBeNull();
          if (current !== null) expect(syntaxStyleAlive(current)).toBe(true);
        } finally {
          SyntaxStyle.prototype.destroy = originalDestroy;
          shell.dispose();
          setTheme("corbits-dark");
        }
      },
      { width: 80, height: 40 },
    );
  });
});
