import { test, expect, describe } from "bun:test";
import { unwrapToolContent } from "../../src/mcp/client.js";

// CL-1693 / N1: the MCP content-array envelope is removed at the client boundary,
// so the TUI formatter (formatMcpResult / extractMcpRecords) only ever sees plain
// text or JSON, never the {content:[{type,text}]} wrapper. These pin that.
describe("unwrapToolContent", () => {
  test("empty or non-array content becomes an empty string", () => {
    expect(unwrapToolContent([])).toBe("");
    expect(unwrapToolContent(undefined)).toBe("");
    expect(unwrapToolContent(null)).toBe("");
    expect(unwrapToolContent({ type: "text", text: "x" })).toBe("");
  });

  test("a single text block contributes its text", () => {
    expect(unwrapToolContent([{ type: "text", text: "hello" }])).toBe("hello");
  });

  test("multiple text blocks are newline-joined", () => {
    expect(unwrapToolContent([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])).toBe("a\nb");
  });

  test("a non-text block is stringified rather than dropped or undefined", () => {
    const image = { type: "image", data: "base64", mimeType: "image/png" };
    expect(unwrapToolContent([image])).toBe(JSON.stringify(image));
  });

  test("mixed text and non-text blocks are both preserved", () => {
    const out = unwrapToolContent([
      { type: "text", text: "caption" },
      { type: "image", data: "b64" },
    ]);
    expect(out).toBe(`caption\n${JSON.stringify({ type: "image", data: "b64" })}`);
  });

  test("a text block with a missing text field yields an empty segment, not 'undefined'", () => {
    expect(unwrapToolContent([{ type: "text" }])).toBe("");
  });
});
