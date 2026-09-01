/**
 * Frame-level regression: an open overlay and the prompt border must never write
 * into the same terminal cells. Asserting "the overlay opened" is not enough —
 * the earlier bug painted correct state into overlapping rects, so these tests
 * read the painted characters back out of the headless renderer.
 */

import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness.js";
import {
  appendStreamRow,
  createAppShell,
  enterCopyMode,
  openHelpOverlay,
  openListOverlay,
  openMentionsOverlay,
  openPalette,
  openSettingsOverlay,
  setPromptModelLabel,
  type AppShell,
} from "./shell.js";

const MODEL_LABEL = "xai/thegreataxios · grok-4.5";

const ITEMS = [
  "glm-5.2 * [Z.AI]",
  "opus-4.6 * [Anthropic]",
  "gpt-5.1 * [OpenAI]",
  "gemini-3 * [Google]",
  "llama-4 * [Meta]",
  "grok-4.5 * [xAI]",
  "large-3 * [Mistral]",
  "command-a * [Cohere]",
  "v3.2 * [DeepSeek]",
  "max * [Qwen]",
] as const;

/** Frame rows between the overlay host's top and bottom border rules. */
function overlayInterior(frame: string): readonly string[] {
  const lines = frame.split("\n");
  const top = lines.findIndex((l) => l.trimStart().startsWith("┌"));
  if (top < 0) throw new Error("no overlay border found in frame");
  const bottom = lines.findIndex((l, i) => i > top && l.trimStart().startsWith("└"));
  if (bottom < 0) throw new Error("unterminated overlay border in frame");
  return lines
    .slice(top + 1, bottom)
    .map((l) => l.replace(/^\s*│/, "").replace(/│\s*$/, "").trimEnd());
}

function frameLine(frame: string, predicate: (line: string) => boolean): string[] {
  return frame.split("\n").filter(predicate);
}

async function paintOverlay(
  open: (shell: AppShell) => void,
  size: { readonly width: number; readonly height: number },
): Promise<{ readonly frame: string; readonly interior: readonly string[] }> {
  return withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer);
    setPromptModelLabel(shell, {
      profile: "xai/thegreataxios",
      model: "grok-4.5",
    });
    // An overlay always opens over a live session; the landing splits the
    // transcript around the prompt box and is a different layout entirely.
    appendStreamRow(shell, { role: "assistant", text: "session underway" });
    open(shell);
    await h.renderOnce();
    const frame = h.captureCharFrame();
    return { frame, interior: overlayInterior(frame) };
  }, size);
}

/**
 * Every interior row must be either blank or exactly one expected overlay row.
 * Two renderables sharing cells produces a hybrid string that matches nothing.
 */
function expectCleanInterior(interior: readonly string[], expected: readonly string[]): void {
  const allowed = new Set(expected.map((e) => e.trimEnd()));
  for (const row of interior) {
    if (row.trim().length === 0) continue;
    expect(allowed.has(row)).toBe(true);
  }
}

const SIZES = [
  { width: 80, height: 24 },
  { width: 100, height: 20 },
  { width: 100, height: 30 },
  { width: 120, height: 40 },
] as const;

describe("overlay host never shares cells with the prompt border", () => {
  for (const size of SIZES) {
    test(`model picker paints clean rows at ${size.width}x${size.height}`, async () => {
      const { frame, interior } = await paintOverlay(
        (shell) =>
          openListOverlay(shell, {
            kind: "model_picker",
            title: "model",
            items: ITEMS,
            // Mirror production /model, which always wires add-provider.
            addProviderHint: true,
          }),
        size,
      );

      const expected = [
        " model · Esc cancel · Enter choose · Alt+A /connect add provider",
        ` > ${ITEMS[0]}`,
        ...ITEMS.slice(1).map((i) => `   ${i}`),
      ];
      expectCleanInterior(interior, expected);

      // The selected row must be intact, not overwritten by the model label.
      expect(interior).toContain(` > ${ITEMS[0]}`);
      for (const row of interior) {
        expect(row.includes(MODEL_LABEL)).toBe(false);
        expect(row.includes("thegreataxios")).toBe(false);
      }

      // The label rides the prompt box's top border, outside the overlay box.
      const barRows = frameLine(frame, (l) => l.includes(MODEL_LABEL));
      expect(barRows).toHaveLength(1);
      expect(barRows[0]?.trim()).toEndWith(`${MODEL_LABEL} ─╮`);
    });
  }

  test("overlay rows do not spill past the host's bottom border", async () => {
    const { frame } = await paintOverlay(
      (shell) => openListOverlay(shell, { kind: "model_picker", title: "model", items: ITEMS }),
      { width: 100, height: 20 },
    );
    // A border rule interrupted by list text is the overflow signature.
    for (const line of frame.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("└") && !trimmed.startsWith("┌")) continue;
      expect(/^[┌└├┬┐┘─┤┴]+$/.test(trimmed.trimEnd())).toBe(true);
    }
  });

  for (const size of [
    { width: 80, height: 24 },
    { width: 100, height: 30 },
    { width: 60, height: 24 },
  ] as const) {
    test(`mention popup with matches clears the prompt border at ${size.width}x${size.height}`, async () => {
      const { frame } = await paintOverlay(
        (shell) => openMentionsOverlay(shell, { items: ["@src/file.ts", "@AGENTS.md"] }),
        size,
      );

      // Every border rule stays a border rule: no list text glued onto it, and
      // the overlay host's own rules never share a row with the prompt box's.
      const promptRuleRows = frameLine(frame, (l) => l.includes("─╮") || l.includes("─╯"));
      for (const line of frame.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("└") && !trimmed.startsWith("┌")) continue;
        expect(/^[┌└├┬┐┘─┤┴]+$/.test(trimmed.trimEnd())).toBe(true);
      }
      expect(promptRuleRows.length).toBeGreaterThan(0);
    });
  }
});

describe("every overlay kind paints clean rows", () => {
  const openers: readonly [string, (shell: AppShell) => void][] = [
    ["settings", (s) => openSettingsOverlay(s, { items: ["Compaction", "Close settings"] })],
    ["help", (s) => openHelpOverlay(s)],
    [
      "plugins",
      (s) =>
        openListOverlay(s, {
          kind: "plugins",
          title: "plugins",
          items: ["plugin:linear — enabled", "Close plugins"],
        }),
    ],
    [
      "resume",
      (s) =>
        openListOverlay(s, {
          kind: "resume",
          title: "resume session",
          items: ["Fix permissions overflow · 2h ago · idle", "Close resume"],
        }),
    ],
    ["mentions", (s) => openMentionsOverlay(s, { items: ["@src/file.ts", "Close mentions"] })],
    ["palette", (s) => openPalette(s)],
    [
      "permissions",
      (s) =>
        openListOverlay(s, {
          kind: "permissions",
          title: "permission",
          items: ["Allow once", "Allow always", "Deny"],
          body: "bash(rm -rf build) wants to run in the workspace root and will delete generated output before the next build starts.",
        }),
    ],
    [
      "copy",
      (s) => {
        for (let i = 0; i < 12; i++) {
          appendStreamRow(s, { role: "assistant", text: `reply line ${i}` });
        }
        enterCopyMode(s);
      },
    ],
  ];

  for (const [name, open] of openers) {
    test(`${name} overlay keeps the model label out of its rows`, async () => {
      const { frame, interior } = await paintOverlay(open, {
        width: 100,
        height: 24,
      });

      expect(interior.length).toBeGreaterThan(0);
      for (const row of interior) {
        expect(row.includes("thegreataxios")).toBe(false);
      }

      const barRows = frameLine(frame, (l) => l.includes(MODEL_LABEL));
      expect(barRows).toHaveLength(1);
      expect(barRows[0]?.trim()).toEndWith(`${MODEL_LABEL} ─╮`);
    });
  }
});
