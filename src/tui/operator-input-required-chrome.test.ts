import { afterEach, describe, expect, test } from "bun:test";
import { rgbToHex, type CapturedSpan, type RGBA } from "@opentui/core";

import {
  PRIMARY_ASK_OPERATOR_SOURCE,
  type OperatorGateEvent,
} from "./gate-events.js";
import { withTestRenderer, type Harness } from "./harness.js";
import { BORDER } from "./prompt-border.js";
import {
  clearOperatorInputRequired,
  relayout,
  setOperatorInputRequiredGate,
} from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell } from "./shell/internals.js";
import { setTheme, UI } from "./theme.js";

afterEach(() => setTheme("corbits-dark"));

function gate(id: string, question: string): OperatorGateEvent {
  return {
    id,
    source: PRIMARY_ASK_OPERATOR_SOURCE,
    question,
    options: ["Continue"],
    resolve: () => undefined,
  };
}

async function withShell(
  fn: (shell: AppShell, h: Harness) => Promise<void>,
  size = { columns: 120, rows: 30 },
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "test",
        cwd: "/src/corbits-code",
        terminal: size,
        wireKeys: false,
      });
      try {
        await fn(shell, h);
      } finally {
        shell.dispose();
      }
    },
    { width: size.columns, height: size.rows },
  );
}

async function frameRows(h: Harness): Promise<string[]> {
  await h.renderOnce();
  await h.renderOnce();
  return h.captureCharFrame().split("\n");
}

function inputRow(rows: readonly string[]): number {
  return rows.findIndex((row) => row.includes("INPUT REQUIRED"));
}

function hex(color: RGBA): string {
  return rgbToHex(color).toLowerCase().slice(0, 7);
}

function spanWith(h: Harness, needle: string): CapturedSpan | undefined {
  return h
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes(needle));
}

describe("operator input required strip", () => {
  test("seats one deduplicated row above the prompt without changing prompt height", async () => {
    await withShell(async (shell, h) => {
      const promptHeight = shell.layout.heights.prompt;
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      setOperatorInputRequiredGate(
        shell,
        gate("two", "Should I include tests?"),
      );
      const rows = await frameRows(h);
      const index = inputRow(rows);
      const strip = shell.layout.regions.input_required;
      const prompt = shell.layout.regions.prompt;
      expect(index).toBeGreaterThanOrEqual(0);
      expect(rows.filter((row) => row.includes("INPUT REQUIRED"))).toHaveLength(
        1,
      );
      expect(rows[index]).toContain("(+1 more)");
      expect(strip?.height).toBe(1);
      expect(
        strip !== undefined &&
          prompt !== undefined &&
          strip.y + strip.height === prompt.y,
      ).toBe(true);
      expect(rows[index + 1]?.trimStart().startsWith(BORDER.topLeft)).toBe(
        true,
      );
      expect(shell.layout.heights.prompt).toBe(promptHeight);
    });
  });

  test("resize preserves the row and final settlement restores normal geometry", async () => {
    await withShell(async (shell, h) => {
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      h.resize(32, 30);
      relayout(shell, { columns: 32, rows: 30 });
      expect((await frameRows(h))[inputRow(await frameRows(h))]).toContain(
        "INPUT REQUIRED",
      );
      clearOperatorInputRequired(shell, "one");
      const rows = await frameRows(h);
      expect(shell.layout.heights.input_required).toBe(0);
      expect(shell.inputRequiredRow.visible).toBe(false);
      expect(rows.some((row) => row.includes("INPUT REQUIRED"))).toBe(false);
    });
  });

  for (const theme of ["corbits-dark", "corbits-light"] as const) {
    test(`${theme} maps semantic label and routing roles through the active palette`, async () => {
      setTheme(theme);
      await withShell(async (shell, h) => {
        setOperatorInputRequiredGate(
          shell,
          gate("one", "Which branch should I use?"),
        );
        await frameRows(h);
        const label = spanWith(h, "INPUT REQUIRED");
        const routing = spanWith(h, "operator answer needed");
        expect(label === undefined ? null : hex(label.fg)).toBe(
          UI.action.toLowerCase(),
        );
        expect(routing === undefined ? null : hex(routing.fg)).toBe(
          UI.text.toLowerCase(),
        );
      });
    });
  }
});
