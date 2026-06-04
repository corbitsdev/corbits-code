import { fmt } from "./format.js";

export function cartLine(name: string, cents: number): string {
  return `${name}: ${fmt(cents)}`;
}

export function cartTotal(cents: number): string {
  return `Total ${fmt(cents)}`;
}
