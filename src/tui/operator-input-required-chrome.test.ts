import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { rgbToHex, type CapturedSpan, type RGBA } from "@opentui/core";

import type { PendingAskWake } from "../subagent/fleet-report.js";
import {
  PRIMARY_ASK_OPERATOR_SOURCE,
  type OperatorGateEvent,
} from "./gate-events.js";
import { wireGates } from "./gate-wire.js";
import { withTestRenderer, type Harness } from "./harness.js";
import { BORDER } from "./prompt-border.js";
import { repaintShellForTheme } from "./runner/settings.js";
import {
  appendStreamRow,
  clearOperatorInputRequired,
  paintChrome,
  relayout,
  setOperatorInputRequiredGate,
  setStatusFlash,
  setWorkerWaitAsks,
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

const WAITING_WORKER: PendingAskWake = {
  sessionId: "sess-builder",
  agentId: "builder",
  description: "copy assets",
  question: "Which destination path should I use?",
  questionId: "q1",
};

/**
 * Wire an emitter to the shell the way mountProductHost does, so gate events
 * reach the strip through the real admission/settlement hooks.
 */
function wirePrimaryHost(shell: AppShell, emitter: EventEmitter): () => void {
  return wireGates(emitter, shell, {
    onGateOpened: () => undefined,
    onGateClosed: () => undefined,
    onPrimaryOperatorAdmitted: (event) =>
      setOperatorInputRequiredGate(shell, event),
    onPrimaryOperatorSettled: (event) =>
      clearOperatorInputRequired(shell, event.id),
  });
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

  test("a live theme switch repaints the strip in the new palette", async () => {
    setTheme("corbits-dark");
    await withShell(async (shell, h) => {
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      await frameRows(h);
      setTheme("corbits-light");
      repaintShellForTheme(shell);
      await frameRows(h);
      const label = spanWith(h, "INPUT REQUIRED");
      expect(label === undefined ? null : hex(label.fg)).toBe(
        UI.action.toLowerCase(),
      );
    });
  });

  test("the strip persists through transcript growth, scrolling, typing, flashes and redraws", async () => {
    await withShell(async (shell, h) => {
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      const before = await frameRows(h);
      const painted = before[inputRow(before)];
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
      expect(after[inputRow(after)]).toBe(painted);
      expect(shell.layout.heights.input_required).toBe(1);
    });
  });

  test("the strip stays visible while an operator modal is open", async () => {
    await withShell(async (shell, h) => {
      const emitter = new EventEmitter();
      const disposeGates = wirePrimaryHost(shell, emitter);
      try {
        emitter.emit("operator.gate", {
          id: "one",
          source: PRIMARY_ASK_OPERATOR_SOURCE,
          question: "Which branch should I use?",
          options: ["main", "dev"],
          resolve: () => undefined,
        });
        expect(shell.overlayKind).toBe("operator");
        const rows = await frameRows(h);
        expect(shell.layout.heights.input_required).toBe(1);
        expect(rows.some((row) => row.includes("INPUT REQUIRED"))).toBe(true);
      } finally {
        disposeGates();
      }
    });
  });

  test("settling one of two leaves the other strip in place", async () => {
    await withShell(async (shell, h) => {
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      setOperatorInputRequiredGate(
        shell,
        gate("two", "Should I include tests?"),
      );
      await frameRows(h);
      clearOperatorInputRequired(shell, "one");
      const rows = await frameRows(h);
      expect(rows.some((row) => row.includes("INPUT REQUIRED"))).toBe(true);
      expect(rows.some((row) => row.includes("Should I include tests?"))).toBe(
        true,
      );
      expect(shell.layout.heights.input_required).toBe(1);
      clearOperatorInputRequired(shell, "two");
      const restored = await frameRows(h);
      expect(shell.layout.heights.input_required).toBe(0);
      expect(restored.some((row) => row.includes("INPUT REQUIRED"))).toBe(
        false,
      );
    });
  });

  test("WORKER WAITING and INPUT REQUIRED sit together with correct order", async () => {
    await withShell(async (shell, h) => {
      setWorkerWaitAsks(shell, [WAITING_WORKER]);
      setOperatorInputRequiredGate(
        shell,
        gate("one", "Which branch should I use?"),
      );
      const rows = await frameRows(h);
      const worker = rows.findIndex((row) => row.includes("WORKER WAITING"));
      const input = rows.findIndex((row) => row.includes("INPUT REQUIRED"));
      expect(worker).toBeGreaterThanOrEqual(0);
      expect(input).toBeGreaterThan(worker);
      expect(rows.filter((row) => row.includes("WORKER WAITING"))).toHaveLength(
        1,
      );
      expect(rows.filter((row) => row.includes("INPUT REQUIRED"))).toHaveLength(
        1,
      );
      const w = shell.layout.regions.worker_wait;
      const i = shell.layout.regions.input_required;
      const p = shell.layout.regions.prompt;
      expect(w !== undefined && i !== undefined && p !== undefined).toBe(true);
      if (w === undefined || i === undefined || p === undefined) return;
      expect(w.y).toBeLessThan(i.y);
      expect(i.y + i.height).toBe(p.y);
    });
  });

  test("MCP-trust and permission gates never raise an INPUT REQUIRED row", async () => {
    await withShell(async (shell, h) => {
      const emitter = new EventEmitter();
      const disposeGates = wirePrimaryHost(shell, emitter);
      try {
        emitter.emit("permission.gate", {
          id: "perm-1",
          request: {
            tool: "run_shell",
            action: "Run shell command",
            subject: "bun test",
            scopes: [],
          },
          resolve: () => undefined,
        });
        emitter.emit("operator.gate", {
          id: "mcp-trust",
          question: "Trust this local MCP server?",
          options: ["Trust and connect", "Cancel"],
          resolve: () => undefined,
        });
        const rows = await frameRows(h);
        expect(shell.overlayKind).toBe("permissions");
        expect(shell.layout.heights.input_required).toBe(0);
        expect(rows.some((row) => row.includes("INPUT REQUIRED"))).toBe(false);
      } finally {
        disposeGates();
      }
    });
  });

  test("worker ask_director waiting and OAuth-style notices never raise an INPUT REQUIRED row", async () => {
    await withShell(async (shell, h) => {
      setWorkerWaitAsks(shell, [WAITING_WORKER]);
      setStatusFlash(shell, "OAuth token refresh needed");
      const rows = await frameRows(h);
      expect(rows.some((row) => row.includes("WORKER WAITING"))).toBe(true);
      expect(shell.layout.heights.input_required).toBe(0);
      expect(rows.some((row) => row.includes("INPUT REQUIRED"))).toBe(false);
    });
  });
});
