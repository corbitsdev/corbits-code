import { describe, expect, test } from "bun:test";
import type { StyledSegment } from "./markdown-parser.js";
import { highlightCode } from "./syntax-highlight.js";
import { color } from "./semantic-theme.js";

function segmentFor(lines: StyledSegment[][], text: string): StyledSegment | undefined {
  return lines.flat().find((seg) => seg.text === text);
}

describe("highlightCode", () => {
  test("colours keywords, strings, and comments from the theme tokens", () => {
    const lines = highlightCode('const x = "hi"; // note', "javascript", 80);
    expect(segmentFor(lines, "const")?.color).toBe(color("syntaxKeyword"));
    expect(segmentFor(lines, '"hi"')?.color).toBe(color("syntaxString"));
    expect(segmentFor(lines, "// note")?.color).toBe(color("syntaxComment"));
  });

  test("colours numbers from the syntaxNumber token", () => {
    const lines = highlightCode("let n = 42;", "javascript", 80);
    expect(segmentFor(lines, "42")?.color).toBe(color("syntaxNumber"));
  });

  test("every highlighted segment is marked as code", () => {
    const lines = highlightCode("const x = 1;", "javascript", 80);
    for (const seg of lines.flat()) expect(seg.code).toBe(true);
  });

  test("preserves line count so wrapping stays aligned", () => {
    const code = "line one\nline two\nline three";
    expect(highlightCode(code, "javascript", 80)).toHaveLength(3);
  });

  test("decodes HTML entities back to their source characters", () => {
    const lines = highlightCode("const ok = a > b && c < d;", "javascript", 80);
    const rendered = lines
      .flat()
      .map((s) => s.text)
      .join("");
    expect(rendered).toContain(">");
    expect(rendered).toContain("<");
    expect(rendered).toContain("&&");
  });

  test("falls back to uncoloured code for an unknown language", () => {
    const lines = highlightCode("some plain text", "not-a-language", 80);
    for (const seg of lines.flat()) {
      expect(seg.code).toBe(true);
      expect(seg.color).toBeUndefined();
    }
  });

  test("falls back to uncoloured code when the language is absent", () => {
    const lines = highlightCode("plain fenced text", undefined, 80);
    expect(segmentFor(lines, "plain fenced text")?.color).toBeUndefined();
  });

  test("caches identical (text, language, width) requests", () => {
    const first = highlightCode("const cached = 1;", "javascript", 80);
    const second = highlightCode("const cached = 1;", "javascript", 80);
    expect(second).toBe(first);
  });

  test("keys the cache on width so a resize does not reuse stale output", () => {
    const narrow = highlightCode("const w = 1;", "javascript", 40);
    const wide = highlightCode("const w = 1;", "javascript", 120);
    expect(wide).not.toBe(narrow);
  });
});
