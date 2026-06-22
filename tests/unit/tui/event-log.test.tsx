import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
  EventLog,
  buildLines,
  lineWindow,
  maxLineOffset,
  renderableBlocks,
} from "../../../src/tui/components/event-log.js";
import type { RenderableBlock } from "../../../src/tui/components/event-log.js";
import type { ContentBlock } from "../../../src/tui/use-stream.js";
import { wrapCount, wrapLines } from "../../../src/tui/view/height.js";

let blockSeq = 0;
function block(data: Omit<ContentBlock, "id">): RenderableBlock {
  return { ...data, id: `wb${(blockSeq += 1)}` } as RenderableBlock;
}

const lineText = (line: { text: string }[]): string => line.map((s) => s.text).join("");

type Overrides = {
  scrollOffset?: number;
  visibleRows?: number;
  columns?: number;
  thinkingExpanded?: boolean;
  expandedTools?: ReadonlySet<string>;
  verbose?: boolean;
};

function renderLog(blocks: ContentBlock[], overrides: Overrides = {}) {
  const withIds = blocks.map((b, i) => ("id" in b ? b : { ...b, id: `fixture-${i}` })) as ContentBlock[];
  const columns = overrides.columns ?? 200;
  const expandedTools = overrides.expandedTools ?? new Set<string>();
  const verbose = overrides.verbose ?? false;
  const lines = buildLines(
    renderableBlocks(withIds),
    columns,
    overrides.thinkingExpanded ?? false,
    (b) => verbose || expandedTools.has(b.id),
  );
  return render(
    <EventLog lines={lines} scrollOffset={overrides.scrollOffset ?? 0} visibleRows={overrides.visibleRows ?? 100} />,
    { stdout: { columns: columns + 20, rows: 200 } as unknown as NodeJS.WriteStream },
  );
}

test("EventLog renders nothing when there are no blocks", () => {
  const { lastFrame } = renderLog([]);
  expect(lastFrame() ?? "").not.toContain("Waiting for events");
});

test("EventLog renders user message", () => {
  const { lastFrame } = renderLog([{ type: "user", content: "hello world" }]);
  expect(lastFrame()).toContain("hello world");
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

test("EventLog collapses a real JSON document result until expanded", () => {
  const json = '{"name":"intercode","version":"1.0.0"}';
  const blocks: ContentBlock[] = [
    { id: "json", type: "tool_result", callId: "c1", name: "read_file", content: json, isError: false },
  ];

  const collapsedFrame = renderLog(blocks).lastFrame() ?? "";
  expect(collapsedFrame).toContain("Read 1 lines");
  expect(collapsedFrame).not.toContain("intercode");

  const expandedFrame = renderLog(blocks, { expandedTools: new Set(["json"]) }).lastFrame() ?? "";
  expect(expandedFrame).toContain("intercode");
  expect(expandedFrame).toContain("1.0.0");
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

test("EventLog filters out reply and task blocks", () => {
  const { lastFrame } = renderLog([
    { type: "tasks", tasks: [{ id: "1", title: "create", status: "todo" }] },
    { type: "reply", content: "synthetic" },
    { type: "user", content: "go" },
  ]);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("go");
  expect(frame).not.toContain("create");
  expect(frame).not.toContain("synthetic");
});

test("renderableBlocks drops reply and task blocks", () => {
  const blocks: ContentBlock[] = [
    { type: "tasks", tasks: [] },
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
  const stripped = frame.replace(/\u001b\[\d+(;\d+)*m/g, "").replace(/\s/g, "");
  expect(stripped).toContain(long);
});

test("a long tool summary wraps rather than truncating", () => {
  const { lastFrame } = renderLog([
    { type: "tool_call", name: "run_shell", arguments: JSON.stringify({ command: "x".repeat(300) }) },
  ], { columns: 80 });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("[show more]");
  // Full command content must be present, not truncated
  const stripped = frame.replace(/\u001b\[\d+(;\d+)*m/g, "").replace(/\s/g, "");
  expect(stripped).toContain("x".repeat(300));
});

test("thinking stays hidden by default while other content shows in full", () => {
  const long = "z".repeat(300);
  const { lastFrame } = renderLog([
    { id: "t", type: "thinking", content: "hidden reasoning" },
    { id: "u", type: "user", content: long },
  ], { columns: 80 });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("hidden reasoning");
  const stripped = frame.replace(/\u001b\[\d+(;\d+)*m/g, "").replace(/\s/g, "");
  expect(stripped).toContain(long);
});

test("maxLineOffset leaves exactly the last visibleRows lines on screen", () => {
  const lines = buildLines(
    Array.from({ length: 12 }, (_, i) => block({ type: "text", content: `line-${i}` })),
    200,
    false,
    () => false,
  );
  const visibleRows = 5;
  const maxOffset = maxLineOffset(lines, visibleRows);
  expect(maxOffset).toBe(lines.length - visibleRows);
  const { start, end } = lineWindow(lines, maxOffset, visibleRows);
  expect(end).toBe(lines.length);
  expect(end - start).toBe(visibleRows);
});

test("the bottom is steady: every offset at or past maxLineOffset shows the same full tail", () => {
  const lines = buildLines(
    Array.from({ length: 12 }, (_, i) => block({ type: "text", content: `line-${i}` })),
    200,
    false,
    () => false,
  );
  const visibleRows = 5;
  const maxOffset = maxLineOffset(lines, visibleRows);
  const atMax = lineWindow(lines, maxOffset, visibleRows);
  expect(atMax.end).toBe(lines.length);
  for (const offset of [maxOffset + 1, lines.length - 1, lines.length + 5]) {
    expect(lineWindow(lines, offset, visibleRows)).toEqual(atMax);
  }
});

test("the window never paints more than visibleRows for any offset", () => {
  const lines = buildLines(
    Array.from({ length: 30 }, (_, i) => block({ type: "text", content: `line-${i}` })),
    200,
    false,
    () => false,
  );
  const visibleRows = 6;
  for (let offset = -3; offset <= lines.length + 3; offset++) {
    const { start, end } = lineWindow(lines, offset, visibleRows);
    expect(end - start).toBeLessThanOrEqual(visibleRows);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(lines.length);
  }
});

test("EventLog windows visible blocks by scrollOffset", () => {
  const blocks: ContentBlock[] = Array.from({ length: 10 }, (_, i) => ({
    type: "text" as const,
    content: `line-${i}`,
  }));
  const { lastFrame } = renderLog(blocks, { scrollOffset: 0, visibleRows: 3 });
  const frame = lastFrame() ?? "";
  // Offset zero starts at the oldest line and paints forward within the row
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

test("buildLines explodes a multi-line text block into one line per visual row", () => {
  const lines = buildLines([block({ type: "text", content: "a\nb\nc" })], 200, false, () => false);
  expect(lines.length).toBe(3);
});

test("buildLines inserts a blank spacer line between conversational turns", () => {
  const lines = buildLines(
    [block({ type: "user", content: "hi" }), block({ type: "text", content: "reply" })],
    200,
    false,
    () => false,
  );
  expect(lines.length).toBe(3);
  expect(lineText(lines[1]!)).toBe("");
});

test("an expanded shell command wraps into rows that each fit the width", () => {
  const cmd = "echo " + "y".repeat(60);
  const columns = 30;
  const lines = buildLines(
    [block({ type: "tool_call", name: "run_shell", arguments: JSON.stringify({ command: cmd }) })],
    columns,
    false,
    () => true,
  );
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(lineText(line).length).toBeLessThanOrEqual(columns - 2);
});

test("a wrapped line becomes one single-row line per visual row", () => {
  // One logical line far longer than the pane: every line it produces must be a
  // single row so the scroll window can step one terminal row at a time.
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const columns = 24;
  const lines = buildLines([block({ type: "text", content: long })], columns, false, () => false);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(lineText(line).length).toBeLessThanOrEqual(columns - 2);
});

test("inline styling survives across a wrap boundary", () => {
  // The bold span sits late in a line that must wrap, so it lands on a later
  // visual row. Slicing segments per row must keep the styled text intact.
  const content = "padding ".repeat(8) + "**emphasised**";
  const { lastFrame } = renderLog([{ type: "text", content }], { columns: 30 });
  const frame = lastFrame() ?? "";
  expect(frame).toContain("emphasised");
});

test("wrapLines preserves leading indentation on the first row", () => {
  const rows = wrapLines("    indented code line that is quite long here", 20);
  expect(rows.length).toBeGreaterThan(1);
  expect(rows[0]!.startsWith("    ")).toBe(true);
});

test("wrapLines hard-breaks a word longer than the width without losing characters", () => {
  const rows = wrapLines("x".repeat(50), 20);
  expect(rows.join("")).toBe("x".repeat(50));
  expect(rows.every((r) => r.length <= 20)).toBe(true);
});

test("lineWindow advances one line per scroll step", () => {
  const lines = buildLines(
    Array.from({ length: 6 }, (_, i) => block({ type: "text", content: `line-${i}` })),
    200,
    false,
    () => false,
  );
  const w0 = lineWindow(lines, 0, 3);
  const w1 = lineWindow(lines, 1, 3);
  expect(w1.start).toBe(w0.start + 1);
});
