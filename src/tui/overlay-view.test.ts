import { describe, expect, test } from "bun:test";
import { SelectRenderable, TextRenderable } from "@opentui/core";
import { withTestRenderer } from "./harness";
import { createOverlayList } from "./shell/overlay-list";
import {
  createOverlayView,
  overlayChromeRows,
  overlayMinHostRows,
  overlayRowsPerItem,
  type OverlayListPresentation,
  type OverlayTitlePresentation,
} from "./overlay-view";

const palette: OverlayListPresentation = {
  kind: "palette",
  items: ["/help", "/model", "/mcp"],
  paletteCommands: [{ label: "/help" }, { label: "/model" }, { label: "/mcp" }],
  list: null,
  bodyLines: [],
  bodyFgs: [],
  answer: null,
  describe: () => undefined,
};

/** Text rows the body paints itself; the SelectRenderable renders the list. */
function bodyRows(view: ReturnType<typeof createOverlayView>): string[] {
  return view.body
    .getChildren()
    .filter((row): row is TextRenderable => row instanceof TextRenderable)
    .map((row) => row.content.chunks.map((chunk) => chunk.text).join(""));
}

function bodySelect(view: ReturnType<typeof createOverlayView>): SelectRenderable {
  const found = view.body.getChildren().find((row) => row instanceof SelectRenderable);
  if (!(found instanceof SelectRenderable)) throw new Error("expected the overlay list");
  return found;
}

async function paletteFrame(
  width: number,
  presentation: Omit<OverlayListPresentation, "list"> = palette,
): Promise<readonly string[]> {
  return withTestRenderer(
    async (h) => {
      const view = createOverlayView(h.renderer);
      h.renderer.root.add(view.host);
      view.host.visible = true;
      view.host.height = 8;
      view.title.visible = false;
      view.paintList(
        {
          ...presentation,
          list: createOverlayList(h.renderer, {
            count: presentation.items.length,
            items: Math.max(1, presentation.items.length),
          }),
        },
        width,
      );
      await h.renderOnce();
      return h
        .captureCharFrame()
        .split("\n")
        .map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trimEnd());
    },
    { width, height: 32 },
  );
}

describe("overlay view", () => {
  test("has no leading selection marker or kind column", async () => {
    const rows = await paletteFrame(100);
    const help = rows.find((row) => row.includes("/help"));
    expect(help).toBeDefined();
    expect(help).not.toContain(">");
    expect(help).not.toContain("view");
  });

  test("ellipsizes a label that cannot fit a narrow width, never dropping it", async () => {
    const label = "/help-abcdefghijklmnopqrstuvwxyz";
    const rows = await paletteFrame(20, {
      ...palette,
      items: [label],
      paletteCommands: [{ label }],
    });
    const help = rows.find((row) => row.includes("help"));
    expect(help).toBe(" /help-abcdefghij…");
    expect(rows.some((row) => row.includes(label))).toBe(false);
  });

  test("description resolves after choices and answer paint, with absent and empty zones distinct", async () => {
    await withTestRenderer(async (h) => {
      const view = createOverlayView(h.renderer);
      h.renderer.root.add(view.host);
      const presentation: OverlayListPresentation = {
        ...palette,
        kind: "model_picker",
        items: ["first"],
        list: createOverlayList(h.renderer, { count: 1, items: 1 }),
        bodyLines: ["context"],
        answer: { text: "typed", active: true },
        describe: () => {
          expect(bodyRows(view)).toEqual([" context", " answer> typed▌"]);
          expect(bodySelect(view).getSelectedOption()?.name).toBe("first");
          return { what: "late description" };
        },
      };
      view.paintList(presentation, 80);
      expect(bodyRows(view)).toContain(" late description");
      view.paintList({ ...presentation, describe: () => null }, 80);
      expect(bodyRows(view)).toHaveLength(5);
      view.paintList({ ...presentation, describe: () => undefined }, 80);
      expect(bodyRows(view)).toEqual([" context", " answer> typed▌"]);
      view.paintList({ ...presentation, list: null }, 80);
      expect(bodyRows(view)).toEqual([]);
    });
  });

  test("title hints follow offered actions and answer ownership", async () => {
    await withTestRenderer(async (h) => {
      const view = createOverlayView(h.renderer);
      h.renderer.root.add(view.host);
      const title: OverlayTitlePresentation = {
        title: "model",
        kind: "model_picker",
        hasChoices: true,
        answer: null,
        addProviderHint: true,
        setDefaultHint: true,
        mcpManageHint: false,
        mcpAddHint: false,
      };
      view.paintTitle(title, 120);
      expect(view.title.content.chunks.map((chunk) => chunk.text).join("")).toBe(
        " model · Esc cancel · Enter choose · Alt+A /connect add provider · Alt+D set default",
      );
      view.paintTitle({ ...title, hasChoices: false }, 80);
      expect(view.title.content.chunks.map((chunk) => chunk.text).join("")).toBe(
        " model · Esc dismiss",
      );
      view.paintTitle({ ...title, answer: { active: true } }, 80);
      expect(view.title.content.chunks.map((chunk) => chunk.text).join("")).toBe(
        " model · Esc back to choices · Enter send",
      );
    });
  });

  test("intrinsic chrome charges answer and description once and palette omits title", () => {
    const chrome = overlayChromeRows("model_picker", 2, true, true);
    expect(chrome).toBe(9);
    expect(overlayChromeRows("palette", 2, true, true)).toBe(8);
    expect(overlayChromeRows("model_picker", 2, false, false)).toBe(5);
    const perItem = overlayRowsPerItem("model_picker", ["first", "second"], 80);
    expect(perItem).toBe(1);
    expect(overlayMinHostRows(chrome, perItem, true)).toBe(10);
    expect(overlayMinHostRows(chrome, perItem, false)).toBe(9);
  });
});
