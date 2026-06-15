import { describe, expect, test } from "bun:test";
import { buildLines, maxLineOffset, lineWindow } from "./event-log.js";
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

describe("flat line buffer", () => {
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
});
