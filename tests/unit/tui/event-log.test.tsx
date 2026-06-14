import { expect, test } from "bun:test";
import { Box } from "ink";
import { render } from "ink-testing-library";
import {
  EventLog,
  clampOffset,
  buildLineUnits,
  visibleLineWindow,
  maxScrollOffset,
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
  const withIds = blocks.map((b, i) => ("id" in b ? b : { ...b, id: `fixture-${i}` })) as ContentBlock[];
  return render(
    <EventLog
      contentBlocks={withIds}
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

test("EventLog summarizes a tool result by default and shows full content when expanded", () => {
  const blocks: ContentBlock[] = [
    { id: "r", type: "tool_result", callId: "c1", name: "read_file", content: "     1\tline one\n     2\tline two", isError: false },
  ];
  expect(renderLog(blocks).lastFrame()).toContain("Read 2 lines");
  expect(renderLog(blocks).lastFrame()).not.toContain("line one");
  expect(renderLog(blocks, { expandedTools: new Set(["r"]) }).lastFrame()).toContain("line one");
});

test("EventLog renders web_search result envelopes as a readable summary", () => {
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

test("EventLog reveals full tool result content when the block is expanded", () => {
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

test("renderableBlocks drops reply and plan blocks", () => {
  const blocks: ContentBlock[] = [
    { type: "plan", steps: [] },
    { type: "reply", content: "x" },
    { type: "text", content: "keep" },
  ];
  expect(renderableBlocks(blocks).map((b) => b.type)).toEqual(["text"]);
});

test("EventLog shows long content in full by default, never a show-more marker", () => {
  const long = "z".repeat(300);
  const { lastFrame } = renderLog([{ id: "u", type: "user", content: long }], { columns: 80 });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("[show more]");
  expect(frame.replace(/\s/g, "")).toContain(long);
});

test("a long tool summary wraps rather than truncating", () => {
  const { lastFrame } = renderLog([
    { type: "tool_call", name: "run_shell", arguments: JSON.stringify({ command: "x".repeat(300) }) },
  ], { columns: 80 });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("[show more]");
  // Full command content must be present, not truncated
  expect(frame.replace(/\s/g, "")).toContain("x".repeat(300));
});

test("truncateToWidth marks a cut with a bare ellipsis", () => {
  const long = "abcdefghij".repeat(40);
  for (const columns of [80, 120, 160]) {
    const out = truncateLine(long, columns, false);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("[show more]");
    expect(out.length).toBe(columns - 2);
  }
});

test("truncateLine leaves short content untouched and respects expanded", () => {
  expect(truncateLine("short", 80, false)).toBe("short");
  const long = "y".repeat(300);
  expect(truncateLine(long, 80, true)).toBe(long);
});

test("thinking stays hidden by default while other content shows in full", () => {
  const long = "z".repeat(300);
  const { lastFrame } = renderLog([
    { id: "t", type: "thinking", content: "hidden reasoning" },
    { id: "u", type: "user", content: long },
  ], { columns: 80 });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("hidden reasoning");
  expect(frame.replace(/\s/g, "")).toContain(long);
});

test("visibleLineWindow keeps the painted rows within the viewport budget", () => {
  const blocks: ContentBlock[] = [
    block({ type: "text", content: "old line that should scroll out of view entirely here" }),
    block({ type: "text", content: "x".repeat(80) }),
    block({ type: "text", content: "newest" }),
  ];
  const units = buildLineUnits(blocks, 20, false, () => false);
  const { start, end } = visibleLineWindow(units, units.length, 4);
  const rows = units.slice(start, end).reduce((n, u) => n + u.rows, 0);
  expect(rows).toBeLessThanOrEqual(4);
  expect(end).toBe(units.length);
  expect(start).toBeGreaterThan(0);
});

test("the bottom is steady: every offset at or past maxScrollOffset shows the same full tail", () => {
  const units = buildLineUnits(
    Array.from({ length: 12 }, (_, i) => block({ type: "text", content: `line-${i}` })),
    200,
    false,
    () => false,
  );
  const visibleRows = 5;
  const maxOffset = maxScrollOffset(units, visibleRows);
  const atMax = visibleLineWindow(units, maxOffset, visibleRows);
  expect(atMax.end).toBe(units.length);
  // Scrolling past the max (or to the very last unit) does not move the window —
  // the last line stays anchored at the bottom rather than drifting up.
  for (const offset of [maxOffset + 1, units.length - 1, units.length + 5]) {
    expect(visibleLineWindow(units, offset, visibleRows)).toEqual(atMax);
  }
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

test("buildLineUnits explodes a multi-line text block into one unit per line", () => {
  const units = buildLineUnits([block({ type: "text", content: "a\nb\nc" })], 200, false, () => false);
  expect(units.length).toBe(3);
  expect(units.every((u) => u.rows === 1)).toBe(true);
});

test("buildLineUnits inserts a blank spacer unit between conversational turns", () => {
  const units = buildLineUnits(
    [block({ type: "user", content: "hi" }), block({ type: "text", content: "reply" })],
    200,
    false,
    () => false,
  );
  expect(units.length).toBe(3);
});

test("a composed headline unit never claims fewer rows than it paints", () => {
  const cmd = "echo " + "y".repeat(60);
  const units = buildLineUnits(
    [block({ type: "tool_call", name: "run_shell", arguments: JSON.stringify({ command: cmd }) })],
    30,
    false,
    () => true,
  );
  const headline = units[0]!;
  const { lastFrame } = render(
    <Box width={28}>{headline.node}</Box>,
    { stdout: { columns: 28, rows: 80 } as unknown as NodeJS.WriteStream },
  );
  const painted = (lastFrame() ?? "").split("\n").filter((r) => r.trim().length > 0).length;
  expect(headline.rows).toBeGreaterThanOrEqual(painted);
});

test("visibleLineWindow advances one line per scroll step", () => {
  const units = buildLineUnits(
    Array.from({ length: 6 }, (_, i) => block({ type: "text", content: `line-${i}` })),
    200,
    false,
    () => false,
  );
  const w0 = visibleLineWindow(units, 0, 3);
  const w1 = visibleLineWindow(units, 1, 3);
  expect(w1.start).toBe(w0.start + 1);
});
