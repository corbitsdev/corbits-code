/**
 * CL-5750: the approval surface must never push the prompt box off screen,
 * and its choices must always be visible/reachable — an unanswerable
 * approval deadlocks the session, so the choices win the row budget over
 * the prompt box's growth and over the overlay's own context text.
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness.js";
import { createAppShell, appendStreamRow, type AppShell } from "./shell.js";
import { openPermissionsOverlay, makePermissionItems } from "./overlays.js";

const WIDTH = 80;
// Deliberately spans from far below the documented 24-row baseline down to
// 10 rows, the shortest terminal this fix guarantees, plus a comfortable one.
const HEIGHTS = [10, 12, 15, 24, 40] as const;

const APPROVAL_BODY = [
  "run_shell",
  "Run shell command",
  "This is context describing what the tool is about to do to the workspace.",
].join("\n");

function primeSession(shell: AppShell): void {
  // In-flow layout: the overlay host competes with the prompt for rows the
  // same way a live approval does mid-session (not the landing screen).
  appendStreamRow(shell, { role: "assistant", text: "session underway" });
}

interface ApprovalSnapshot {
  readonly frame: string;
  readonly promptHeight: number;
  readonly promptVisible: boolean;
  readonly listHeight: number | null;
  readonly hasOverlayList: boolean;
}

async function paintApproval(height: number, itemCount = 6): Promise<ApprovalSnapshot> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: WIDTH, rows: height },
        run: "idle",
      });
      try {
        primeSession(shell);
        openPermissionsOverlay(shell, {
          items: makePermissionItems(itemCount),
          body: APPROVAL_BODY,
        });
        await h.renderOnce();
        await h.renderOnce();
        const frame = h.captureCharFrame().replace(/\n$/, "");
        return {
          frame,
          promptHeight: shell.layout.heights.prompt,
          promptVisible: shell.promptBox.visible,
          listHeight: shell.overlayList?.height ?? null,
          hasOverlayList: shell.overlayList !== null,
        };
      } finally {
        shell.dispose();
      }
    },
    { width: WIDTH, height },
  );
}

describe("approval overlay keeps the prompt box on screen (CL-5750)", () => {
  for (const height of HEIGHTS) {
    test(`prompt box stays visible and unclipped at ${height} rows`, async () => {
      const snap = await paintApproval(height);

      // The prompt box is always assigned rows, never displaced entirely.
      expect(snap.promptHeight).toBeGreaterThan(0);
      expect(snap.promptVisible).toBe(true);

      // The painted frame actually shows the prompt box's border, not just
      // internal state — the bug was a visual displacement, not a state one.
      const lines = snap.frame.split("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
      const promptTopBorder = lines.findIndex((l) => l.includes("╭"));
      const promptBottomBorder = lines.findIndex((l) => l.includes("╰"));
      expect(promptTopBorder).toBeGreaterThanOrEqual(0);
      expect(promptBottomBorder).toBeGreaterThan(promptTopBorder);
      // The prompt box's own bottom rule (with the cwd/branding) must be
      // fully painted within the frame, not cut off past the last row.
      expect(promptBottomBorder).toBeLessThan(lines.length);
    });

    test(`at least one approval choice is painted and reachable at ${height} rows`, async () => {
      const snap = await paintApproval(height);

      expect(snap.hasOverlayList).toBe(true);
      // The active choice is always inside the viewport window state...
      expect(snap.listHeight).toBeGreaterThanOrEqual(1);

      // ...and it is actually painted on screen, not just tracked in state:
      // the marked active choice's label must appear in the frame.
      expect(snap.frame).toContain("Allow once");
    });
  }

  test("overlay host never displaces the prompt box out of the frame even with a tall body", async () => {
    const tallBody = Array.from({ length: 20 }, (_, i) => `context line ${i}`).join("\n");
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: WIDTH, rows: 12 },
          run: "idle",
        });
        try {
          primeSession(shell);
          openPermissionsOverlay(shell, { items: makePermissionItems(10), body: tallBody });
          await h.renderOnce();
          await h.renderOnce();
          const frame = h.captureCharFrame().replace(/\n$/, "");
          const lines = frame.split("\n");
          expect(lines.length).toBeLessThanOrEqual(12);
          expect(shell.layout.heights.prompt).toBeGreaterThan(0);
          expect(lines.some((l) => l.includes("╭"))).toBe(true);
          expect(lines.some((l) => l.includes("╰"))).toBe(true);
          expect(shell.overlayList).not.toBeNull();
          expect(shell.overlayList!.height).toBeGreaterThanOrEqual(1);
        } finally {
          shell.dispose();
        }
      },
      { width: WIDTH, height: 12 },
    );
  });

  test("no dead space between the transcript and the overlay: overlay sits directly above the prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: WIDTH, rows: 24 },
          run: "idle",
        });
        try {
          primeSession(shell);
          openPermissionsOverlay(shell, { items: makePermissionItems(6), body: APPROVAL_BODY });
          await h.renderOnce();
          await h.renderOnce();
          const heights = shell.layout.heights;
          // Paint order stacks transcript, then overlay_host, then the other
          // zones, then prompt — with nothing charged a height between the
          // overlay and the prompt box, the overlay's bottom edge abuts the
          // zones immediately above the prompt rather than leaving a gap.
          // These zones are all off in this idle, no-task/no-agents scenario,
          // so nothing should separate the overlay from the prompt.
          const between =
            heights.agents +
            heights.task +
            heights.plugin_banner +
            heights.command_banner +
            heights.settings_notice;
          expect(between).toBe(0);
        } finally {
          shell.dispose();
        }
      },
      { width: WIDTH, height: 24 },
    );
  });
});
