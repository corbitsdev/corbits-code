import { describe, expect, test } from "bun:test";
import { unwrapToolContent } from "./client.js";

describe("unwrapToolContent", () => {
  test("returns empty string for empty or non-array content", () => {
    expect(unwrapToolContent([])).toBe("");
    expect(unwrapToolContent(null)).toBe("");
    expect(unwrapToolContent("not-array")).toBe("");
  });

  test("newline-joins text blocks, with a missing text field joining as empty", () => {
    expect(unwrapToolContent([{ type: "text", text: "hello" }])).toBe("hello");
    expect(
      unwrapToolContent([
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ]),
    ).toBe("line1\nline2");
    expect(
      unwrapToolContent([
        { type: "text", text: "a" },
        { type: "text" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n\nb");
  });

  test("stringifies non-text blocks, with or without sibling text", () => {
    expect(unwrapToolContent([{ type: "image", data: "abc123" }])).toBe(
      JSON.stringify({ type: "image", data: "abc123" }),
    );
    const result = unwrapToolContent([
      { type: "text", text: "hello" },
      { type: "image", data: "img" },
    ]);
    expect(result).toContain("hello");
    expect(result).toContain("image");
  });
});
