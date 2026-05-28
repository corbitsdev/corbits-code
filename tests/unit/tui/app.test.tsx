import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../../../src/tui/app.js";
import { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";

test("App renders header and status bar", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = render(<App eventEmitter={emitter} maxTurns={30} />);
  expect(lastFrame()).toContain("interchange-code");
  expect(lastFrame()).toContain("q");
});

test("App renders events after they are emitted", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = render(<App eventEmitter={emitter} maxTurns={30} />);

  const event: ReactorEmittedEvent = {
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file" } as unknown as ReactorEmittedEvent["data"],
  };

  emitter.emit("event", event);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(lastFrame()).toContain("read_file");
});

test("App renders running status initially", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = render(<App eventEmitter={emitter} maxTurns={30} />);
  expect(lastFrame()).toContain("running");
});
