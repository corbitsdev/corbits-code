/**
 * Decision overlays paint bare, single-line choice rows. Labels carry no
 * consequence text — scope hints paint in the body above the list and ride
 * the expand dump — so nothing ever ellipsizes inside a choice, and the fixed
 * two-row budget (label row + row of air) always matches what the list paints.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { SelectRenderable } from "@opentui/core";
import type { PermissionRequest } from "../permission/types.js";
import { withTestRenderer } from "./harness";
import { createAppShell } from "./shell/index.js";
import { toggleOverlayExpand } from "./shell/overlay-list.js";
import { createOverlayList } from "./shell/overlay-list";
import { wireGates } from "./gate-wire.js";
import { DECISION_CHOICE_ROWS } from "./overlay-body";
import {
  createOverlayView,
  overlayRowsPerItem,
  type OverlayListPresentation,
} from "./overlay-view";

const HINT = "runs rm -rf in the workspace root without asking again";

const hintRequest: PermissionRequest = {
  tool: "run_shell",
  action: "Run shell command",
  subject: 'git commit -m "line one\nline two\nline three"',
  scopes: [
    {
      id: "always",
      label: "Allow always",
      pattern: "rm -rf *",
      hint: HINT,
    },
  ],
};

function bodySelect(view: ReturnType<typeof createOverlayView>): SelectRenderable {
  const found = view.body.getChildren().find((row) => row instanceof SelectRenderable);
  if (!(found instanceof SelectRenderable)) throw new Error("expected the overlay list");
  return found;
}

describe("decision choice rendering", () => {
  test("choices paint bare names with no ellipsis and the budget matches the pair", async () => {
    await withTestRenderer(async (h) => {
      const contentWidth = 60;
      const list = createOverlayList(h.renderer, { count: 1, items: 4 });
      const view = createOverlayView(h.renderer);
      h.renderer.root.add(view.host);
      view.host.visible = true;
      view.paintList(
        {
          kind: "permissions",
          items: ["Reject", "Accept once", "Allow always"],
          paletteCommands: [],
          list,
          bodyLines: [],
          bodyFgs: [],
          answer: null,
          describe: () => undefined,
        } satisfies Omit<OverlayListPresentation, "list"> & { list: typeof list },
        contentWidth,
      );

      const select = bodySelect(view);
      expect(select.options.map((option) => option.name)).toEqual([
        "Reject",
        "Accept once",
        "Allow always",
      ]);
      for (const option of select.options) {
        expect(option.description).toBe("");
        expect(option.name.endsWith("…")).toBe(false);
      }

      // Reserved rows equal painted rows: the pair, not a growing budget.
      const perItem = overlayRowsPerItem("permissions");
      expect(perItem).toBe(DECISION_CHOICE_ROWS);
      expect(select.height).toBe(list.height * perItem);
    });
  });

  test("hint text renders above the list and is included in the expand dump", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      emitter.emit("permission.gate", {
        request: hintRequest,
        resolve: () => {},
      });

      try {
        // Choices are bare action names.
        expect(shell.overlayItems).toEqual(["Reject", "Accept once", "Allow always"]);

        // The scope hint paints as a body message above the choice list.
        const bodyText = shell.overlayBodyLines.join("\n");
        expect(bodyText).toContain("Allow always:");
        expect(bodyText).toContain("without asking again");

        // The expand key dumps the body — hint included — to the transcript.
        expect(toggleOverlayExpand(shell)).toBe(true);
        const dump = shell.streamLog.at(-1);
        expect(dump?.role).toBe("system");
        expect(dump?.text).toContain(`Allow always: ${HINT}`);
      } finally {
        dispose();
        shell.dispose();
      }
    });
  });
});
