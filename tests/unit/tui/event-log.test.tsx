import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
  EventLog,
  clampOffset,
  windowBlocks,
  visibleWindow,
  renderableBlocks,
  truncateLine,
} from "../../../src/tui/components/event-log.js";
import type { RenderableBlock } from "../../../src/tui/components/event-log.js";
import type { ContentBlock } from "../../../src/tui/use-stream.js";
import { wrapCount } from "../../../src/tui/view/height.js";

let blockSeq = 0;
function block(data: Omit<ContentBlock, "id">): RenderableBlock {
  return { ...data, id: `wb${(blockSeq += 1)}` } as RenderableBlock;
}

type Overrides = Partial<Parameters<typeof EventLog>[0]>;

function renderLog(blocks: ContentBlock[], overrides: Overrides = {}) {
  return render(
    <EventLog
      contentBlocks={blocks}
      scrollOffset={overrides.scrollOffset ?? 0}
      visibleRows={overrides.visibleRows ?? 100}
      columns={overrides.columns ?? 200}
      thinkingExpanded={overrides.thinkingExpanded ?? false}
      expandedTools={overrides.expandedTools ?? new Set()}
      verbose={overrides.verbose ?? false}
    />,
    { stdout: { columns: (overrides.columns ?? 200) + 20, rows: 200 } as unknown as NodeJS.WriteStream },
  );
}

test("EventLog renders nothing when there are no blocks", () => {
  const { lastFrame } = renderLog([]);
  expect(lastFrame() ?? "").not.toContain("Waiting for events");
});

test("EventLog renders user message", () => {
  const { lastFrame } = renderLog([{ type: "user", content: "hello world" }]);
  expect(lastFrame()).toContain("> hello world");
});

test("EventLog renders text block", () => {
  const { lastFrame } = renderLog([{ type: "text", content: "Hello!" }]);
  expect(lastFrame()).toContain("Hello!");
});

test("EventLog renders error block in danger color", () => {
  const { lastFrame } = renderLog([{ type: "error", message: "fatal: oops" }]);
  expect(lastFrame()).toContain("fatal: oops");
});

test("EventLog renders tool call with a humanized name and readable arg summary", () => {
  const { lastFrame } = renderLog([
    {
      type: "tool_call",
      name: "read_file",
      arguments: '{"path":"/tmp/example"}',
    },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Read");
  expect(frame).not.toContain("read_file");
  expect(frame).toContain("/tmp/example");
});

test("EventLog wraps a long line with inline bold instead of overflowing", () => {
  const content = "Before your last message you asked about **Acme Interchange** which is the platform we build the agentic business runtime around the world today.";
  const { lastFrame } = renderLog([{ type: "text", content }], { columns: 80 });
  const frame = lastFrame() ?? "";
  const rows = frame.split("\n").filter((r) => r.trim().length > 0);
  // The line is longer than the pane, so it flows across more than one row
  // rather than overflowing on a single row or exploding word-by-word.
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(8);
  // The bolded words and the trailing word all survive the wrap.
  expect(frame).toContain("Acme");
  expect(frame).toContain("today");
});

test("EventLog renders a shell call leanly as the command, not run_shell", () => {
  const { lastFrame } = renderLog([
    {
      type: "tool_call",
      name: "run_shell",
      arguments: '{"command":"npm test"}',
    },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("npm test");
  expect(frame).not.toContain("run_shell");
});

test("EventLog never shows raw JSON for tool call args in default view", () => {
  const { lastFrame } = renderLog([
    {
      type: "tool_call",
      name: "read_file",
      arguments: '{"path":"/tmp/example","limit":40}',
    },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain('{"path"');
  expect(frame).not.toContain('"limit":40');
});

test("EventLog renders tool result preview, never raw content, for non-JSON result", () => {
  const { lastFrame } = renderLog([
    { type: "tool_result", callId: "c1", name: "read_file", content: "     1\tline one\n     2\tline two", isError: false },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Read 2 lines");
  expect(frame).not.toContain("line one");
});

test("EventLog renders web_search result envelopes as readable output", () => {
  const content = JSON.stringify({
    results: [
      { title: "Hono", url: "https://hono.dev", snippet: "Fast web framework" },
    ],
  });
  const { lastFrame } = renderLog([
    { type: "tool_result", callId: "web-1", name: "web_search", content, isError: false },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Found 1 web result");
  expect(frame).not.toContain('"results"');
});

test("EventLog renders a real JSON document result verbatim", () => {
  const json = '{"name":"intercode","version":"1.0.0"}';
  const { lastFrame } = renderLog([
    { type: "tool_result", callId: "c1", name: "read_file", content: json, isError: false },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("intercode");
  expect(frame).toContain("1.0.0");
});

test("EventLog renders tool result errors in danger styling", () => {
  const { lastFrame } = renderLog([
    { type: "tool_result", callId: "c2", name: "write_file", content: "permission denied", isError: true },
  ]);
  expect(lastFrame()).toContain("error: permission denied");
});

test("EventLog hides thinking by default", () => {
  const { lastFrame } = renderLog([{ type: "thinking", content: "internal reasoning" }]);
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("thinking…");
  expect(frame).not.toContain("internal reasoning");
});

test("EventLog expands thinking content when thinkingExpanded is set", () => {
  const { lastFrame } = renderLog([{ type: "thinking", content: "internal reasoning" }], {
    thinkingExpanded: true,
  });
  expect(lastFrame()).toContain("internal reasoning");
});

test("EventLog verbose reveals full tool args", () => {
  const { lastFrame } = renderLog(
    [{ type: "tool_call", name: "read_file", arguments: '{"path":"/tmp/example"}' }],
    { verbose: true },
  );
  expect(lastFrame()).toContain("/tmp/example");
});

test("EventLog per-block expansion reveals full tool result", () => {
  const { lastFrame } = renderLog(
    [{ id: "r", type: "tool_result", callId: "c1", name: "read_file", content: "     1\thidden text", isError: false }],
    { expandedTools: new Set(["r"]) },
  );
  expect(lastFrame()).toContain("hidden text");
});

test("EventLog filters out reply and plan blocks", () => {
  const { lastFrame } = renderLog([
    { type: "plan", steps: [{ file: "src/a.ts", action: "create" }] },
    { type: "reply", content: "synthetic" },
    { type: "user", content: "go" },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> go");
  expect(frame).not.toContain("src/a.ts");
  expect(frame).not.toContain("synthetic");
});

test("clampOffset bounds offset to [0, total - visibleRows]", () => {
  expect(clampOffset(-5, 10, 4)).toBe(0);
  expect(clampOffset(0, 10, 4)).toBe(0);
  expect(clampOffset(100, 10, 4)).toBe(6);
  expect(clampOffset(3, 10, 4)).toBe(3);
  expect(clampOffset(5, 3, 4)).toBe(0);
});

test("windowBlocks returns only the visible window", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  expect(windowBlocks(items, 0, 3)).toEqual([0, 1, 2]);
  expect(windowBlocks(items, 4, 3)).toEqual([4, 5, 6]);
  expect(windowBlocks(items, 100, 3)).toEqual([7, 8, 9]);
});

test("renderableBlocks drops reply and plan blocks", () => {
  const blocks: ContentBlock[] = [
    { type: "plan", steps: [] },
    { type: "reply", content: "x" },
    { type: "text", content: "keep" },
  ];
  expect(renderableBlocks(blocks).map((b) => b.type)).toEqual(["text"]);
});

test("EventLog truncates long single-line content with a show-more indicator", () => {
  const long = "x".repeat(300);
  for (const columns of [80, 120, 160]) {
    const { lastFrame } = renderLog([{ type: "user", content: long }], { columns });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("… [show more]");
    // The truncated marker line must fit within the pane width.
    const longest = Math.max(...frame.split("\n").map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(columns);
  }
});

test("truncateLine cuts at availableWidth and grows with column width", () => {
  const long = "abcdefghij".repeat(40);
  const at = (columns: number) => truncateLine(long, columns, false);
  for (const columns of [80, 120, 160]) {
    const out = at(columns);
    expect(out.endsWith("… [show more]")).toBe(true);
    expect(out.length).toBe(columns - 2);
  }
  expect(at(120).length).toBeGreaterThan(at(80).length);
  expect(at(160).length).toBeGreaterThan(at(120).length);
});

test("truncateLine leaves short content untouched and respects expanded", () => {
  expect(truncateLine("short", 80, false)).toBe("short");
  const long = "y".repeat(300);
  expect(truncateLine(long, 80, true)).toBe(long);
});

test("EventLog shows untruncated content when the block is expanded", () => {
  const long = "z".repeat(300);
  const { lastFrame } = renderLog([{ id: "u", type: "user", content: long }], {
    columns: 80,
    expandedTools: new Set(["u"]),
  });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("… [show more]");
  expect(frame.replace(/\s/g, "")).toContain(long);
});

test("EventLog keeps expansion anchored to a block id when thinking is hidden", () => {
  const long = "z".repeat(300);
  const { lastFrame } = renderLog([
    { id: "t", type: "thinking", content: "hidden reasoning" },
    { id: "u", type: "user", content: long },
  ], {
    columns: 80,
    expandedTools: new Set(["u"]),
  });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("hidden reasoning");
  expect(frame).not.toContain("… [show more]");
  expect(frame.replace(/\s/g, "")).toContain(long);
});

test("visibleWindow keeps the painted rows within the viewport budget", () => {
  // A tall block (wraps to ~5 rows at width 18) followed by short ones.
  const blocks: RenderableBlock[] = [
    { type: "text", content: "old line that should scroll out of view entirely here" },
    { type: "text", content: "x".repeat(80) }, // wraps to several rows
    { type: "text", content: "newest" },
  ];
  const { start, end } = visibleWindow(blocks, 100, 4, 20, false, () => false);
  const shown = blocks.slice(start, end);
  const rows = shown.reduce((n, b) => {
    const content = b.type === "text" ? b.content : "";
    return n + content.split("\n").reduce((m, l) => m + Math.max(1, Math.ceil(l.length / 18)), 0);
  }, 0);
  expect(rows).toBeLessThanOrEqual(4);
  // The newest block is always retained; the oldest is dropped.
  expect(end).toBe(3);
  expect(start).toBeGreaterThan(0);
});

test("EventLog windows visible blocks by scrollOffset", () => {
  const blocks: ContentBlock[] = Array.from({ length: 10 }, (_, i) => ({
    type: "text" as const,
    content: `line-${i}`,
  }));
  const { lastFrame } = renderLog(blocks, { scrollOffset: 0, visibleRows: 3 });
  const frame = lastFrame() ?? "";
  // Offset zero starts at the oldest block and paints forward within the row
  // budget. The window is bounded — distant lines stay hidden.
  expect(frame).toContain("line-0");
  expect(frame).not.toContain("line-5");
  expect(frame).not.toContain("line-9");
});

test("wrapCount word-wraps greedily instead of packing characters", () => {
  expect(wrapCount("aaaaaa aaaaaa aaaaaa", 10)).toBe(3);
  expect(Math.ceil("aaaaaa aaaaaa aaaaaa".length / 10)).toBe(2);
  expect(wrapCount("short", 10)).toBe(1);
  expect(wrapCount("a\nb\nc", 10)).toBe(3);
});

test("visibleWindow does not reserve spacing for the topmost visible block", () => {
  const blocks: RenderableBlock[] = [
    block({ type: "text", content: "a" }),
    block({ type: "text", content: "b" }),
    block({ type: "text", content: "c" }),
  ];
  const expanded = () => false;
  const win = visibleWindow(blocks, blocks.length, 3, 200, false, expanded);
  expect(win.end).toBe(3);
  expect(win.start).toBe(1);
});
