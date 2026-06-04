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
      initialModel="test-model"
      initialProvider="test-provider"
      providers={[{ name: "test-provider", baseURL: "https://test/v1", apiKey: "test-key", models: ["test-model"] }]}
      globalSettingsPath="/tmp/interchange-code-test-settings.json"
      cwd="/tmp"
    />,
    options,
  );
}

test("App renders header and status bar", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter);
  expect(lastFrame()).toContain("Intercode");
  expect(lastFrame()).toContain("test-model");
});

test("App renders chat input", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter);
  expect(lastFrame()).toContain("> ");
});

test("App renders events after they are emitted", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });

  const event: ReactorEmittedEvent = {
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  };

  emitter.emit("event", event);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lastFrame()).toContain("Read");
});

test("App renders running status initially", () => {
  const emitter = new EventEmitter();
  const { lastFrame } = renderApp(emitter);
  expect(lastFrame()).toContain("Running");
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("CTRL+C with text in the prompt clears the input and does not open exit confirm", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("hello");
  await tick();
  expect(lastFrame()).toContain("hello");
  stdin.write("\x03");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("Exit Intercode?");
  expect(frame).not.toContain("hello");
});

const settleRun = (emitter: EventEmitter) =>
  emitter.emit("event", { type: "reactor.done", seq: 1, data: {} } as ReactorEmittedEvent);

test("CTRL+C while the agent is running stops the run instead of exiting", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("\x03");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Stopping");
  expect(frame).not.toContain("Exit Intercode?");
});

test("a second CTRL+C while stopping escalates to the exit confirm", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Stopping");
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Exit Intercode?");
});

test("CTRL+C with an empty prompt opens the exit confirm overlay once idle", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  settleRun(emitter);
  await tick();
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Exit Intercode?");
});

test("exit confirm cancels on N and closes the overlay", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  settleRun(emitter);
  await tick();
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Exit Intercode?");
  stdin.write("n");
  await tick();
  expect(lastFrame()).not.toContain("Exit Intercode?");
});

test("ESC never opens the exit confirm overlay", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("\x1B");
  await tick();
  expect(lastFrame()).not.toContain("Exit Intercode?");
});

test("double ESC within the window clears the prompt", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = renderApp(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("draft text");
  await tick();
  expect(lastFrame()).toContain("draft text");
  stdin.write("\x1B");
  await tick();
  stdin.write("\x1B");
  await tick();
  expect(lastFrame()).not.toContain("draft text");
});

test("App keeps header and footer visible after many events", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = render(
    <App
      eventEmitter={emitter}
      agent={mockAgent as unknown as Agent}
      sessionTitle="scroll test"
      initialModel="test-model"
      initialProvider="test-provider"
      providers={[{ name: "test-provider", baseURL: "https://test/v1", apiKey: "test-key", models: ["test-model"] }]}
      globalSettingsPath="/tmp/interchange-code-test-settings.json"
      cwd="/tmp"
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
  expect(lastFrame()).toContain("Intercode");
  expect(lastFrame()).toContain("scroll test");
  expect(lastFrame()).toContain("> ");
  expect(lastFrame()).toContain("test-model");
});
