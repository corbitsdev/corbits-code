import { describe, expect, test } from "bun:test";
import {
  buildLines,
  buildLinesIncremental,
  buildResourceBanner,
  maxLineOffset,
  lineWindow,
} from "./event-log.js";
import type { ContentBlock } from "../use-stream.js";

const COLUMNS = 80;

function isExpanded(): boolean {
  return false;
}

// A long, multi-line shell command — the exact shape that broke scrolling: a
// `gh pr comment --body '<huge markdown>'` rendered as one block.
function bigShellBlock(lineCount: number): ContentBlock {
  const body = Array.from({ length: lineCount }, (_, i) => `review line ${i}`).join("\n");
  return {
    type: "tool_call",
    id: "shell-1",
    name: "run_shell",
    arguments: JSON.stringify({ command: `gh pr comment 57 --body '${body}'` }),
  };
}

function lineText(lines: ReturnType<typeof buildLines>): string[] {
  return lines.map((line) => line.map((segment) => segment.text).join(""));
}

function editPair(index: number): ContentBlock[] {
  const callId = `edit-${index}`;
  return [
    {
      type: "tool_call",
      id: callId,
      name: "edit_file",
      arguments: JSON.stringify({ path: `src/file-${index}.ts` }),
    },
    {
      type: "tool_result",
      id: `edit-result-${index}`,
      callId,
      name: "edit_file",
      content: `replaced 1 occurrence(s) in src/file-${index}.ts`,
      isError: false,
    },
  ];
}

describe("flat line buffer", () => {
  test("appending a block reuses the prior rendered tail", () => {
    const first: ContentBlock[] = [
      { type: "text", id: "a1", content: "First assistant reply." },
    ];
    const state1 = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded);
    const second: ContentBlock[] = [
      ...first,
      { type: "text", id: "a2", content: "Second assistant reply." },
    ];
    const state2 = buildLinesIncremental(state1, second, COLUMNS, false, isExpanded);

    expect(state2.blockRenderLineCounts.length).toBe(2);
    expect(lineText(state2.lines.slice(0, state1.lines.length))).toEqual(lineText(state1.lines));
    expect(lineText(state2.lines).join("\n")).toContain("Second assistant reply");
  });

  test("incremental line build trims to the default rendered line budget", () => {
    const blocks: ContentBlock[] = Array.from({ length: 55 }, (_, i) => ({
      ...bigShellBlock(40),
      id: `shell-${i}`,
    }));
    const maxLines = 100;

    const state = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      () => true,
      new Map(),
      undefined,
      "layout",
      maxLines,
    );

    expect(state.lines.length).toBeLessThanOrEqual(maxLines);
    expect(state.hiddenRenderedLineCount).toBeGreaterThan(0);
    expect(lineText(state.lines).join("\n")).toContain("earlier rendered lines hidden");
  });

  test("a multi-line shell command decomposes into one line per visual row", () => {
    const lines = buildLines([bigShellBlock(50)], COLUMNS, false, isExpanded);
    // Each entry is a single visual row (an array of styled segments), never a
    // monolithic block that paints taller than the viewport.
    expect(lines.length).toBeGreaterThanOrEqual(50);
    for (const line of lines) {
      expect(Array.isArray(line)).toBe(true);
    }
  });

  test("the scroll window never exceeds visibleRows for any offset", () => {
    const lines = buildLines([bigShellBlock(50)], COLUMNS, false, isExpanded);
    const visibleRows = 20;
    const maxOffset = maxLineOffset(lines, visibleRows);
    expect(maxOffset).toBe(Math.max(0, lines.length - visibleRows));

    for (let offset = -5; offset <= maxOffset + 5; offset++) {
      const { start, end } = lineWindow(lines, offset, visibleRows);
      expect(end - start).toBeLessThanOrEqual(visibleRows);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(lines.length);
    }
  });

  test("pinning to the bottom shows exactly the last visibleRows lines", () => {
    const lines = buildLines([bigShellBlock(50)], COLUMNS, false, isExpanded);
    const visibleRows = 20;
    const maxOffset = maxLineOffset(lines, visibleRows);
    const { start, end } = lineWindow(lines, maxOffset, visibleRows);
    expect(end).toBe(lines.length);
    expect(end - start).toBe(visibleRows);
  });

  test("paired tool call and result collapse to one merged line", () => {
    const blocks: ContentBlock[] = [
      {
        type: "tool_call",
        id: "call-read",
        name: "read_file",
        arguments: JSON.stringify({ path: "package.json" }),
      },
      {
        type: "tool_result",
        id: "result-read",
        callId: "call-read",
        name: "read_file",
        content: '{"scripts":{"test":"bun test"}}',
        isError: false,
      },
    ];

    expect(lineText(buildLines(blocks, COLUMNS, false, isExpanded))).toEqual(["  ● Read 1 line of package.json"]);
    expect(lineText(buildLines(blocks, COLUMNS, false, () => true)).join("\n")).toContain("scripts");
  });

  test("orphan tool result still renders on its own", () => {
    const block: ContentBlock = {
      type: "tool_result",
      id: "json-result",
      callId: "read-json",
      name: "read_file",
      content: "     1\tfoo",
      isError: false,
    };

    expect(lineText(buildLines([block], COLUMNS, false, isExpanded))).toEqual(["  Read 1 line"]);
  });

  test("consecutive file edits collapse into one group", () => {
    const blocks = [0, 1, 2, 3].flatMap(editPair);

    expect(lineText(buildLines(blocks, COLUMNS, false, isExpanded))).toEqual(["  ● Edited 4 files"]);
  });

  test("expanded file edits render individually", () => {
    const blocks = [0, 1, 2].flatMap(editPair);
    const expandedIds = new Set(["edit-1"]);
    const text = lineText(buildLines(blocks, COLUMNS, false, (block) => expandedIds.has(block.id))).join("\n");

    expect(text).toContain("Edited src/file-0.ts");
    expect(text).toContain("● Edit");
    expect(text).toContain("src/file-1.ts");
    expect(text).toContain("Edited src/file-2.ts");
    expect(text).not.toContain("Edited 3 files");
  });

  test("large user code fences are compacted in the log", () => {
    const block: ContentBlock = {
      type: "user",
      id: "user-with-code",
      content: `Please inspect @src/file.ts:\n\`\`\`ts\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\n\`\`\``,
    };

    const text = lineText(buildLines([block], COLUMNS, false, isExpanded)).join("\n");
    expect(text).toContain("[ts code block hidden: 20 lines]");
    expect(text).not.toContain("line 19");
  });

  test("tool errors strip terminal mouse and CSI control sequences", () => {
    const block: ContentBlock = {
      type: "tool_result",
      id: "mouse-error",
      callId: "shell-1",
      name: "run_shell",
      content: "failed [<0;29;35M\u001B[31m badly",
      isError: true,
    };

    const text = lineText(buildLines([block], COLUMNS, false, isExpanded)).join("\n");
    expect(text).toContain("error: failed  badly");
    expect(text).not.toContain("[<0;29;35M");
    expect(text).not.toContain("\u001B");
  });

  test("expanded tool results are bounded and tail-anchored", () => {
    const block: ContentBlock = {
      type: "tool_result",
      id: "large-result",
      callId: "shell-1",
      name: "run_shell",
      content: Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n"),
      isError: false,
    };

    const text = lineText(buildLines([block], COLUMNS, false, () => true)).join("\n");
    // Tail-anchored: the conclusion (line 249) survives alongside a small head
    // stub (lines 0-2). The early-middle (lines 3-53) is elided.
    expect(text).toContain("line 249");
    expect(text).toContain("line 0");
    expect(text).toContain("[50 more lines hidden]");
    expect(text).not.toContain("line 40");
  });

  test("cached assistant output rewraps when the terminal width changes", () => {
    const blocks: ContentBlock[] = [
      {
        type: "text",
        id: "assistant-long",
        content: "This assistant response should wrap across several rows at a narrow width but collapse when the viewport grows wider.",
      },
      {
        type: "tool_call",
        id: "keep-first-block-cacheable",
        name: "read_file",
        arguments: JSON.stringify({ path: "package.json" }),
      },
    ];
    const cache = new Map<string, ReturnType<typeof buildLines>>();

    const narrow = lineText(buildLines(blocks, 28, false, isExpanded, cache));
    const wide = lineText(buildLines(blocks, 100, false, isExpanded, cache));

    expect(wide.length).toBeLessThan(narrow.length);
    expect(wide.join("\n")).toContain("viewport grows wider");
  });

  test("text block marker counts against the wrap budget so no line overflows the column", () => {
    // A first row that fills the width: the leading " ● " marker must be
    // folded into the wrap, not prepended after it. Otherwise line 0 grows past
    // the column and spills an extra row, clipping the viewport's bottom line.
    const width = 40;
    const block: ContentBlock = { type: "text", id: "full-row", content: "x".repeat(50) };
    const lines = buildLines([block], width, false, isExpanded);
    for (const line of lines) {
      const len = line.reduce((n, s) => n + s.text.length, 0);
      expect(len).toBeLessThanOrEqual(width);
    }
  });

  test("wrapped markdown bullets use a hanging indent", () => {
    const width = 44;
    const block: ContentBlock = {
      type: "text",
      id: "wrapped-bullet",
      content: "- Added description-table detection and readable list rendering at src/tui/markdown-parser.ts:372.",
    };
    const text = lineText(buildLines([block], width, false, isExpanded));
    expect(text.length).toBeGreaterThan(1);
    expect(text[0]?.startsWith(" ● • ")).toBe(true);
    expect(text[1]?.startsWith("  ")).toBe(true);
    expect(text[1]?.startsWith("rendering")).toBe(false);
    for (const line of text) expect(line.length).toBeLessThanOrEqual(width);
  });

  test("user banner wraps within the column instead of spilling past the rail", () => {
    const width = 40;
    const block: ContentBlock = { type: "user", id: "wide-user", content: "y".repeat(120) };
    const lines = buildLines([block], width, false, isExpanded);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const len = line.reduce((n, s) => n + s.text.length, 0);
      expect(len).toBeLessThanOrEqual(width);
    }
  });

  test("buildResourceBanner lists skills and plugins, and is empty when there are none", () => {
    const banner = buildResourceBanner([{ name: "scribe" }, { name: "tdd" }], ["exa"], 80);
    const text = banner.map((line) => line.map((s) => s.text).join("")).join("\n");
    expect(text).toContain("[Skills]");
    expect(text).toContain("scribe, tdd");
    expect(text).toContain("[Plugins]");
    expect(text).toContain("exa");
    expect(buildResourceBanner([], [], 80)).toEqual([]);
  });

  const planBlock: ContentBlock = {
    type: "plan",
    id: "plan-1",
    steps: [
      { file: "src/a.ts", action: "edit" },
      { file: "src/b.ts", action: "create" },
      { file: "src/c.ts", action: "edit" },
    ],
  };

  test("plan renders all steps as grey todo circles before work starts", () => {
    const text = lineText(buildLines([planBlock], COLUMNS, false, isExpanded, undefined, {
      currentStep: null,
      deviated: false,
    }));
    expect(text).toEqual([
      "○ edit src/a.ts",
      "○ create src/b.ts",
      "○ edit src/c.ts",
    ]);
  });

  test("plan shows done checkmarks, an active circle, and remaining todo", () => {
    const text = lineText(buildLines([planBlock], COLUMNS, false, isExpanded, undefined, {
      currentStep: 1,
      deviated: false,
    }));
    expect(text).toEqual([
      "✓ edit src/a.ts",
      "◯ create src/b.ts",
      "○ edit src/c.ts",
    ]);
  });

  test("plan marks remaining steps as cancelled when deviated", () => {
    const text = lineText(buildLines([planBlock], COLUMNS, false, isExpanded, undefined, {
      currentStep: 1,
      deviated: true,
    }));
    expect(text[0]).toBe("✓ edit src/a.ts");
    expect(text[1]).toBe("◯ create src/b.ts");
    expect(text[2]).toContain("cancelled");
    expect(text[2]).toContain("edit src/c.ts");
  });
});
