import { describe, expect, test } from "bun:test";
import {
  blockIdsInLineRange,
  buildLines,
  buildLinesIncremental,
  buildResourceBanner,
  capViewportToolIds,
  DEFAULT_MAX_RENDERED_LOG_LINES,
  DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS,
  maxLineOffset,
  lineWindow,
  resolveViewportExpandIds,
  RUNNING_ELAPSED_RESERVE,
  viewportToolIds,
} from "./event-log.js";
import { formatElapsed } from "./in-flight-indicator.js";
import type { ContentBlock, ContentBlockData } from "../use-stream.js";

function asBlock(data: ContentBlockData & { id: string }): ContentBlock {
  return data as ContentBlock;
}

function toolCallBlock(id: string, name: string, args: string, callId = id): ContentBlock {
  return asBlock({ type: "tool_call", id, callId, name, arguments: args, startedAt: 0 });
}

function toolResultBlock(id: string, callId: string, name: string, content: string, isError = false): ContentBlock {
  return asBlock({ type: "tool_result", id, callId, name, content, isError, finishedAt: 1_000 });
}

const COLUMNS = 80;

function isExpanded(): boolean {
  return false;
}

// A long, multi-line shell command — the exact shape that broke scrolling: a
// `gh pr comment --body '<huge markdown>'` rendered as one block.
function bigShellBlock(lineCount: number): ContentBlock {
  const body = Array.from({ length: lineCount }, (_, i) => `review line ${i}`).join("\n");
  return toolCallBlock("shell-1", "run_shell", JSON.stringify({ command: `gh pr comment 57 --body '${body}'` }));
}

function lineText(lines: ReturnType<typeof buildLines>): string[] {
  return lines.map((line) => line.map((segment) => segment.text).join(""));
}

function editPair(index: number): ContentBlock[] {
  const callId = `edit-${index}`;
  return [
    toolCallBlock(callId, "edit_file", JSON.stringify({ path: `src/file-${index}.ts` }), callId),
    toolResultBlock(`edit-result-${index}`, callId, "edit_file", `replaced 1 occurrence(s) in src/file-${index}.ts`),
  ];
}

describe("collapsed shell rows", () => {
  test("a long multi-line command is clamped with a more-lines marker", () => {
    const lines = lineText(buildLines([bigShellBlock(40)], COLUMNS, false, isExpanded));
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toStartWith("  $ ");
    expect(lines[lines.length - 1]).toMatch(/\+\d+ more lines/);
  });

  test("a merged call+result keeps the clamp and appends the outcome arrow", () => {
    const call = bigShellBlock(40);
    const blocks: ContentBlock[] = [
      call,
      { type: "tool_result", id: "r1", callId: "shell-1", name: "run_shell", content: "done", isError: false },
    ];
    const lines = lineText(buildLines(blocks, COLUMNS, false, isExpanded));
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[lines.length - 1]).toContain("→ done");
  });

  test("a short command renders in full with no marker", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_call", id: "s2", name: "run_shell", arguments: JSON.stringify({ command: "ls -la" }) },
    ];
    const lines = lineText(buildLines(blocks, COLUMNS, false, isExpanded));
    // The spinner and elapsed clock are painted live by the running-row
    // component, so the baked line carries only the command text.
    expect(lines).toEqual(["  $ ls -la"]);
  });

  test("pending shell marks the running row and completed shell shows duration", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "s3",
      callId: "s3",
      name: "run_shell",
      arguments: JSON.stringify({ command: "echo hi" }),
      startedAt: 1_000,
    };
    const pendingLines = buildLines([call], COLUMNS, false, isExpanded);
    const pending = lineText(pendingLines).join("\n");
    expect(pending).not.toContain("running");
    expect(pending).toContain("$ echo hi");
    expect(pendingLines[0]?.[0]?.toolRunningSince).toBe(1_000);

    const done: ContentBlock[] = [
      call,
      {
        type: "tool_result",
        id: "r3",
        callId: "s3",
        name: "run_shell",
        content: "hi\n",
        isError: false,
        finishedAt: 3_500,
      },
    ];
    const finished = lineText(buildLines(done, COLUMNS, false, isExpanded)).join("\n");
    expect(finished).not.toContain("running");
    expect(finished).toContain("· 2.5s");
    expect(finished).toContain("→ hi");
  });
});

describe("pending tool row width budget", () => {
  test("a wide pending tool row reserves width for the live elapsed suffix", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "wide",
      callId: "wide",
      name: "read_file",
      arguments: JSON.stringify({ path: `/tmp/${"d".repeat(200)}.ts` }),
      startedAt: 1_000,
    };
    const pendingLines = buildLines([call], COLUMNS, false, isExpanded);
    const maxWidth = Math.max(...pendingLines.map((line) => line.reduce((n, s) => n + s.text.length, 0)));
    // RunningToolRow appends ` · <elapsed>` after these baked lines, so the wrap
    // budget must leave room for the longest short-form clock (` · 59m 59s`).
    expect(maxWidth).toBeLessThanOrEqual(COLUMNS - " · 59m 59s".length);
  });

  test("the reserve covers the appended clock past an hour of runtime", () => {
    // The wrap budget is shrunk by RUNNING_ELAPSED_RESERVE; the live clock the
    // running row appends must always fit inside it, including the hour form
    // (` · 1h 5m 3s` and longer) so a long-running tool never reflows the log.
    for (const hours of [1, 2, 23]) {
      const clock = ` · ${formatElapsed(hours * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000)}`;
      expect(clock.length).toBeLessThanOrEqual(RUNNING_ELAPSED_RESERVE);
    }
  });

  test("a completed tool row is free to fill the full width", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "wide-done",
      callId: "wide-done",
      name: "read_file",
      arguments: JSON.stringify({ path: `/tmp/${"d".repeat(200)}.ts` }),
      startedAt: 1_000,
    };
    const result: ContentBlock = {
      type: "tool_result",
      id: "wide-done-r",
      callId: "wide-done",
      name: "read_file",
      content: "x",
      isError: false,
      finishedAt: 1_500,
    };
    const doneLines = buildLines([call, result], COLUMNS, false, isExpanded);
    const maxWidth = Math.max(...doneLines.map((line) => line.reduce((n, s) => n + s.text.length, 0)));
    // No elapsed clock is appended once complete, so the full column is available;
    // the pending reserve must not have shrunk the completed wrap budget too.
    expect(maxWidth).toBeGreaterThan(COLUMNS - " · 59m 59s".length);
  });
});

describe("tool row backgrounds", () => {
  // CL-3471: collapsed tool rows rely on semantic text/icons only — no status wash.
  function segmentBackgrounds(lines: ReturnType<typeof buildLines>): Array<string | undefined> {
    return lines.flatMap((line) => line.map((seg) => seg.backgroundColor));
  }

  test("a pending tool row has no status wash", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "run1",
      callId: "run1",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/foo.ts" }),
      startedAt: 0,
    };
    const lines = buildLines([call], COLUMNS, false, isExpanded);
    const backgrounds = segmentBackgrounds(lines);
    expect(backgrounds.every((bg) => bg === undefined)).toBe(true);
  });

  test("a completed successful tool row has no status wash", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "bg1",
      callId: "bg1",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/foo.ts" }),
      startedAt: 0,
    };

    const lines = buildLines(
      [
        call,
        {
          type: "tool_result",
          id: "bg1-r",
          callId: "bg1",
          name: "read_file",
          content: "export const x = 1;\n",
          isError: false,
          finishedAt: 100,
        },
      ],
      COLUMNS,
      false,
      isExpanded,
    );
    const backgrounds = segmentBackgrounds(lines);
    expect(backgrounds.every((bg) => bg === undefined)).toBe(true);
  });

  test("error tool results keep danger text and have no status wash", () => {
    const lines = buildLines(
      [
        {
          type: "tool_result",
          id: "err1",
          callId: "err1",
          name: "run_shell",
          content: "permission denied",
          isError: true,
          finishedAt: 1,
        },
      ],
      COLUMNS,
      false,
      isExpanded,
    );
    const segs = lines.flat();
    expect(segs.every((seg) => seg.backgroundColor === undefined)).toBe(true);
    expect(segs.some((seg) => seg.color !== undefined && seg.text.includes("error:"))).toBe(true);
  });

  test("an expanded tool call body has no status wash", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "exp1",
      callId: "exp1",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/foo.ts" }),
      startedAt: 0,
    };
    function alwaysExpanded(): boolean {
      return true;
    }
    const lines = buildLines(
      [
        call,
        {
          type: "tool_result",
          id: "exp1-r",
          callId: "exp1",
          name: "read_file",
          content: "export const x = 1;\n",
          isError: false,
          finishedAt: 100,
        },
      ],
      COLUMNS,
      false,
      alwaysExpanded,
    );
    const backgrounds = segmentBackgrounds(lines);
    expect(backgrounds.every((bg) => bg === undefined)).toBe(true);
  });
});

describe("flat line buffer", () => {
  test("a layoutKey change recomputes renderable blocks even when contentBlocks is unchanged", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", id: "t1", content: "hidden thought" },
      { type: "text", id: "a1", content: "Visible reply." },
    ];
    const collapsed = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded, undefined, undefined, "k|0");
    const expanded = buildLinesIncremental(collapsed, blocks, COLUMNS, true, isExpanded, undefined, undefined, "k|1");
    expect(collapsed.blocks.some((b) => b.type === "thinking")).toBe(false);
    expect(expanded.blocks.some((b) => b.type === "thinking")).toBe(true);
  });

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

  test("appending several blocks in one drain reuses the prior rendered tail", () => {
    const first: ContentBlock[] = [
      { type: "text", id: "a1", content: "First assistant reply." },
    ];
    const state1 = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded);
    const second: ContentBlock[] = [...first, ...editPair(1), ...editPair(2)];
    const state2 = buildLinesIncremental(state1, second, COLUMNS, false, isExpanded);

    expect(lineText(state2.lines.slice(0, state1.lines.length))).toEqual(lineText(state1.lines));
    expect(lineText(state2.lines)).toEqual(
      lineText(buildLines(second, COLUMNS, false, isExpanded)),
    );
  });

  test("a grown streaming block plus appended blocks matches a full rebuild", () => {
    const first: ContentBlock[] = [
      { type: "text", id: "a1", content: "Stable reply." },
      { type: "text", id: "a2", content: "Streaming" },
    ];
    const state1 = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded);
    const second: ContentBlock[] = [
      first[0]!,
      { type: "text", id: "a2", content: "Streaming grew longer." },
      ...editPair(1),
    ];
    const state2 = buildLinesIncremental(state1, second, COLUMNS, false, isExpanded);

    expect(lineText(state2.lines)).toEqual(
      lineText(buildLines(second, COLUMNS, false, isExpanded)),
    );
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
    const lines = buildLines([bigShellBlock(50)], COLUMNS, false, () => true);
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
    const lines = buildLines([bigShellBlock(50)], COLUMNS, false, () => true);
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

  test("incremental append of a tool result drops the running marker and merges with duration", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "call-read",
      callId: "call-read",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/foo.ts" }),
      startedAt: 1_000,
    };
    const cache = new Map();
    const pending = buildLinesIncremental(undefined, [call], COLUMNS, false, isExpanded, cache);
    expect(pending.lines[0]?.[0]?.toolRunningSince).toBe(1_000);

    const result: ContentBlock = {
      type: "tool_result",
      id: "result-read",
      callId: "call-read",
      name: "read_file",
      content: "hello",
      isError: false,
      finishedAt: 2_500,
    };
    const done = buildLinesIncremental(pending, [call, result], COLUMNS, false, isExpanded, cache);
    const text = lineText(done.lines).join("\n");
    expect(done.lines[0]?.[0]?.toolRunningSince).toBeUndefined();
    expect(text).toContain("· 1.5s");
    expect(text).toContain("Read 1 line of src/foo.ts");
    // Matches a full rebuild so the incremental path cannot drift.
    expect(lineText(done.lines)).toEqual(
      lineText(buildLines([call, result], COLUMNS, false, isExpanded)),
    );
  });

  test("pending non-shell tool marks the running row with its start time", () => {
    const call: ContentBlock = {
      type: "tool_call",
      id: "call-read",
      callId: "call-read",
      name: "read_file",
      arguments: JSON.stringify({ path: "src/foo.ts" }),
      startedAt: 1_000,
    };
    const lines = buildLines([call], COLUMNS, false, isExpanded);
    const text = lineText(lines).join("\n");
    expect(lines[0]?.[0]?.toolRunningSince).toBe(1_000);
    expect(text).toContain("Read");
    // The elapsed clock is live-only; buildLines output is time-independent so a
    // per-second tick never needs to rebuild the transcript line array.
    expect(buildLines([call], COLUMNS, false, isExpanded)).toEqual(lines);
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

  test("buildResourceBanner shows brand, workspace path, and optional skills/plugins", () => {
    const workspace = "/home/user/project";
    const banner = buildResourceBanner([{ name: "scribe" }, { name: "tdd" }], ["exa"], 80, workspace);
    const text = banner.map((line) => line.map((s) => s.text).join("")).join("\n");
    expect(text.indexOf("Intercode")).toBeLessThan(text.indexOf("[Skills]"));
    expect(text).toContain("Powered by Corbits");
    expect(text).toContain(workspace);
    expect(text).toContain("[Skills]");
    expect(text).toContain("scribe, tdd");
    expect(text).toContain("[Plugins]");
    expect(text).toContain("exa");
    const brandOnly = buildResourceBanner([], [], 80, workspace);
    const brandText = brandOnly.map((line) => line.map((s) => s.text).join("")).join("\n");
    expect(brandText).toContain("Intercode");
    expect(brandText).toContain(workspace);
    expect(brandText).not.toContain("[Skills]");
    expect(brandOnly.length).toBeGreaterThan(0);
  });

  test("buildResourceBanner wraps a long workspace path to the given width", () => {
    const longPath = "/home/user/very/long/nested/project/directory/name/that/exceeds/eighty/columns/easily";
    const width = 40;
    const banner = buildResourceBanner([], [], width, longPath);
    const pathLines = banner.filter((line) =>
      line.some((seg) => seg.text.length > 0 && !["Intercode", "Powered by Corbits"].includes(seg.text)),
    );
    expect(pathLines.length).toBeGreaterThan(1);
    for (const line of pathLines) {
      const len = line.reduce((n, s) => n + s.text.length, 0);
      expect(len).toBeLessThanOrEqual(width);
    }
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

  test("inserts a separator blank between assistant prose and following tool actions (but not between consecutive tools)", () => {
    const blocks: ContentBlock[] = [
      { type: "text", id: "t1", content: "I'll read the config then edit it." },
      {
        type: "tool_call",
        id: "c1",
        name: "read_file",
        arguments: JSON.stringify({ path: "package.json" }),
      },
      {
        type: "tool_result",
        id: "r1",
        callId: "c1",
        name: "read_file",
        content: '{"name":"demo"}',
        isError: false,
      },
      {
        type: "tool_call",
        id: "c2",
        name: "edit_file",
        arguments: JSON.stringify({ path: "package.json" }),
      },
      {
        type: "tool_result",
        id: "r2",
        callId: "c2",
        name: "edit_file",
        content: "replaced 1 occurrence(s)",
        isError: false,
      },
    ];
    const lines = lineText(buildLines(blocks, COLUMNS, false, isExpanded));
    // After text there should be a blank line (represented as ""), then the first tool.
    // The two action lines are adjacent (no extra blank between merged pairs).
    expect(lines).toEqual([
      " ● I'll read the config then edit it.",
      "",
      "  ● Read 1 line of package.json",
      "  ● Edited package.json (1 replacement)",
    ]);
  });
});

describe("incremental layout fast paths", () => {
  // MAX is intentionally tiny so trim and cold-path-skip both engage without
  // needing hundreds of blocks. Each block contributes multiple rendered lines.
  const MAX = 30;

  // 80 multi-line text blocks — enough to trip the cold-path-skip (>60) and to
  // overflow MAX so trim runs on the same frame.
  function manyTextBlocks(count: number): ContentBlock[] {
    return Array.from({ length: count }, (_, i) => ({
      type: "text" as const,
      id: `t${i}`,
      content: `block ${i}\nsecond line\nthird line`,
    }));
  }

  test("blockRenderLineCounts stays NaN-free after the cold path skips blocks", () => {
    const first = manyTextBlocks(80);
    const state = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    // Cold path triggers when blocks.length > 60 and startBlockIndex lands past 0,
    // leaving blockLineStarts sparse below startBlockIndex. The counts array
    // must remain dense numeric (no NaN) for findTailStartFromLineCounts.
    for (const count of state.blockRenderLineCounts) {
      expect(Number.isFinite(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
    expect(state.firstRenderedBlockIndex).toBeGreaterThan(0);
  });

  test("appendedOnly fast path preserves the rendered tail and stays bounded", () => {
    const first = manyTextBlocks(70);
    const state1 = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    const appended = [...first, { type: "text" as const, id: "t70", content: "block 70" }];
    const state2 = buildLinesIncremental(state1, appended, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    expect(state2.lines.length).toBeLessThanOrEqual(MAX);
    // The prior tail is reused verbatim (no re-trim of the existing lines).
    expect(lineText(state2.lines).join("\n")).toContain("block 69");
    expect(lineText(state2.lines).join("\n")).toContain("block 70");
    // Counts array matches the new block count and stays NaN-free.
    expect(state2.blockRenderLineCounts.length).toBe(appended.length);
    for (const count of state2.blockRenderLineCounts) {
      expect(Number.isFinite(count)).toBe(true);
    }
  });

  test("suffixMatches fast path keeps the tail after the head is dropped", () => {
    // Seed past the retention cadence by building directly: 80 blocks, then
    // simulate compaction dropping the oldest 10. The 70-block suffix must
    // match prev[i + dropped], triggering the suffixMatches branch.
    const first = manyTextBlocks(80);
    const state1 = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    const compacted = first.slice(10);
    const state2 = buildLinesIncremental(state1, compacted, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    // The retained tail (last block) survives across the compaction seam.
    expect(lineText(state2.lines).join("\n")).toContain("block 79");
    expect(state2.lines.length).toBeLessThanOrEqual(MAX);
    for (const count of state2.blockRenderLineCounts) {
      expect(Number.isFinite(count)).toBe(true);
    }
  });

  test("at most one hidden-lines marker survives across appendedOnly rebuilds", () => {
    const first = manyTextBlocks(80);
    const state1 = buildLinesIncremental(undefined, first, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    // Append a block large enough to push past the budget on the next frame.
    const appended = [...first, {
      type: "text" as const,
      id: "t80",
      content: Array.from({ length: 80 }, () => "x".repeat(80)).join("\n"),
    }];
    const state2 = buildLinesIncremental(state1, appended, COLUMNS, false, isExpanded, undefined, undefined, undefined, MAX);

    const text = lineText(state2.lines).join("\n");
    const markerHits = text.match(/earlier rendered lines hidden/g) ?? [];
    expect(markerHits.length).toBeLessThanOrEqual(1);
  });
});

function bigToolResult(id: string, callId: string, lineCount: number): ContentBlock {
  return {
    type: "tool_result",
    id,
    callId,
    name: "run_shell",
    content: Array.from({ length: lineCount }, (_, i) => `output line ${i} for ${callId}`).join("\n"),
    isError: false,
  };
}

function toolPair(index: number, resultLines: number): ContentBlock[] {
  const callId = `shell-${index}`;
  return [
    {
      type: "tool_call",
      id: callId,
      name: "run_shell",
      arguments: JSON.stringify({ command: `echo tool-${index}` }),
    },
    bigToolResult(`result-${index}`, callId, resultLines),
  ];
}

describe("blockIdsInLineRange", () => {
  test("selects only tools whose line ranges intersect the window", () => {
    const blocks: ContentBlock[] = [
      { type: "text", id: "t0", content: "hello" },
      ...toolPair(0, 3),
      { type: "text", id: "t1", content: "between" },
      ...toolPair(1, 3),
    ];
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    // shell-1 is at block index 4 (t0, shell-0, result-0, t1, shell-1, result-1)
    const shell1Start = state.blockLineStarts[4] ?? 0;
    const ids = blockIdsInLineRange(
      state.blocks,
      state.blockLineStarts,
      state.lines.length,
      shell1Start,
      shell1Start + 1,
    );
    expect(ids.has("shell-1")).toBe(true);
    expect(ids.has("result-1")).toBe(true);
    expect(ids.has("shell-0")).toBe(false);
    // Prose never enters the expand set — it would only churn layoutKey.
    expect(ids.has("t0")).toBe(false);
    expect(ids.has("t1")).toBe(false);
  });

  test("pairs a merged tool call with its zero-width result", () => {
    const blocks = toolPair(0, 5);
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    // Collapsed merge puts lines on the call; result is zero-width after it.
    const ids = blockIdsInLineRange(
      state.blocks,
      state.blockLineStarts,
      state.lines.length,
      0,
      state.lines.length,
    );
    expect(ids.has("shell-0")).toBe(true);
    expect(ids.has("result-0")).toBe(true);
  });

  test("returns an empty set for an empty window", () => {
    const blocks = toolPair(0, 5);
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const ids = blockIdsInLineRange(
      state.blocks,
      state.blockLineStarts,
      state.lines.length,
      2,
      2,
    );
    expect(ids.size).toBe(0);
  });

  test("expands an entire collapsed file-edit group when any member hits", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 4; i++) {
      blocks.push({
        type: "tool_call",
        id: `edit-${i}`,
        name: "edit_file",
        arguments: JSON.stringify({ path: `f${i}.ts` }),
      });
      blocks.push({
        type: "tool_result",
        id: `edit-result-${i}`,
        callId: `edit-${i}`,
        name: "edit_file",
        content: "ok",
        isError: false,
      });
    }
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    // Group summary lives on the first call; hit just that one-line window.
    const firstStart = state.blockLineStarts[0] ?? 0;
    const ids = blockIdsInLineRange(
      state.blocks,
      state.blockLineStarts,
      state.lines.length,
      firstStart,
      firstStart + 1,
    );
    for (let i = 0; i < 4; i++) {
      expect(ids.has(`edit-${i}`)).toBe(true);
      expect(ids.has(`edit-result-${i}`)).toBe(true);
    }
  });
});

describe("viewportToolIds", () => {
  test("atBottom selects tools at the base tail", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 10; i++) blocks.push(...toolPair(i, 5));
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const visibleRows = 6;
    const ids = viewportToolIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 0,
      visibleRows,
      scrollOffset: 0,
      atBottom: true,
      bufferRows: 0,
    });
    expect(ids.has("shell-9")).toBe(true);
    expect(ids.has("result-9")).toBe(true);
    expect(ids.has("shell-0")).toBe(false);
  });

  test("expanded scroll offset maps correctly when layout is expanded (no base clamp)", () => {
    // Reproduces the mid-scroll bug: after expanding mid tools, an expanded
    // scrollOffset larger than the collapsed maxOff must still select mid tools
    // when membership uses the expanded layout metrics.
    const RESULT_LINES = 40;
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 10; i++) blocks.push(...toolPair(i, RESULT_LINES));

    const collapsed = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const midIds = new Set(["shell-3", "result-3", "shell-4", "result-4", "shell-5", "result-5"]);
    const expanded = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      (block) => midIds.has(block.id),
    );

    const visibleRows = 20;
    const collapsedMaxOff = Math.max(0, collapsed.lines.length - visibleRows);
    // Scroll into the expanded mid band — past collapsed maxOff.
    const midStart = expanded.blockLineStarts[6] ?? 0; // shell-3 index after 3 pairs
    const scrollOffset = Math.min(
      midStart,
      Math.max(0, expanded.lines.length - visibleRows),
    );
    expect(scrollOffset).toBeGreaterThan(collapsedMaxOff);

    const ids = viewportToolIds({
      blocks: expanded.blocks,
      blockLineStarts: expanded.blockLineStarts,
      lineCount: expanded.lines.length,
      prefixLineCount: 0,
      visibleRows,
      scrollOffset,
      atBottom: false,
      bufferRows: 0,
    });

    // Must stay on mid tools, not clamp to the base tail.
    expect(ids.has("shell-3") || ids.has("shell-4") || ids.has("shell-5")).toBe(true);
    expect(ids.has("shell-9")).toBe(false);
  });

  test("prefix lines shift the window into content coordinates", () => {
    const blocks = toolPair(0, 5);
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    // Window entirely inside the prefix → no tools.
    const empty = viewportToolIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 10,
      visibleRows: 5,
      scrollOffset: 0,
      atBottom: false,
      bufferRows: 0,
    });
    expect(empty.size).toBe(0);

    // Window past the prefix hits the tools.
    const hit = viewportToolIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 2,
      visibleRows: 5,
      scrollOffset: 2,
      atBottom: false,
      bufferRows: 0,
    });
    expect(hit.has("shell-0")).toBe(true);
  });
});

describe("capViewportToolIds", () => {
  test("keeps tools closest to the viewport center under the hang-safe budget", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 20; i++) blocks.push(...toolPair(i, 1));
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const all = blockIdsInLineRange(
      state.blocks,
      state.blockLineStarts,
      state.lines.length,
      0,
      state.lines.length,
    );
    const center = state.lines.length / 2;
    const capped = capViewportToolIds(
      all,
      state.blocks,
      state.blockLineStarts,
      state.lines.length,
      center,
      4,
    );
    const callCount = [...capped].filter((id) => id.startsWith("shell-")).length;
    expect(callCount).toBe(4);
    // Mid-band tools win over the ends.
    expect(capped.has("shell-0")).toBe(false);
    expect(capped.has("shell-19")).toBe(false);
    expect(capped.has("shell-9") || capped.has("shell-10")).toBe(true);
  });
});

describe("resolveViewportExpandIds", () => {
  test("holds previously expanded tools until they leave the hold buffer", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 12; i++) blocks.push(...toolPair(i, 5));
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const visibleRows = 6;
    // Enter with a tight buffer around the tail.
    const first = resolveViewportExpandIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 0,
      visibleRows,
      scrollOffset: 0,
      atBottom: true,
      previousIds: new Set(),
      enterBufferRows: 0,
      holdBufferRows: 40,
      maxToolCalls: DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS,
    });
    expect(first.has("shell-11")).toBe(true);

    // Scroll up so shell-11 is outside the enter window but still inside hold.
    const midOffset = Math.max(0, state.lines.length - visibleRows - 15);
    const held = resolveViewportExpandIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 0,
      visibleRows,
      scrollOffset: midOffset,
      atBottom: false,
      previousIds: first,
      enterBufferRows: 0,
      holdBufferRows: 40,
      maxToolCalls: DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS,
    });
    // Sticky: shell-11 remains even though enter buffer would drop it.
    const enterOnly = viewportToolIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 0,
      visibleRows,
      scrollOffset: midOffset,
      atBottom: false,
      bufferRows: 0,
    });
    if (!enterOnly.has("shell-11")) {
      expect(held.has("shell-11")).toBe(true);
    }
  });

  test("drops sticky tools once they leave the hold buffer", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 20; i++) blocks.push(...toolPair(i, 8));
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const visibleRows = 6;
    const previous = new Set(["shell-0", "result-0"]);
    const next = resolveViewportExpandIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 0,
      visibleRows,
      scrollOffset: 0,
      atBottom: true,
      previousIds: previous,
      enterBufferRows: 0,
      holdBufferRows: 0,
      maxToolCalls: DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS,
    });
    expect(next.has("shell-0")).toBe(false);
    expect(next.has("shell-19")).toBe(true);
  });

  test("caps dense enter sets to the hang-safe budget", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 40; i++) blocks.push(...toolPair(i, 1));
    const state = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const next = resolveViewportExpandIds({
      blocks: state.blocks,
      blockLineStarts: state.blockLineStarts,
      lineCount: state.lines.length,
      prefixLineCount: 0,
      visibleRows: 80,
      scrollOffset: 0,
      atBottom: true,
      previousIds: new Set(),
      enterBufferRows: 80,
      holdBufferRows: 160,
      maxToolCalls: 6,
    });
    const callCount = [...next].filter((id) => id.startsWith("shell-")).length;
    expect(callCount).toBeLessThanOrEqual(6);
  });
});

describe("viewport-local expand", () => {
  test("expanding only a subset keeps far tools collapsed", () => {
    const RESULT_LINES = 80;
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 10; i++) {
      blocks.push(...toolPair(i, RESULT_LINES));
    }

    const collapsed = buildLinesIncremental(undefined, blocks, COLUMNS, false, isExpanded);
    const collapsedLen = collapsed.lines.length;

    // Expand only the last pair (simulating a bottom-pinned viewport).
    const expandedIds = new Set(["shell-9", "result-9"]);
    const partial = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      (block) => expandedIds.has(block.id),
    );

    // Fully expanded would be many times larger; partial should grow by roughly
    // one tool's expanded body, not ten.
    const fullyExpanded = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      () => true,
    );

    expect(partial.lines.length).toBeGreaterThan(collapsedLen);
    expect(partial.lines.length).toBeLessThan(fullyExpanded.lines.length / 2);
    // Off-viewport early tools stay short: the first call's line span should
    // remain near the collapsed single-row merge height.
    const firstCallLines = partial.blockRenderLineCounts[0] ?? 0;
    expect(firstCallLines).toBeLessThanOrEqual(4);
  });

  test("explicit expand still works outside the viewport set", () => {
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 5; i++) {
      blocks.push(...toolPair(i, 60));
    }
    // Viewport set empty; only explicit Ctrl+R on an early tool.
    const explicit = new Set(["shell-0", "result-0"]);
    const state = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      (block) => explicit.has(block.id),
    );
    // Expanded body lives on the tool_result; the call is still a short header.
    const firstResultLines = state.blockRenderLineCounts[1] ?? 0;
    // Last pair stays merged/collapsed — lines land on the call (index n-2).
    const lastCallLines = state.blockRenderLineCounts[state.blocks.length - 2] ?? 0;
    expect(firstResultLines).toBeGreaterThan(4);
    expect(lastCallLines).toBeLessThanOrEqual(4);
  });

  test("partial expand line count scales with the set size, not total tools", () => {
    const RESULT_LINES = 100;
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < 20; i++) {
      blocks.push(...toolPair(i, RESULT_LINES));
    }

    const expandTwo = new Set(["shell-18", "result-18", "shell-19", "result-19"]);
    const two = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      (block) => expandTwo.has(block.id),
    );

    const expandAll = buildLinesIncremental(
      undefined,
      blocks,
      COLUMNS,
      false,
      () => true,
    );

    // Full expand hits the rendered-line budget; two tools stay well under it.
    expect(two.lines.length).toBeLessThan(expandAll.lines.length);
    expect(two.lines.length).toBeLessThan(Math.floor(DEFAULT_MAX_RENDERED_LOG_LINES / 2));
  });
});
