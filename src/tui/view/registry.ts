import type { SemanticRole } from "../semantic-theme.js";
import type { Tone } from "./spec.js";

export const GAP = 2;
export const PAD = 2;

export function toneRole(tone: Tone | undefined): SemanticRole | undefined {
  if (tone === undefined || tone === "default") return undefined;
  return tone;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
