/**
 * Renderable teardown.
 *
 * OpenTUI's `Renderable.destroy()` frees only the node it is called on: it
 * detaches children without destroying them, so every descendant's native
 * TextBuffer stays allocated. Any code that drops a subtree must recurse.
 */

interface Destroyable {
  readonly destroyRecursively?: () => void;
  readonly destroy?: () => void;
}

/** Destroy a renderable and everything beneath it, releasing native buffers. */
export function destroySubtree(node: unknown): void {
  const target = node as Destroyable | null | undefined;
  if (target === null || target === undefined) return;
  if (typeof target.destroyRecursively === "function") {
    target.destroyRecursively();
    return;
  }
  if (typeof target.destroy === "function") target.destroy();
}
