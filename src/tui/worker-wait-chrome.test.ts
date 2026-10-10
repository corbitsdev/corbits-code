/**
 * WORKER WAITING strip in the shell chrome: placement on the prompt box,
 * width-safe paint, theme roles, persistence through ordinary shell activity,
 * and normal chrome once the last wait leaves the snapshot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rgbToHex, type CapturedSpan, type RGBA } from "@opentui/core";

import type { PendingAskWake } from "../subagent/fleet-report.js";
import { withTestRenderer, type Harness } from "./harness.js";
import { BORDER } from "./prompt-border.js";
import { repaintShellForTheme } from "./runner/settings.js";
import {
  appendStreamRow,
  clearWorkerWait,
  paintChrome,
  relayout,
  setStatusFlash,
  setWorkerWaitAsks,
} from "./shell/chrome.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell } from "./shell/internals.js";
import { setTheme, UI } from "./theme.js";

afterEach(() => {
  setTheme("corbits-dark");
});

const DESTINATION: PendingAskWake = {
  sessionId: "sess-builder",
  agentId: "builder",
  description: "copy assets",
  question: "Which destination path should I use?",
  questionId: "q1",
};

const SECOND: PendingAskWake = {
  sessionId: "sess-explore",
  agentId: "explore",
  description: "map callers",
  question: "Include tests?",
  questionId: "q7",
};

async function withShell(
  fn: (shell: AppShell, h: Harness) => Promise<void>,
  size: { columns: number; rows: number } = { columns: 120, rows: 30 },
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

function stripRowIndex(rows: readonly string[]): number {
  return rows.findIndex((row) => row.includes("WAITING"));
}

/** The strip owns exactly its own row, directly on the prompt's top rule. */
function expectSeatedOnPrompt(shell: AppShell, rows: readonly string[]): void {
  const strip = shell.layout.regions.worker_wait;
  const prompt = shell.layout.regions.prompt;
  expect(strip?.height).toBe(1);
  expect(strip !== undefined && prompt !== undefined).toBe(true);
  if (strip === undefined || prompt === undefined) return;
  expect(strip.y + strip.height).toBe(prompt.y);
  const index = stripRowIndex(rows);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(rows.filter((row) => row.includes("WAITING"))).toHaveLength(1);
  expect(rows[index + 1]?.trimStart().startsWith(BORDER.topLeft)).toBe(true);
}

function hex(color: RGBA): string {
  return rgbToHex(color).toLowerCase().slice(0, 7);
}

function spanWith(h: Harness, needle: string): CapturedSpan | undefined {
  for (const line of h.captureSpans().lines) {
    const span = line.spans.find((s: CapturedSpan) => s.text.includes(needle));
    if (span !== undefined) return span;
  }
  return undefined;
}

describe("worker waiting strip", () => {
  test("no live wait paints normal chrome with no strip row", async () => {
    await withShell(async (shell, h) => {
      const rows = await frameRows(h);
      expect(shell.layout.heights.worker_wait).toBe(0);
      expect(shell.workerWaitRow.visible).toBe(false);
      expect(rows.some((row) => row.includes("WAITING"))).toBe(false);
    });
  });

  test("full width seats one strip on the prompt box naming worker, question and director", async () => {
    await withShell(async (shell, h) => {
      const promptBefore = shell.layout.heights.prompt;
      setWorkerWaitAsks(shell, [DESTINATION]);
      const rows = await frameRows(h);
      expectSeatedOnPrompt(shell, rows);
      const strip = rows[stripRowIndex(rows)] ?? "";
      expect(strip).toContain("WORKER WAITING");
      expect(strip).toContain("director reply needed");
      expect(strip).toContain("builder (copy assets)");
      expect(strip).toContain("Which destination path should I use?");
      // The strip takes its row from the transcript, never the composer.
      expect(shell.layout.heights.prompt).toBe(promptBefore);
    });
  });

  test("narrow width keeps the waiting label and count inside the frame", async () => {
    await withShell(
      async (shell, h) => {
        setWorkerWaitAsks(shell, [DESTINATION, SECOND]);
        const rows = await frameRows(h);
        expectSeatedOnPrompt(shell, rows);
        const strip = rows[stripRowIndex(rows)] ?? "";
        expect(strip).toContain("WAITING");
        expect(strip).toContain("(+1 more)");
        expect(strip.trimEnd().length).toBeLessThanOrEqual(32);
      },
      { columns: 32, rows: 24 },
    );
  });

  test("resizing narrower re-fits the strip without dropping it", async () => {
    await withShell(async (shell, h) => {
      setWorkerWaitAsks(shell, [DESTINATION, SECOND]);
      const wide = await frameRows(h);
      expect(wide[stripRowIndex(wide)]).toContain("copy assets");
      h.resize(48, 30);
      relayout(shell, { columns: 48, rows: 30 });
      const narrow = await frameRows(h);
      expectSeatedOnPrompt(shell, narrow);
      const strip = narrow[stripRowIndex(narrow)] ?? "";
      expect(strip).toContain("WORKER WAITING");
      expect(strip).toContain("(+1 more)");
      expect(strip).not.toContain("copy assets");
    });
  });

  for (const theme of ["corbits-dark", "corbits-light"] as const) {
    test(`${theme} paints the label with the action role and plain-text meaning`, async () => {
      setTheme(theme);
      await withShell(async (shell, h) => {
        setWorkerWaitAsks(shell, [DESTINATION]);
        await frameRows(h);
        const label = spanWith(h, "WORKER WAITING");
        expect(label).toBeDefined();
        if (label === undefined) return;
        expect(hex(label.fg)).toBe(UI.action.toLowerCase());
        const routing = spanWith(h, "director reply needed");
        expect(routing).toBeDefined();
        if (routing === undefined) return;
        expect(hex(routing.fg)).toBe(UI.text.toLowerCase());
      });
    });
  }

  test("a live theme switch repaints the strip in the new palette", async () => {
    setTheme("corbits-dark");
    await withShell(async (shell, h) => {
      setWorkerWaitAsks(shell, [DESTINATION]);
      await frameRows(h);
      setTheme("corbits-light");
      repaintShellForTheme(shell);
      await frameRows(h);
      const label = spanWith(h, "WORKER WAITING");
      expect(label === undefined ? null : hex(label.fg)).toBe(
        UI.action.toLowerCase(),
      );
    });
  });

  test("the strip persists through transcript growth, scrolling, typing, flashes and redraws", async () => {
    await withShell(async (shell, h) => {
      setWorkerWaitAsks(shell, [DESTINATION]);
      const before = await frameRows(h);
      const painted = before[stripRowIndex(before)];
      for (let i = 0; i < 60; i++) {
        appendStreamRow(shell, { role: "assistant", text: `row ${i}` });
      }
      shell.transcript.scrollTo(0);
      shell.prompt.value = "hold on, let me check the path";
      setStatusFlash(shell, "copied");
      paintChrome(shell);
      paintChrome(shell, { force: true });
      relayout(shell);
      const after = await frameRows(h);
      expectSeatedOnPrompt(shell, after);
      expect(after[stripRowIndex(after)]).toBe(painted);
      // A repeat snapshot of the same identity changes nothing.
      setWorkerWaitAsks(shell, [DESTINATION]);
      const repeated = await frameRows(h);
      expect(repeated[stripRowIndex(repeated)]).toBe(painted);
    });
  });

  test("the final removal restores normal chrome", async () => {
    await withShell(async (shell, h) => {
      const baseline = await frameRows(h);
      const baselinePrompt = shell.layout.regions.prompt;
      setWorkerWaitAsks(shell, [DESTINATION, SECOND]);
      await frameRows(h);
      setWorkerWaitAsks(shell, [SECOND]);
      const one = await frameRows(h);
      expect(one[stripRowIndex(one)]).toContain("Include tests?");
      expect(one[stripRowIndex(one)]).not.toContain("more");
      setWorkerWaitAsks(shell, []);
      const restored = await frameRows(h);
      expect(shell.layout.heights.worker_wait).toBe(0);
      expect(shell.workerWaitRow.visible).toBe(false);
      expect(shell.layout.regions.prompt).toEqual(baselinePrompt);
      expect(restored).toEqual(baseline);
    });
  });

  test("teardown clears the strip without a snapshot", async () => {
    await withShell(async (shell, h) => {
      setWorkerWaitAsks(shell, [DESTINATION]);
      await frameRows(h);
      clearWorkerWait(shell);
      const rows = await frameRows(h);
      expect(shell.layout.heights.worker_wait).toBe(0);
      expect(rows.some((row) => row.includes("WAITING"))).toBe(false);
    });
  });
});
