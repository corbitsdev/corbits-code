import { test, expect } from "bun:test";
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
});

test("EventLog renders thinking block", () => {
  const { lastFrame } = render(<EventLog contentBlocks={makeBlocks([{ type: "thinking", content: "Hmm..." }])} />);
  expect(lastFrame()).toContain("Hmm...");
});

test("EventLog renders text block", () => {
  const { lastFrame } = render(<EventLog contentBlocks={makeBlocks([{ type: "text", content: "Hello!" }])} />);
  expect(lastFrame()).toContain("Hello!");
});

test("EventLog renders tool call block", () => {
  const { lastFrame } = render(
    <EventLog contentBlocks={makeBlocks([{ type: "tool_call", name: "read_file", arguments: '{"path":"x"}' }])} />,
  );
  expect(lastFrame()).toContain("read_file");
});

test("EventLog renders tool result block", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([{ type: "tool_result", callId: "c1", name: "read_file", content: "ok", isError: false }])}
    />,
  );
  expect(lastFrame()).toContain("ok");
});

test("EventLog renders error block", () => {
  const { lastFrame } = render(
    <EventLog contentBlocks={makeBlocks([{ type: "error", message: "fatal: oops" }])} />,
  );
  expect(lastFrame()).toContain("fatal: oops");
});

test("EventLog renders multiple blocks", () => {
  const { lastFrame } = render(
    <EventLog
      contentBlocks={makeBlocks([
        { type: "user", content: "do it" },
        { type: "tool_call", name: "read_file", arguments: "" },
        { type: "tool_result", callId: "c1", name: "read_file", content: "done", isError: false },
      ])}
    />,
  );
  expect(lastFrame()).toContain("> do it");
  expect(lastFrame()).toContain("read_file");
  expect(lastFrame()).toContain("done");
});
