import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { EventLog } from "../../../src/tui/components/event-log.js";
import type { ReactorEmittedEvent } from "@intx/inference";

function makeEvent(type: string, data: unknown): ReactorEmittedEvent {
  return { type: type as ReactorEmittedEvent["type"], seq: 1, data: data as ReactorEmittedEvent["data"] };
}

test("EventLog renders empty message when no events", () => {
  const { lastFrame } = render(<EventLog events={[]} />);
  expect(lastFrame()).toContain("Waiting for events");
});

test("EventLog renders tool call start", () => {
  const events = [makeEvent("inference.tool_call.start", { name: "read_file" })];
  const { lastFrame } = render(<EventLog events={events} />);
  expect(lastFrame()).toContain("read_file");
});

test("EventLog renders tool done", () => {
  const events = [makeEvent("tool.done", { result: { callId: "c1", content: "ok", isError: false } })];
  const { lastFrame } = render(<EventLog events={events} />);
  expect(lastFrame()).toContain("ok");
});

test("EventLog renders error event", () => {
  const events = [makeEvent("inference.error", { error: { category: "fatal", message: "test error" } })];
  const { lastFrame } = render(<EventLog events={events} />);
  expect(lastFrame()).toContain("test error");
});

test("EventLog renders multiple events", () => {
  const events = [
    makeEvent("inference.tool_call.start", { name: "read_file" }),
    makeEvent("tool.done", { result: { callId: "c1", content: "ok", isError: false } }),
  ];
  const { lastFrame } = render(<EventLog events={events} />);
  expect(lastFrame()).toContain("read_file");
  expect(lastFrame()).toContain("ok");
});
