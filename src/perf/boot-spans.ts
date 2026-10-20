import { end, start } from "./index.js";

/**
 * Brackets process boot through first paint. Config I/O sits inside the
 * spans; schema work that used to run at import stays outside them until a
 * value is actually read.
 */
let bootId: string | undefined;
let firstPaintId: string | undefined;

export function startBootSpans(): void {
  if (bootId !== undefined) return;
  bootId = start("boot");
  firstPaintId = start("first-paint");
}

export function endBootSpans(): void {
  if (bootId !== undefined) {
    end(bootId);
    bootId = undefined;
  }
  if (firstPaintId !== undefined) {
    end(firstPaintId);
    firstPaintId = undefined;
  }
}
