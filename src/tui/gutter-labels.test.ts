/**
 * The transcript never labels a row with the machinery that produced it:
 * "thinking" paints an empty gutter, an accepted overlay recap carries the
 * overlay's own gutter word.
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness.js";
import { overlayKindWord } from "./overlay-body.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell, PrimaryOverlayKind } from "./shell/internals.js";
import {
  acceptOverlaySelection,
  openListOverlay,
} from "./shell/overlay-host.js";
import { streamRowGutter, type RowLayout } from "./stream.js";

// Every primary overlay kind, kept exhaustive by the satisfies bound.
const OVERLAY_KINDS = {
  permissions: true,
  operator: true,
  model_picker: true,
  add_provider: true,
  demo: true,
  palette: true,
  settings: true,
  help: true,
  plugins: true,
  resume: true,
  mentions: true,
  copy: true,
  hooks: true,
  mcp: true,
  plugin_credentials: true,
} as const satisfies Record<PrimaryOverlayKind, true>;

const CHROME_LITERALS = ["error", "plan", "report", "stop", "observe"] as const;

/** Palette and copy accept on a different path; they never echo overlayKindWord. */
const NON_ECHO_OVERLAY_KINDS = new Set<PrimaryOverlayKind>(["palette", "copy"]);

const LAYOUT: RowLayout = { width: 80, multiAgent: false };

function overlayKinds(): PrimaryOverlayKind[] {
  return Object.keys(OVERLAY_KINDS) as PrimaryOverlayKind[];
}

async function assertEchoRecap(
  open: (shell: AppShell) => void,
  word: string,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      try {
        open(shell);
        acceptOverlaySelection(shell);
        const row = shell.streamLog.at(-1);
        if (row === undefined) {
          throw new Error("expected an echo recap row");
        }
        expect(row.meta).toBe(word);
        expect(streamRowGutter(row, LAYOUT).content.trim()).toBe(word);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("transcript gutter labels", () => {
  test("thinking rows paint an empty gutter", () => {
    expect(
      streamRowGutter(
        { role: "system", text: "chain of thought", meta: "thinking" },
        LAYOUT,
      ).content,
    ).toBe("");
  });

  test.each([...CHROME_LITERALS])(
    "permitted chrome paints %s in the gutter",
    (meta) => {
      expect(
        streamRowGutter(
          { role: "system", text: "notice", meta },
          LAYOUT,
        ).content.trim(),
      ).toBe(meta);
    },
  );

  test.each(overlayKinds().filter((kind) => !NON_ECHO_OVERLAY_KINDS.has(kind)))(
    "a default-echo %s recap paints the overlay word",
    async (kind) => {
      await assertEchoRecap(
        (shell) => openListOverlay(shell, { kind, items: ["one"] }),
        overlayKindWord(kind),
      );
    },
  );
});
