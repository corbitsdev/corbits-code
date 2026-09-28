import { describe, expect, test } from "bun:test";
import { defined } from "../testkit/defined.js";
import {
  createMemoizedParseMarkdown,
  parseMarkdown,
  splitAtSettledHeading,
  withholdIncompleteHeading,
  type StyledSegment,
} from "./markdown-parser.js";
import { color } from "./semantic-theme.js";

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
    expect(firstLine("###### Deepest").every((s) => s.heading === 6)).toBe(
      true,
    );
    expect(allText(firstLine("### Deep"))).toBe("Deep");
  });
});

describe("extended inline tokens", () => {
  test("strikethrough with ~~", () => {
    expect(firstLine("~~gone~~")).toEqual([
      { text: "gone", strikethrough: true },
    ]);
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
    const body = lines.flat().find((s) => s.text.includes("const x"));
    expect(body?.code).toBe(true);
    expect(body?.text).toContain("const x = **not bold**");
    expect(lines[0]?.[0]?.text).toContain("╭");
  });

  test("highlights a fenced block by its language token", () => {
    const lines = parseMarkdown('```js\nconst x = "hi";\n```');
    const keyword = lines.flat().find((s) => s.text === "const");
    expect(keyword?.code).toBe(true);
    expect(keyword?.color).toBe(color("syntaxKeyword"));
    const str = lines.flat().find((s) => s.text === '"hi"');
    expect(str?.color).toBe(color("syntaxString"));
  });

  test("an unclosed streaming fence still highlights its body", () => {
    const lines = parseMarkdown("```js\nconst x = 1;");
    const keyword = lines.flat().find((s) => s.text === "const");
    expect(keyword?.color).toBe(color("syntaxKeyword"));
  });

  test("drops a half-typed closing fence from the streaming tail", () => {
    const lines = parseMarkdown("```js\nconst x = 1;\n``");
    const rendered = lines
      .flat()
      .map((s) => s.text)
      .join("");
    expect(rendered).not.toContain("``");
    expect(rendered).toContain("const");
  });

  test("closing fence streamed one character at a time never shrinks the block", () => {
    // The newline after the body starts a fresh, still-empty line that could
    // become the closing fence. Streaming ` then `` then ``` across it must
    // never remove a line that was already visible (a visible shrink reads as
    // flicker), only ever hold steady or grow as the fence completes.
    const base = "```js\nconst x = 1;\n";
    const steps = [base, `${base}\``, `${base}\`\``, `${base}\`\`\``];
    const lineCounts = steps.map((content) => parseMarkdown(content).length);
    for (let i = 1; i < lineCounts.length; i++) {
      expect(lineCounts[i]).toBeGreaterThanOrEqual(defined(lineCounts[i - 1]));
    }
  });

  test("blank lines inside a fenced block keep a continuous gutter", () => {
    const lines = parseMarkdown("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    // Cap, body, blank, body, foot — every non-cap/foot body row (incl. blank)
    // carries the gutter so the frame does not fragment.
    const gutterLines = lines.filter((line) =>
      line.some((s) => s.text.includes("▏")),
    );
    expect(gutterLines.length).toBeGreaterThanOrEqual(3);
    // The blank body line is not an empty segment array — it still paints ▏.
    const blankBody = lines.find(
      (line) =>
        line.length === 1 &&
        line[0]?.text === "▏ " &&
        line[0]?.codeFence === true,
    );
    expect(blankBody).toBeDefined();
    expect(lines[0]?.some((s) => s.text.includes("╭"))).toBe(true);
    expect(lines[lines.length - 1]?.some((s) => s.text.includes("╰"))).toBe(
      true,
    );
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
  test.each(["my_var_name", "path/to_file_name.txt", "foo_bar baz"])(
    "identifier-ish %s does not italicize",
    (input) => {
      const segs = firstLine(input);
      expect(allText(segs)).toBe(input);
      expect(segs.every((s) => !s.italic)).toBe(true);
    },
  );

  test.each([
    ["word _italic_ text", "word italic text", "italic"],
    [" _it_ ", " it ", "it"],
  ])("underscore italic at word boundary: %s", (input, plain, italicText) => {
    const segs = firstLine(input);
    expect(allText(segs)).toBe(plain);
    expect(segs.find((s) => s.italic)?.text).toBe(italicText);
  });

  test("star can still italicize intraword", () => {
    const segs = firstLine("my*var*name");
    expect(allText(segs)).toBe("myvarname");
    const italic = segs.find((s) => s.italic);
    expect(italic?.text).toBe("var");
  });

  test.each(["__bold__ text", "**bold** text"])(
    "bold %s is unaffected",
    (input) => {
      const segs = firstLine(input);
      expect(allText(segs)).toBe("bold text");
      expect(segs.find((s) => s.bold)?.text).toBe("bold");
    },
  );
});

describe("F2: link URL handling", () => {
  test.each([
    ["[link](http://example.com)", "link (http://example.com)"],
    ["[func](fn(arg))", "func (fn(arg))"],
    ["[api](https://api.example.com/v1)", "api (https://api.example.com/v1)"],
    [
      "[help](https://example.com?q=fn(x))",
      "help (https://example.com?q=fn(x))",
    ],
  ])("%s paints label plus URL in parens", (input, expected) => {
    expect(allText(firstLine(input))).toBe(expected);
  });

  test("very long URL is not shown in parens", () => {
    const segs = firstLine(
      "[docs](https://example.com/path/to/very/long/documentation/page)",
    );
    expect(allText(segs)).toBe("docs");
    expect(segs.find((s) => s.link)?.text).toBe("docs");
  });
});

describe("F3: GFM table relaxation", () => {
  // Relaxed separators — 1+, 2, 3+ dashes, alignment colons — all parse to a
  // header + rule + data row.
  test.each([
    ["| a | b |\n|-|-|\n| 1 | 2 |", "a"],
    ["| name | value |\n|--|--|\n| foo | bar |", "name"],
    ["| x | y |\n|---|---|\n| 1 | 2 |", "x"],
    ["| left | center | right |\n|:---|:--:|--:|\n| a | b | c |", "left"],
  ])("separator variant parses as a table: %#", (input, header) => {
    const lines = parseMarkdown(input);
    expect(lines).toHaveLength(3);
    expect(allText(lines[0] ?? [])).toContain(header);
  });

  test("escaped pipe stays inside one cell as a literal pipe", () => {
    const lines = parseMarkdown("| a | b |\n|---|---|\n| x\\|y | z |");
    expect(lines).toHaveLength(3);
    const row = allText(lines[2] ?? []);
    // The escaped pipe neither splits the cell nor leaks its backslash.
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
    const lines = parseMarkdown(
      "| Item | Status |\n| --- | --- |\n| name | **done** |",
    );
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

  test("wide multi-row table shares one column-width set and never exceeds width", () => {
    const header = "| Option | Tradeoff | Notes |\n| --- | --- | --- |\n";
    const rows = Array.from(
      { length: 10 },
      (_, i) =>
        `| ${i + 1}. Inline / native scrollback | Leave alt-screen; use terminal scrollback for history | Detail ${i + 1} |\n`,
    ).join("");
    const lines = parseMarkdown(header + rows, 80);
    const texts = lines.map(allText);
    for (const t of texts) {
      expect(t.length).toBeLessThanOrEqual(80);
    }
    expect(
      texts.some(
        (t) => t.includes("|") && !t.includes("│") && !t.includes("─"),
      ),
    ).toBe(false);

    const gridRows = texts.filter((t) => t.includes("│"));
    const patterns = new Set(
      gridRows.map((t) => {
        const pos: number[] = [];
        for (let i = 0; i < t.length; i++) if (t[i] === "│") pos.push(i);
        return pos.join(",");
      }),
    );
    expect(patterns.size).toBe(1);
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
    const lines = parseMarkdown("Name | Value\n--- | ---\nfoo | bar");
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

describe("createMemoizedParseMarkdown", () => {
  test("returns the same array reference for a repeated (text, width) call", () => {
    const memoized = createMemoizedParseMarkdown();
    const first = memoized("hello **world**", 80);
    const second = memoized("hello **world**", 80);
    expect(second).toBe(first);
  });

  test("misses on a different width even with identical text", () => {
    const memoized = createMemoizedParseMarkdown();
    const at80 = memoized("some prose", 80);
    const at40 = memoized("some prose", 40);
    expect(at40).not.toBe(at80);
    expect(at40).toEqual(parseMarkdown("some prose", 40));
  });

  test("misses on different text at the same width", () => {
    const memoized = createMemoizedParseMarkdown();
    const a = memoized("first", 80);
    const b = memoized("second", 80);
    expect(b).not.toBe(a);
  });

  test("evicts the least recently used entry once over capacity", () => {
    const memoized = createMemoizedParseMarkdown(2);
    const a = memoized("a", 80);
    const b = memoized("b", 80);
    // Touch "a" again so "b" becomes the least recently used entry.
    expect(memoized("a", 80)).toBe(a);
    const c = memoized("c", 80); // pushes cache over capacity, evicting "b"

    // "b" was evicted: same content, but a freshly parsed (non-identical) array.
    expect(memoized("b", 80)).not.toBe(b);
    // "c" is still warm — it was inserted more recently than "a", which the
    // re-fetch of "b" above evicted to make room.
    expect(memoized("c", 80)).toBe(c);
  });

  test("clear() drops every cached entry", () => {
    const memoized = createMemoizedParseMarkdown();
    const first = memoized("hello", 80);
    memoized.clear();
    const second = memoized("hello", 80);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe("withholdIncompleteHeading", () => {
  test("strips a trailing bare heading marker while streaming", () => {
    expect(withholdIncompleteHeading("hello\n####")).toBe("hello\n");
    expect(withholdIncompleteHeading("####")).toBe("");
  });

  test("keeps a heading that already has a title", () => {
    expect(withholdIncompleteHeading("hello\n#### Title")).toBe(
      "hello\n#### Title",
    );
  });
});

describe("splitAtSettledHeading", () => {
  test("freezes a heading that already has content under it", () => {
    expect(splitAtSettledHeading("# Title\nbody")).toEqual({
      frozen: "# Title",
      live: "body",
      gapRows: 0,
    });
  });

  test("does not split when the last heading is still the open tail", () => {
    expect(splitAtSettledHeading("# Title")).toBeNull();
  });
});
