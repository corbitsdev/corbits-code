import { describe, expect, test } from "bun:test";
import { parseMarkdown, type StyledSegment } from "./markdown-parser.js";

function firstLine(text: string): StyledSegment[] {
  return parseMarkdown(text)[0] ?? [];
}

function allText(segments: StyledSegment[]): string {
  return segments.map((s) => s.text).join("");
}

function noSyntaxChars(segments: StyledSegment[]): void {
  for (const seg of segments) {
    // The bullet glyph is allowed; raw markdown markers are not.
    const stripped = seg.text.replace(/•/g, "");
    expect(stripped).not.toMatch(/[#`]/);
    expect(stripped).not.toMatch(/\*\*|__/);
  }
}

describe("inline tokens", () => {
  test("bold with ** and __", () => {
    expect(firstLine("**bold**")).toEqual([{ text: "bold", bold: true }]);
    expect(firstLine("__bold__")).toEqual([{ text: "bold", bold: true }]);
  });

  test("italic with * and _", () => {
    expect(firstLine("*it*")).toEqual([{ text: "it", italic: true }]);
    expect(firstLine("_it_")).toEqual([{ text: "it", italic: true }]);
  });

  test("inline code", () => {
    expect(firstLine("`code`")).toEqual([{ text: "code", code: true }]);
  });

  test("plain text passes through", () => {
    expect(firstLine("just words")).toEqual([{ text: "just words" }]);
  });
});

describe("headings", () => {
  test("h1 strips marker and flags every segment", () => {
    const segs = firstLine("# Title");
    expect(allText(segs)).toBe("Title");
    expect(segs.every((s) => s.heading === 1)).toBe(true);
    noSyntaxChars(segs);
  });

  test("h2 strips marker and flags every segment", () => {
    const segs = firstLine("## Subtitle");
    expect(allText(segs)).toBe("Subtitle");
    expect(segs.every((s) => s.heading === 2)).toBe(true);
    noSyntaxChars(segs);
  });

  test("heading with inline bold keeps both flags", () => {
    const segs = firstLine("# Title with **bold**");
    expect(allText(segs)).toBe("Title with bold");
    expect(segs.every((s) => s.heading === 1)).toBe(true);
    const boldSeg = segs.find((s) => s.bold);
    expect(boldSeg?.text).toBe("bold");
    noSyntaxChars(segs);
  });

  test("h3 through h6 are headings at their level", () => {
    expect(firstLine("### Deep").every((s) => s.heading === 3)).toBe(true);
    expect(firstLine("###### Deepest").every((s) => s.heading === 6)).toBe(true);
    expect(allText(firstLine("### Deep"))).toBe("Deep");
  });
});

describe("extended inline tokens", () => {
  test("strikethrough with ~~", () => {
    expect(firstLine("~~gone~~")).toEqual([{ text: "gone", strikethrough: true }]);
  });

  test("link shows text and url, drops the brackets", () => {
    const segs = firstLine("see [docs](https://x.dev)");
    expect(allText(segs)).toBe("see docs (https://x.dev)");
    expect(segs.find((s) => s.link)?.text).toBe("docs");
    noSyntaxChars(segs);
  });
});

describe("block elements", () => {
  test("ordered list keeps the number and flags content", () => {
    const segs = firstLine("1. first");
    expect(segs[0]?.text).toBe("1. ");
    expect(allText(segs)).toBe("1. first");
    expect(segs.every((s) => s.bullet === true)).toBe(true);
  });

  test("blockquote gets a bar marker", () => {
    const segs = firstLine("> quoted");
    expect(segs[0]?.text).toBe("│ ");
    expect(segs.every((s) => s.blockquote === true)).toBe(true);
    expect(allText(segs)).toBe("│ quoted");
  });

  test("horizontal rule renders a rule glyph", () => {
    const segs = firstLine("---");
    expect(segs).toHaveLength(1);
    expect(segs[0]?.rule).toBe(true);
    expect(segs[0]?.text).not.toContain("-");
  });

  test("fenced code block renders inner lines as code without inline parsing", () => {
    const lines = parseMarkdown("```\nconst x = **not bold**\n```");
    // Opening and closing fences become blank separator lines.
    expect(lines[0]).toEqual([]);
    expect(lines[2]).toEqual([]);
    expect(lines[1]).toEqual([{ text: "const x = **not bold**", code: true }]);
  });
});

describe("bullets", () => {
  test("dash bullet sets marker and bullet flag", () => {
    const segs = firstLine("- item");
    expect(segs[0]?.text).toBe("• ");
    expect(segs[0]?.bullet).toBe(true);
    expect(allText(segs)).toBe("• item");
    expect(segs.every((s) => s.bullet === true)).toBe(true);
    noSyntaxChars(segs);
  });

  test("star bullet sets marker and bullet flag", () => {
    const segs = firstLine("* item");
    expect(segs[0]?.text).toBe("• ");
    expect(segs.every((s) => s.bullet === true)).toBe(true);
    noSyntaxChars(segs);
  });

  test("indented bullet preserves indent in marker", () => {
    const segs = firstLine("  - nested");
    expect(segs[0]?.text).toBe("  • ");
  });

  test("bullet with inline code keeps both flags", () => {
    const segs = firstLine("- run `bun test`");
    expect(allText(segs)).toBe("• run bun test");
    const codeSeg = segs.find((s) => s.code);
    expect(codeSeg?.text).toBe("bun test");
    expect(codeSeg?.bullet).toBe(true);
    noSyntaxChars(segs);
  });
});

describe("mixed inline content", () => {
  test("bold, italic, and code on one line", () => {
    const segs = firstLine("**b** and *i* and `c`");
    expect(allText(segs)).toBe("b and i and c");
    expect(segs.find((s) => s.bold)?.text).toBe("b");
    expect(segs.find((s) => s.italic)?.text).toBe("i");
    expect(segs.find((s) => s.code)?.text).toBe("c");
    noSyntaxChars(segs);
  });
});

describe("multi-line", () => {
  test("each line parses independently", () => {
    const lines = parseMarkdown("# Heading\n- item\nplain");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.every((s) => s.heading === 1)).toBe(true);
    expect(lines[1]?.[0]?.bullet).toBe(true);
    expect(lines[2]).toEqual([{ text: "plain" }]);
  });
});
