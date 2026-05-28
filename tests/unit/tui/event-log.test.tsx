import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { EventLog } from "../../../src/tui/components/event-log.js";
import type { ReactorEmittedEvent } from "@intx/inference";

function makeEvent(type: string, data: unknown): ReactorEmittedEvent {
  return { type: type as ReactorEmittedEvent["type"], seq: 1, data: data as ReactorEmittedEvent["data"] };
}

function makeLog(events: ReactorEmittedEvent[], userMessages: string[] = []) {
  const log = [];
  for (const msg of userMessages) {
    log.push({ type: "user" as const, content: msg, timestamp: Date.now() });
  }
  for (const event of events) {
    log.push({ type: "event" as const, event, timestamp: Date.now() });
  }
  return log;
}

test("EventLog renders empty message when no log", () => {
  const { lastFrame } = render(<EventLog log={[]} />);
  expect(lastFrame()).toContain("Waiting for events");
});

test("EventLog renders tool call start", () => {
  const events = [makeEvent("inference.tool_call.start", { name: "read_file" })];
  const { lastFrame } = render(<EventLog log={makeLog(events)} />);
  expect(lastFrame()).toContain("read_file");
});

test("EventLog renders tool done", () => {
  const events = [makeEvent("tool.done", { result: { callId: "c1", content: "ok", isError: false } })];
  const { lastFrame } = render(<EventLog log={makeLog(events)} />);
  expect(lastFrame()).toContain("ok");
});

test("EventLog renders error event", () => {
  const events = [makeEvent("inference.error", { error: { category: "fatal", message: "test error" } })];
  const { lastFrame } = render(<EventLog log={makeLog(events)} />);
  expect(lastFrame()).toContain("test error");
});

test("EventLog renders multiple events", () => {
  const events = [
    makeEvent("inference.tool_call.start", { name: "read_file" }),
    makeEvent("tool.done", { result: { callId: "c1", content: "ok", isError: false } }),
  ];
  const { lastFrame } = render(<EventLog log={makeLog(events)} />);
  expect(lastFrame()).toContain("read_file");
  expect(lastFrame()).toContain("ok");
});

test("EventLog renders user messages", () => {
  const { lastFrame } = render(<EventLog log={makeLog([], ["hello world"])} />);
  expect(lastFrame()).toContain("> hello world");
});

test("EventLog renders user messages and events together", () => {
  const events = [makeEvent("inference.tool_call.start", { name: "read_file" })];
  const { lastFrame } = render(<EventLog log={makeLog(events, ["hello world"])} />);
  expect(lastFrame()).toContain("> hello world");
  expect(lastFrame()).toContain("read_file");
});
