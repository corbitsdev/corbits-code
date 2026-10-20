import { end, start } from "./index.js";

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
