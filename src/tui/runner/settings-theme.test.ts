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
import { RGBA, type CapturedSpan } from "@opentui/core";

import { corbitsDark, corbitsLight, setTheme, UI } from "../theme.js";
import { transcriptSyntaxStyle } from "../stream.js";
import { withTestRenderer, type Harness } from "../harness.js";
import { appendStreamRow } from "../shell/chrome.js";
import { createAppShell } from "../shell/index.js";
import { applyThemePinLive, repaintShellForTheme } from "./settings.js";

afterEach(() => {
  setTheme("corbits-dark");
});

/** Live heading colour in the transcript registry. */
function registryHeadingFg(): RGBA | undefined {
  return transcriptSyntaxStyle().getAllStyles().get("markup.heading.1")?.fg;
}

function painted(spans: CapturedSpan[], text: string, fg: RGBA): boolean {
  return spans.some((s) => s.text.includes(text) && s.fg.equals(fg));
}

async function settleSpans(
  h: Harness,
  ready: (spans: CapturedSpan[]) => boolean,
): Promise<CapturedSpan[]> {
  let spans = h.captureSpans().lines.flatMap((line) => line.spans);
  for (let i = 0; i < 400 && !ready(spans); i++) {
    await h.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 25));
    spans = h.captureSpans().lines.flatMap((line) => line.spans);
  }
  return spans;
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
          expect(registryHeadingFg()?.equals(darkHeading)).toBe(true);

          // No cost movement anywhere in this cycle: the meter never moves,
          // so only an unconditional repaint repaints anything.
          const applied = applyThemePinLive("light", () =>
            repaintShellForTheme(shell),
          );
          expect(applied).toBe("corbits-light");
          expect(UI.name).toBe("corbits-light");
          expect(UI.ground).not.toBe(darkGround);
          expect(registryHeadingFg()?.equals(lightHeading)).toBe(true);

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
          expect(registryHeadingFg()?.equals(lightHeading)).toBe(true);

          const applied = applyThemePinLive("dark", () =>
            repaintShellForTheme(shell),
          );
          expect(applied).toBe("corbits-dark");
          expect(UI.name).toBe("corbits-dark");
          expect(registryHeadingFg()?.equals(darkHeading)).toBe(true);

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

  test("auto re-resolves through the startup path and rebuilds the registry", () => {
    setTheme("corbits-dark");
    const applied = applyThemePinLive("auto", () => undefined);
    expect(["corbits-dark", "corbits-light"]).toContain(applied);
    expect(UI.name).toBe(applied);
    expect(registryHeadingFg()?.equals(RGBA.fromHex(UI.heading))).toBe(true);
  });
});
