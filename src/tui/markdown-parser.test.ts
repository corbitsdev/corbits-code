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

describe("F1: italic intraword restriction", () => {
  test("snake_case identifiers should not italicize inner word", () => {
    const segs = firstLine("my_var_name");
    expect(allText(segs)).toBe("my_var_name");
    expect(segs.every((s) => !s.italic)).toBe(true);
  });

  test("underscore at word boundary opens italic", () => {
    const segs = firstLine("word _italic_ text");
    expect(allText(segs)).toBe("word italic text");
    const italic = segs.find((s) => s.italic);
    expect(italic?.text).toBe("italic");
  });

  test("underscore after whitespace and before whitespace is italic", () => {
    const segs = firstLine(" _it_ ");
    const italic = segs.find((s) => s.italic);
    expect(italic?.text).toBe("it");
  });

  test("star can still italicize intraword", () => {
    const segs = firstLine("my*var*name");
    expect(allText(segs)).toBe("myvarname");
    const italic = segs.find((s) => s.italic);
    expect(italic?.text).toBe("var");
  });

  test("bold with underscores is unaffected", () => {
    const segs = firstLine("__bold__ text");
    expect(allText(segs)).toBe("bold text");
    expect(segs.find((s) => s.bold)?.text).toBe("bold");
  });

  test("bold with stars is unaffected", () => {
    const segs = firstLine("**bold** text");
    expect(allText(segs)).toBe("bold text");
    expect(segs.find((s) => s.bold)?.text).toBe("bold");
  });

  test("file path should not italicize segments", () => {
    const segs = firstLine("path/to_file_name.txt");
    expect(allText(segs)).toBe("path/to_file_name.txt");
    expect(segs.every((s) => !s.italic)).toBe(true);
  });

  test("underscore followed by non-whitespace in identifier context", () => {
    const segs = firstLine("foo_bar baz");
    expect(allText(segs)).toBe("foo_bar baz");
    expect(segs.every((s) => !s.italic)).toBe(true);
  });
});

describe("F2: link URL handling", () => {
  test("short URL shows full URL in parens", () => {
    const segs = firstLine("[link](http://example.com)");
    expect(allText(segs)).toBe("link (http://example.com)");
  });

  test("URL with parens stops at first closing paren", () => {
    const segs = firstLine("[func](fn(arg))");
    expect(allText(segs)).toBe("func (fn(arg))");
  });

  test("very long URL is not shown in parens", () => {
    const segs = firstLine("[docs](https://example.com/path/to/very/long/documentation/page)");
    expect(allText(segs)).toBe("docs");
    expect(segs.find((s) => s.link)?.text).toBe("docs");
  });

  test("medium length URL shown in parens", () => {
    const segs = firstLine("[api](https://api.example.com/v1)");
    const text = allText(segs);
    expect(text).toContain("api");
    expect(text).toContain("https://api.example.com/v1");
  });

  test("URL with function call parens", () => {
    const segs = firstLine("[help](https://example.com?q=fn(x))");
    const text = allText(segs);
    expect(text).toContain("help");
  });
});

describe("F3: GFM table relaxation", () => {
  test("table with single dashes in separator", () => {
    const lines = parseMarkdown("| a | b |\n|-|-|\n| 1 | 2 |");
    // Header + header rule + data row.
    expect(lines).toHaveLength(3);
    expect(allText(lines[0] ?? [])).toContain("a");
    expect(allText(lines[0] ?? [])).toContain("b");
    expect(allText(lines[2] ?? [])).toContain("1");
  });

  test("table with two dashes in separator", () => {
    const lines = parseMarkdown("| name | value |\n|--|--|\n| foo | bar |");
    expect(lines).toHaveLength(3);
    expect(allText(lines[0] ?? [])).toContain("name");
  });

  test("table with default three dashes still works", () => {
    const lines = parseMarkdown("| x | y |\n|---|---|\n| 1 | 2 |");
    expect(lines).toHaveLength(3);
    expect(allText(lines[0] ?? [])).toContain("x");
  });

  test("table separator with alignment colons", () => {
    const lines = parseMarkdown("| left | center | right |\n|:---|:--:|--:|\n| a | b | c |");
    expect(lines).toHaveLength(3);
    expect(allText(lines[0] ?? [])).toContain("left");
  });

  test("cell with escaped pipe is not split into columns", () => {
    const lines = parseMarkdown("| code | desc |\n|---|---|\n| a\\|b | test |");
    expect(lines).toHaveLength(3);
    const row = allText(lines[2] ?? []);
    // The escaped pipe stays inside one cell rather than splitting it.
    expect(row).toContain("a|b");
  });

  test("escaped pipe renders as a literal pipe, not a backslash escape", () => {
    const lines = parseMarkdown("| a | b |\n|---|---|\n| x\\|y | z |");
    const row = allText(lines[2] ?? []);
    expect(row).toContain("x|y");
    expect(row).not.toContain("x\\|y");
  });

  test("trailing empty cell is preserved to match header column count", () => {
    const lines = parseMarkdown("| a | b | c |\n|---|---|---|\n| x | y | |");
    expect(lines).toHaveLength(3);
    // 3 columns render two unicode column separators in the header and data row.
    const header = allText(lines[0] ?? []);
    const dataRow = allText(lines[2] ?? []);
    expect((header.match(/│/g) ?? []).length).toBe(2);
    expect((dataRow.match(/│/g) ?? []).length).toBe(2);
  });
});

describe("multi-line", () => {
  test("a heading gains a blank line above it when it follows content", () => {
    const lines = parseMarkdown("body text\n## Section\nmore text");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual([{ text: "body text" }]);
    expect(lines[1]).toEqual([]);
    expect(lines[2]?.[0]?.heading).toBe(2);
    expect(lines[3]).toEqual([{ text: "more text" }]);
  });

  test("a leading heading gains no blank line above it", () => {
    const lines = parseMarkdown("# Title\nbody");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.[0]?.heading).toBe(1);
  });

  test("each line parses independently", () => {
    const lines = parseMarkdown("# Heading\n- item\nplain");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.every((s) => s.heading === 1)).toBe(true);
    expect(lines[1]?.[0]?.bullet).toBe(true);
    expect(lines[2]).toEqual([{ text: "plain" }]);
  });

  test("markdown tables render as aligned rows", () => {
    const lines = parseMarkdown(
      "| Game | Date | Location |\n| --- | --- | --- |\n| Game 3 | June 7 | Vegas |\n| Game 4 | June 9 | Vegas |",
    );
    // Header, header rule, then two data rows.
    expect(lines).toHaveLength(4);
    expect(allText(lines[0] ?? [])).toBe(" Game   │ Date   │ Location ");
    expect(allText(lines[1] ?? [])).toBe("────────┼────────┼──────────");
    expect(allText(lines[2] ?? [])).toBe(" Game 3 │ June 7 │ Vegas    ");
    expect(allText(lines[3] ?? [])).toBe(" Game 4 │ June 9 │ Vegas    ");
  });

  test("inline markdown inside table cells is parsed, not left literal", () => {
    const lines = parseMarkdown("| Item | Status |\n| --- | --- |\n| name | **done** |");
    for (const line of lines) {
      expect(allText(line)).not.toContain("**");
    }
    const statusCell = (lines[2] ?? []).find((s) => s.text === "done");
    expect(statusCell?.bold).toBe(true);
  });

  test("table within width renders aligned grid, no row exceeds width", () => {
    const lines = parseMarkdown(
      "| Game | Date | Location |\n| --- | --- | --- |\n| Game 3 | June 7 | Vegas |",
      40,
    );
    for (const line of lines) {
      expect(allText(line).length).toBeLessThanOrEqual(40);
    }
    expect(allText(lines[0] ?? [])).toContain("│");
  });

  test("wide table shrinks columns proportionally to fit the budget", () => {
    const wide =
      "| Suggestion | Status |\n| --- | --- |\n" +
      "| this is a fairly long suggestion cell that needs wrapping | fixed it |";
    const lines = parseMarkdown(wide, 40);
    for (const line of lines) {
      expect(allText(line).length).toBeLessThanOrEqual(40);
    }
    // Header + header rule already account for 2 lines, so a wrapped data row
    // pushes the count past 3.
    expect(lines.length).toBeGreaterThan(3);
  });

  test("wide descriptor table renders as readable entries", () => {
    const table =
      "ID | Role\n" +
      "greybeard | Seasoned engineer review of product, architecture, and implementation docs\n" +
      "critique | Critical code reviewer - tests assumptions, reports quality issues, doesn't fix";
    const lines = parseMarkdown(table, 56);
    const texts = lines.map(allText);
    expect(texts).toEqual([
      "greybeard - Seasoned engineer review of product, architecture, and implementation docs",
      "",
      "critique - Critical code reviewer - tests assumptions, reports quality issues, doesn't fix",
    ]);
    expect(lines[0]?.[0]?.bold).toBe(true);
  });

  test("table too narrow to shrink falls back to stacked key-value lines", () => {
    const wide =
      "| Suggestion | Status |\n| --- | --- |\n" +
      "| an imprecise display label | needs a clearer name |";
    const lines = parseMarkdown(wide, 14);
    const texts = lines.map(allText);
    expect(texts.some((t) => t.startsWith("Suggestion: "))).toBe(true);
    expect(texts.some((t) => t.startsWith("Status: "))).toBe(true);
  });
});

describe("borderless pipe tables the model emits", () => {
  test("no border pipes and no separator row still aligns into a grid", () => {
    const lines = parseMarkdown(
      "Word | What it means\nDeploy | Register a recipe\nStart | Run it once",
    );
    // Header, header rule, then two data rows.
    expect(lines).toHaveLength(4);
    expect(allText(lines[0] ?? []).trim()).toBe("Word   │ What it means");
    expect(allText(lines[2] ?? []).trim()).toBe("Deploy │ Register a recipe");
    expect(allText(lines[3] ?? []).trim()).toBe("Start  │ Run it once");
  });

  test("borderless table with a separator row drops the separator", () => {
    const lines = parseMarkdown(
      "Name | Value\n--- | ---\nfoo | bar",
    );
    expect(lines).toHaveLength(3);
    expect(allText(lines[0] ?? []).trim()).toBe("Name │ Value");
    expect(allText(lines[2] ?? []).trim()).toBe("foo  │ bar");
  });

  test("inline markdown inside borderless cells is parsed", () => {
    const lines = parseMarkdown("Item | Status\nname | **done**");
    for (const line of lines) expect(allText(line)).not.toContain("**");
    const cell = (lines[2] ?? []).find((s) => s.text === "done");
    expect(cell?.bold).toBe(true);
  });

  test("a single pipe line in prose is not treated as a table", () => {
    const lines = parseMarkdown("run ls | grep foo to filter");
    expect(lines).toHaveLength(1);
    expect(allText(lines[0] ?? [])).toBe("run ls | grep foo to filter");
  });

  test("a logical-or expression across lines is not a table", () => {
    const lines = parseMarkdown("if a || b\nthen c || d");
    expect(lines).toHaveLength(2);
    expect(allText(lines[0] ?? [])).toBe("if a || b");
  });
});

test("link with an empty URL still renders as styled text, not raw characters", () => {
  const lines = parseMarkdown("see [docs]() here");
  const segs = lines[0] ?? [];
  const link = segs.find((s) => s.link === true);
  expect(link?.text).toBe("docs");
  // No "(...)" suffix for an empty URL, and the text is not split char-by-char.
  expect(segs.some((s) => s.text.includes("("))).toBe(false);
});
