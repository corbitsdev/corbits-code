import type { PluginOrigin } from "../trust/project-trust.js";

/**
 * Inline marker for a bundled (origin "repo") Corbits plugin row. The brand
 * mark itself is a multi-cell canvas silhouette (`tui/mark-shape.ts`), not a
 * single text glyph, and `●` already means live work in chrome state — so
 * rows use the mountain the issue asks for.
 */
export const BUNDLED_PLUGIN_MARKER = "⛰";

/** Short marker naming a plugin row's discovery origin for list display. */
export function pluginOriginMarker(origin: PluginOrigin | undefined): string {
  if (origin === undefined) return "";
  return origin === "repo" ? BUNDLED_PLUGIN_MARKER : `[${origin}]`;
}

/** Append the origin marker to a row label, leaving unmarked labels alone. */
export function withOriginMarker(
  label: string,
  origin: PluginOrigin | undefined,
): string {
  const marker = pluginOriginMarker(origin);
  return marker === "" ? label : `${label} ${marker}`;
}
