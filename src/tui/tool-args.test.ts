import { describe, expect, test } from "bun:test";
import { parsePresentViewFromArgs } from "./tool-args.js";

describe("parsePresentViewFromArgs", () => {
  test("extracts view from JSON args", () => {
    const view = { type: "text", text: "hi" };
    expect(parsePresentViewFromArgs(JSON.stringify({ view }))).toEqual(view);
  });

  test("returns undefined on invalid JSON", () => {
    expect(parsePresentViewFromArgs("{")).toBeUndefined();
  });
});