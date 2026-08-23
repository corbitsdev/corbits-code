import { describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable, type KeyEvent } from "@opentui/core";
import { createHarness, withTestRenderer } from "./harness.js";

describe("withTestRenderer", () => {
  test("creates renderer, paints Text/Box, destroys without throw", async () => {
    await withTestRenderer(
      async (h) => {
        const box = new BoxRenderable(h.renderer, {
          id: "shell",
          width: "100%",
          height: "100%",
        });
        box.add(
          new TextRenderable(h.renderer, {
            content: "hello-harness",
            fg: "#7aa2f7",
          }),
        );
        h.root.add(box);
        await h.renderOnce();
        const frame = h.captureCharFrame();
        expect(frame).toContain("hello-harness");
      },
      { width: 40, height: 10 },
    );
  });

  test("pressKey Enter / Alt+Enter / Ctrl+C shapes", async () => {
    await withTestRenderer(async (h) => {
      const captured: KeyEvent[] = [];
      h.renderer.keyInput.on("keypress", (key: KeyEvent) => {
        captured.push(key);
      });

      h.pressKey("Enter");
      await h.renderOnce();
      const enter = captured.at(-1);
      expect(enter).toBeDefined();
      expect(enter!.name === "return" || enter!.name === "enter").toBe(true);
      expect(enter!.ctrl).toBe(false);
      expect(enter!.meta).toBe(false);

      h.pressKey("Alt+Enter");
      await h.renderOnce();
      const altEnter = captured.at(-1);
      expect(altEnter).toBeDefined();
      expect(altEnter!.name === "return" || altEnter!.name === "enter").toBe(true);
      expect(altEnter!.meta === true || altEnter!.option === true).toBe(true);

      h.pressKey("Ctrl+C");
      await h.renderOnce();
      const ctrlC = captured.at(-1);
      expect(ctrlC).toBeDefined();
      expect(ctrlC!.name).toBe("c");
      expect(ctrlC!.ctrl).toBe(true);
    });
  });
});

describe("createHarness", () => {
  test("caller destroy cleans up", async () => {
    const h = await createHarness({ width: 20, height: 8 });
    try {
      await h.renderOnce();
      expect(typeof h.captureCharFrame()).toBe("string");
      expect(h.root).toBe(h.renderer.root);
    } finally {
      h.destroy();
    }
  });
});
