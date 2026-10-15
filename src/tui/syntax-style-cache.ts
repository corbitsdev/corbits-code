import type { SyntaxStyle } from "@opentui/core";

interface GenerationStyle {
  readonly generation: number;
  readonly style: SyntaxStyle;
}

/**
 * Theme pins bump `generation` while rows and the prompt still hold the
 * previous native style. `SyntaxStyle.destroy()` frees that style and nothing
 * finalizes it, so the previous one is queued here until the caller has
 * dropped it — overwriting the cache must not free a style that is still
 * painted.
 */
export function syntaxStyleForGeneration<K extends object>(
  cache: WeakMap<K, GenerationStyle>,
  retired: WeakMap<K, SyntaxStyle[]>,
  key: K,
  generation: number,
  build: () => SyntaxStyle,
): SyntaxStyle {
  const cached = cache.get(key);
  if (cached !== undefined && cached.generation === generation) {
    return cached.style;
  }
  const style = build();
  if (cached !== undefined) {
    const pending = retired.get(key);
    if (pending === undefined) retired.set(key, [cached.style]);
    else pending.push(cached.style);
  }
  cache.set(key, { generation, style });
  return style;
}

/** Free queued styles `stillPainted` rejects. Held styles stay queued. */
export function destroyUnpaintedSyntaxStyles<K extends object>(
  retired: WeakMap<K, SyntaxStyle[]>,
  key: K,
  stillPainted: (style: SyntaxStyle) => boolean,
): void {
  const pending = retired.get(key);
  if (pending === undefined || pending.length === 0) return;
  const keep: SyntaxStyle[] = [];
  for (const style of pending) {
    if (stillPainted(style)) keep.push(style);
    else style.destroy();
  }
  if (keep.length === 0) retired.delete(key);
  else retired.set(key, keep);
}
