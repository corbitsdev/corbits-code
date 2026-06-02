import { test, expect, mock } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../../../src/tui/app.js";
import { EventEmitter } from "node:events";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { Agent } from "@intx/agent";

const mockAgent = {
  send: mock(() => Promise.resolve({ reply: "ok", turn: {} as unknown as ReactorEmittedEvent["data"] })),
  stream: mock(() => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) })),
  close: mock(() => Promise.resolve()),
};

function renderApp(emitter: EventEmitter, options?: Parameters<typeof render>[1]) {
  return render(
    <App
      eventEmitter={emitter}
      agent={mockAgent as unknown as Agent}
      sessionTitle=""
      initialMode="teammate"
      initialModel="test-model"
      onModeChange={() => {}}
    />,
    options,
  );
}

test("App renders header and status bar", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter);
  expect(lastFrame()).toContain("interchange-code");
  expect(lastFrame()).toContain("Ctrl+C");
});

test("App renders chat input", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter);
  expect(lastFrame()).toContain("> ");
});

test("App renders events after they are emitted", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter);

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
  const { lastFrame } = renderApp(emitter);
  expect(lastFrame()).toContain("running");
});

test("App keeps header and footer visible after many events", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = render(
    <App
      eventEmitter={emitter}
      agent={mockAgent as unknown as Agent}
      sessionTitle="scroll test"
      initialMode="teammate"
      initialModel="test-model"
      onModeChange={() => {}}
    />,
    { stdout: { columns: 100, rows: 12 } },
  );

  for (let i = 0; i < 25; i++) {
    emitter.emit("event", {
      type: "inference.tool_call.start",
      seq: i + 1,
      data: { name: `tool_${i}`, callId: `call_${i}` } as unknown as ReactorEmittedEvent["data"],
    } satisfies ReactorEmittedEvent);
  }

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(lastFrame()).toContain("interchange-code");
  expect(lastFrame()).toContain("scroll test");
  expect(lastFrame()).toContain("> ");
  expect(lastFrame()).toContain("Ctrl+C");
});
