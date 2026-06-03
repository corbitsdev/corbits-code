import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { EventLog } from "../../../src/tui/components/event-log.js";
import type { ContentBlock } from "../../../src/tui/use-stream.js";

function makeBlocks(blocks: ContentBlock[]) {
  return blocks;
}

test("EventLog renders empty message when no blocks", () => {
  const { lastFrame } = render(<EventLog contentBlocks={[]} />);
  expect(lastFrame()).toContain("Waiting for events");
});

test("EventLog renders user message", () => {
  const { lastFrame } = render(<EventLog contentBlocks={makeBlocks([{ type: "user", content: "hello world" }])} />);
  expect(lastFrame()).toContain("> hello world");
  expect(lastFrame()).toContain("hello world");
});

test("EventLog renders text block", () => {
  const { lastFrame } = render(<EventLog contentBlocks={makeBlocks([{ type: "text", content: "Hello!" }])} />);
  expect(lastFrame()).toContain("Hello!");
});

test("EventLog renders human-readable visually distinct event types", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        { type: "user", content: "do it" },
        { type: "tool_call", name: "read_file", arguments: "{}" },
        { type: "tool_result", callId: "c1", name: "read_file", content: "done", isError: false },
        { type: "error", message: "fatal: oops" },
      ])}
    />,
  );

  const frame = lastFrame();
  expect(frame).toContain("> do it");
  expect(frame).toContain("read_file({})");
  expect(frame).toContain("done");
  expect(frame).toContain("fatal: oops");
  expect(frame).not.toContain("tool_call");
  expect(frame).not.toContain("tool_result");
});

test("EventLog formats tool calls with readable names and structured arguments", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        {
          type: "tool_call",
          name: "read_file",
          arguments: '{"path":"/tmp/example","explanation":"this is long enough to split arguments onto a separate indented line"}',
        },
      ])}
    />,
  );

  const frame = lastFrame();
  expect(frame).toContain("read_file(");
  expect(frame).toContain("\"path\":\"/tmp/example\"");
  expect(frame).toContain("separate indented line");
});

test("EventLog formats tool results by success and error state", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        { type: "tool_result", callId: "c1", name: "read_file", content: "ok", isError: false },
        { type: "tool_result", callId: "c2", name: "write_file", content: "permission denied", isError: true },
      ])}
    />,
  );

  const frame = lastFrame();
  expect(frame).toContain("ok");
  expect(frame).toContain("error: permission denied");
});

test("EventLog renders error block", () => {
  const { lastFrame } = render(
    <EventLog contentBlocks={makeBlocks([{ type: "error", message: "fatal: oops" }])} />,
  );
  expect(lastFrame()).toContain("fatal: oops");
});

test("EventLog renders long content", () => {
  const longContent = "x".repeat(1000);
  const { lastFrame } = render(<EventLog contentBlocks={makeBlocks([{ type: "text", content: longContent }])} />);

  const frame = lastFrame() ?? "";
  expect(frame.replace(/\s/g, "")).toContain(longContent);
});

test("EventLog filters out thinking blocks", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        { type: "thinking", content: "internal reasoning" },
        { type: "text", content: "Hello!" },
      ])}
    />,
  );
  expect(lastFrame()).not.toContain("internal reasoning");
  expect(lastFrame()).toContain("Hello!");
});

test("EventLog filters out reply blocks", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        { type: "text", content: "Hello!" },
        { type: "reply", content: "Hello!" },
      ])}
    />,
  );
  expect(lastFrame()).toContain("Hello!");
});

test("EventLog no longer renders the plan block inline", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        { type: "plan", steps: [{ file: "src/a.ts", action: "create" }] },
        { type: "user", content: "go" },
      ])}
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> go");
  expect(frame).not.toContain("src/a.ts");
});
