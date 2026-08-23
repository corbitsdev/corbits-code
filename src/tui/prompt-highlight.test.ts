/**
 * End-to-end: a leading `/command` or `@mention` typed into the real prompt
 * widget paints orange; bare skill/agent words and mid-prose slashes do not.
 */
import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { withTestRenderer, type Harness } from "./harness";
import {
  createAppShell,
  setPromptRecognitionSource,
  syncPromptHighlights,
  type AppShell,
} from "./shell";
import { UI } from "./theme";

const ACTION_FG = RGBA.fromHex(UI.action);

function withShell(fn: (shell: AppShell, h: Harness) => Promise<void> | void): Promise<void> {
  return withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, {
      terminal: { columns: 60, rows: 20 },
      wireKeys: true,
      run: "idle",
    });
    setPromptRecognitionSource(shell, () => ({
      commandNames: ["implement", "review", "improve", "linear-create"],
    }));
    try {
      await fn(shell, h);
    } finally {
      shell.dispose();
    }
  });
}

async function compose(shell: AppShell, h: Harness, value: string): Promise<void> {
  shell.prompt.value = value;
  syncPromptHighlights(shell);
  await h.renderOnce();
  await h.renderOnce();
}

function spansFor(h: Harness, text: string): { text: string; fg: RGBA }[] {
  const found: { text: string; fg: RGBA }[] = [];
  for (const line of h.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) found.push({ text: span.text, fg: span.fg });
    }
  }
  return found;
}

describe("prompt recognition highlighting", () => {
  test("a leading slash command paints in the action color", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "/implement");
      const spans = spansFor(h, "/implement");
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.some((s) => s.fg.equals(ACTION_FG))).toBe(true);
    });
  });

  test("an @mention paints in the action color", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "ask @emil to review");
      const spans = spansFor(h, "@emil");
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.some((s) => s.fg.equals(ACTION_FG))).toBe(true);
    });
  });

  test("bare words stay unstyled", async () => {
    await withShell(async (shell, h) => {
      for (const word of ["emil", "implement", "brand review", "improve", "linear-create"]) {
        await compose(shell, h, word);
        const spans = spansFor(h, word);
        expect(spans.length).toBeGreaterThan(0);
        expect(spans.every((s) => !s.fg.equals(ACTION_FG))).toBe(true);
      }
    });
  });

  test("a mid-prose slash command stays unstyled", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "please /review this");
      const spans = spansFor(h, "/review");
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.every((s) => !s.fg.equals(ACTION_FG))).toBe(true);
    });
  });

  test("a lookalike that is not a mention stays unstyled", async () => {
    await withShell(async (shell, h) => {
      await compose(shell, h, "emily is not emil");
      const spans = spansFor(h, "emily");
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.every((s) => !s.fg.equals(ACTION_FG))).toBe(true);
    });
  });
});
