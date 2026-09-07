/**
 * Regression: decision overlays fold each choice into the fixed name +
 * description pair SelectRenderable paints. A description longer than that
 * one row must end in an ellipsis, and the reserved row budget must equal the
 * painted rows so no blank band trails the list.
 */
import { describe, expect, test } from "bun:test";
import { SelectRenderable } from "@opentui/core";
import { withTestRenderer } from "./harness";
import { createOverlayList } from "./shell/overlay-list";
import { DECISION_CHOICE_ROWS } from "./overlay-body";
import {
  createOverlayView,
  overlayRowsPerItem,
  type OverlayListPresentation,
} from "./overlay-view";

const LONG_CHOICE =
  "Allow bash(rm -rf build) in the workspace root always (deletes generated output before the next build starts and cannot be undone)";

function bodySelect(view: ReturnType<typeof createOverlayView>): SelectRenderable {
  const found = view.body.getChildren().find((row) => row instanceof SelectRenderable);
  if (!(found instanceof SelectRenderable)) throw new Error("expected the overlay list");
  return found;
}

describe("decision truncation visibility", () => {
  test("a 3-line wrap clips with an ellipsis and the budget matches painted rows", async () => {
    await withTestRenderer(async (h) => {
      const contentWidth = 60;
      const list = createOverlayList(h.renderer, { count: 1, items: 4 });
      const view = createOverlayView(h.renderer);
      h.renderer.root.add(view.host);
      view.host.visible = true;
      view.paintList(
        {
          kind: "permissions",
          items: [LONG_CHOICE],
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
      const description = select.options[0]?.description ?? "";
      expect(description.length).toBeGreaterThan(0);
      expect(description.endsWith("…")).toBe(true);
      // The full wrap is longer than what the description row shows.
      expect(description.length).toBeLessThan(LONG_CHOICE.length);

      // Reserved rows equal painted rows: the pair, not a growing budget.
      const perItem = overlayRowsPerItem("permissions");
      expect(perItem).toBe(DECISION_CHOICE_ROWS);
      expect(select.height).toBe(list.height * perItem);
    });
  });

  test("a short choice does not grow an ellipsis", async () => {
    await withTestRenderer(async (h) => {
      const contentWidth = 80;
      const list = createOverlayList(h.renderer, { count: 1, items: 4 });
      const view = createOverlayView(h.renderer);
      h.renderer.root.add(view.host);
      view.host.visible = true;
      view.paintList(
        {
          kind: "permissions",
          items: ["Allow once"],
          paletteCommands: [],
          list,
          bodyLines: [],
          bodyFgs: [],
          answer: null,
          describe: () => undefined,
        } satisfies Omit<OverlayListPresentation, "list"> & { list: typeof list },
        contentWidth,
      );
      expect(bodySelect(view).options[0]?.description).toBe("");
    });
  });
});
