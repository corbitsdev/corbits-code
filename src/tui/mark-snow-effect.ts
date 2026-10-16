/**
 * Landing snow as a post-process. The mountain stays in the text nodes;
 * flakes are drawn into the frame buffer so idle drift does not rebuild
 * the mark on a timer.
 */
import { RGBA, type CliRenderer, type OptimizedBuffer } from "@opentui/core";

import type { LandingAbove } from "./landing.js";
import { isMarkSnowflake, SNOW_CHAR } from "./mark-raster.js";
import { UI } from "./theme.js";

export interface MarkSnowEffect {
  /** Draw flakes only while the mountain is holding its filled frame. */
  setActive(active: boolean): void;
  stop(): void;
}

export function attachMarkSnow(
  renderer: CliRenderer,
  above: () => LandingAbove | null,
): MarkSnowEffect {
  let active = false;
  let seconds = 0;
  const fg = RGBA.fromHex(UI.textFaint);
  const bg = RGBA.fromHex(UI.ground);
  const apply = (buffer: OptimizedBuffer, deltaTime: number): void => {
    if (!active) return;
    const mark = above();
    const grid = mark?.grid ?? null;
    if (mark === null || grid === null) return;
    if (deltaTime > 0) seconds += deltaTime / 1000;
    const offset = mark.markRows.length - grid.rows;
    for (let index = 0; index < mark.markRows.length; index++) {
      const line = mark.markRows[index];
      if (line === undefined || !line.visible) continue;
      const row = index - offset;
      if (row < 0 || row >= grid.rows) continue;
      const y = line.y;
      const x = line.x;
      if (y < 0 || y >= buffer.height || x >= buffer.width) continue;
      const coverage = grid.coverage[row];
      for (let col = 0; col < grid.cols; col++) {
        if ((coverage?.[col] ?? 0) !== 0) continue;
        const cellX = x + col;
        if (cellX < 0 || cellX >= buffer.width) continue;
        if (!isMarkSnowflake(row, col, seconds, grid.rows)) continue;
        buffer.setCell(cellX, y, SNOW_CHAR, fg, bg);
      }
    }
  };
  renderer.addPostProcessFn(apply);
  return {
    setActive(next: boolean): void {
      active = next;
    },
    stop(): void {
      active = false;
      try {
        renderer.removePostProcessFn(apply);
      } catch {
        // Renderer already destroyed.
      }
    },
  };
}
