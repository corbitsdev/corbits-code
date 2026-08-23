/**
 * Subtree teardown. OpenTUI frees a renderable's native TextBuffer in its own
 * `destroy()`, so dropping a subtree without recursing strands every
 * descendant's buffer until the process exits.
 */

import { describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { withTestRenderer } from "./harness";
import { appendStreamRow, createAppShell } from "./shell";
import { destroySubtree } from "./teardown";

function descendants(node: BoxRenderable): readonly TextRenderable[] {
  const found: TextRenderable[] = [];
  const walk = (current: { getChildren: () => readonly unknown[] }): void => {
    for (const child of current.getChildren()) {
      if (child instanceof TextRenderable) found.push(child);
      walk(child as { getChildren: () => readonly unknown[] });
    }
  };
  walk(node);
  return found;
}

describe("subtree teardown", () => {
  test("destroys every descendant, not just the node itself", async () => {
    await withTestRenderer(async (h) => {
      const box = new BoxRenderable(h.renderer as CliRenderer, { id: "box" });
      const inner = new BoxRenderable(h.renderer as CliRenderer, { id: "inner" });
      const leaf = new TextRenderable(h.renderer as CliRenderer, {
        id: "leaf",
        content: "leaf",
      });
      inner.add(leaf);
      box.add(inner);
      h.root.add(box);

      destroySubtree(box);

      expect(box.isDestroyed).toBe(true);
      expect(inner.isDestroyed).toBe(true);
      expect(leaf.isDestroyed).toBe(true);
    });
  });

  test("clearing the landing tears down its text rows", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, { wireKeys: false });
      await h.renderOnce();
      const landingRows = descendants(h.root as unknown as BoxRenderable);
      expect(landingRows.length).toBeGreaterThan(0);

      appendStreamRow(shell, { role: "user", text: "go" });
      await h.renderOnce();

      // A landing row is either still mounted or destroyed; anything detached
      // and undestroyed is a stranded native buffer.
      const survivors = new Set(descendants(h.root as unknown as BoxRenderable));
      const stranded = landingRows.filter((row) => !survivors.has(row) && !row.isDestroyed);
      expect(stranded.map((row) => row.id)).toEqual([]);
    });
  });
});
