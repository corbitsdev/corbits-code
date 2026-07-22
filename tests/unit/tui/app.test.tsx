import { test, expect, mock } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../../../src/tui/app.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { Agent } from "@intx/agent";
import { loadSettings } from "../../../src/config/settings.js";
import type { ProviderCatalogEntry } from "../../../src/config/index.js";

const mockAgent = {
  send: mock(() => Promise.resolve({ reply: "ok", turn: {} as unknown as ReactorEmittedEvent["data"] })),
  stream: mock(() => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) })),
  close: mock(() => Promise.resolve()),
  setSource: mock(() => undefined),
  setSources: mock(() => undefined),
};

const testProvider: ProviderCatalogEntry = {
  name: "test-provider",
  baseURL: "https://test/v1",
  apiKey: "test-key",
  models: ["test-model"],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function dismissStartupAnimation(stdin: { write: (input: string) => void }): Promise<void> {
  stdin.write(" ");
  await tick();
}

type RenderAppOptions = {
  stdout?: { columns: number; rows: number };
  initialTask?: string;
  sessionTitle?: string;
  initialModel?: string;
  initialProvider?: string;
  providers?: ProviderCatalogEntry[];
  globalSettingsPath?: string;
  globalDefaultProvider?: string;
  cwd?: string;
  agent?: Agent;
};

function renderApp(emitter: EventEmitter, options?: RenderAppOptions) {
  const {
    stdout,
    initialTask,
    sessionTitle,
    initialModel,
    initialProvider,
    providers,
    globalSettingsPath,
    globalDefaultProvider,
    cwd,
    agent,
  } = options ?? {};
  return render(
    <App
      eventEmitter={emitter}
      agent={(agent ?? mockAgent) as unknown as Agent}
      sessionTitle={sessionTitle ?? ""}
      initialModel={initialModel ?? "test-model"}
      initialProvider={initialProvider ?? "test-provider"}
      providers={providers ?? [testProvider]}
      globalSettingsPath={globalSettingsPath ?? "/tmp/corbits-test-settings.json"}
      globalDefaultProvider={globalDefaultProvider ?? "test-provider"}
      globallyOnboarded={true}
      cwd={cwd ?? "/tmp"}
      initialTask={initialTask ?? ""}
    />,
    { stdout: stdout ?? { columns: 80, rows: 24 } },
  );
}

async function renderAppReady(emitter: EventEmitter, options?: RenderAppOptions) {
  const view = renderApp(emitter, options);
  await dismissStartupAnimation(view.stdin);
  return view;
}

test("App renders header and status bar", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter);
  expect(lastFrame()).toContain("Corbits Code");
  expect(lastFrame()).toContain("test-model");
});

test("App status bar shows cost for a metered provider", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("$");
  expect(frame).toContain("Ctx");
});

test("App status bar hides cost for a coding-plan provider base URL", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter, {
    providers: [{ ...testProvider, baseURL: "https://api.z.ai/api/coding/paas/v4" }],
  });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("$");
  expect(frame).toContain("Ctx");
});

test("App status bar hides cost for a provider marked free", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter, {
    providers: [{ ...testProvider, free: true }],
  });
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("$");
  expect(frame).toContain("Ctx");
});

test("App renders chat input", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter);
  expect(lastFrame()).toContain("> ");
});

test("App renders events after they are emitted", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });

  const event: ReactorEmittedEvent = {
    type: "inference.tool_call.start",
    seq: 1,
    data: { name: "read_file", callId: "c1" } as unknown as ReactorEmittedEvent["data"],
  };

  emitter.emit("event", event);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lastFrame()).toContain("Read");
});

test("App renders a submitted prompt once, not in both header and log", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });

  emitter.emit("event", {
    type: "message.received",
    seq: 1,
    data: { message: { content: "hello world" } } as unknown as ReactorEmittedEvent["data"],
  } satisfies ReactorEmittedEvent);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const frame = lastFrame() ?? "";
  expect(frame.match(/hello world/g)?.length ?? 0).toBe(1);
  expect(frame).not.toMatch(/> hello world/);
});

test("App hides the running status label in the status bar", async () => {
  const emitter = new EventEmitter();
  const { lastFrame } = await renderAppReady(emitter);
  expect(lastFrame()).not.toContain("Running");
});

async function writeKeys(stdin: { write: (input: string) => void }, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
}

test("CTRL+C with text in the prompt clears the input and does not open exit confirm", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("hello");
  await tick();
  expect(lastFrame()).toContain("hello");
  stdin.write("\x03");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("Exit Corbits Code?");
  expect(frame).not.toContain("hello");
});

const settleRun = (emitter: EventEmitter) =>
  emitter.emit("event", { type: "reactor.done", seq: 1, data: {} } as ReactorEmittedEvent);

test("CTRL+C while the agent is running stops the run instead of exiting", async () => {
  const emitter = new EventEmitter();
  const hangingAgent = {
    ...mockAgent,
    send: mock(() => new Promise(() => undefined)),
  } as unknown as Agent;
  const { stdin, lastFrame } = await renderAppReady(emitter, {
    stdout: { columns: 120, rows: 30 },
    initialTask: "go",
    agent: hangingAgent,
  });
  await tick();
  stdin.write("\x03");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).not.toContain("Exit Corbits Code?");
  expect(frame).toContain("Corbits Code");
});

test("a second CTRL+C after a stop escalates to the exit confirm", async () => {
  const emitter = new EventEmitter();
  const hangingAgent = {
    ...mockAgent,
    send: mock(() => new Promise(() => undefined)),
  } as unknown as Agent;
  const { stdin, lastFrame } = await renderAppReady(emitter, {
    stdout: { columns: 120, rows: 30 },
    initialTask: "go",
    agent: hangingAgent,
  });
  await tick();
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).not.toContain("Exit Corbits Code?");
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Exit Corbits Code?");
});

test("CTRL+C with an empty prompt opens the exit confirm overlay once idle", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });
  settleRun(emitter);
  await tick();
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Exit Corbits Code?");
});

test("exit confirm cancels on N and closes the overlay", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });
  settleRun(emitter);
  await tick();
  stdin.write("\x03");
  await tick();
  expect(lastFrame()).toContain("Exit Corbits Code?");
  stdin.write("n");
  await tick();
  expect(lastFrame()).not.toContain("Exit Corbits Code?");
});

test("ESC never opens the exit confirm overlay", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });
  stdin.write("\x1B");
  await tick();
  expect(lastFrame()).not.toContain("Exit Corbits Code?");
});

test("double ESC within the window clears the prompt", async () => {
  const emitter = new EventEmitter();
  const { stdin, lastFrame } = await renderAppReady(emitter, { stdout: { columns: 120, rows: 30 } });
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
  const { lastFrame } = await renderAppReady(emitter, {
    stdout: { columns: 100, rows: 12 },
    sessionTitle: "scroll test",
  });

  for (let i = 0; i < 25; i++) {
    emitter.emit("event", {
      type: "inference.tool_call.start",
      seq: i + 1,
      data: { name: `tool_${i}`, callId: `call_${i}` } as unknown as ReactorEmittedEvent["data"],
    } satisfies ReactorEmittedEvent);
  }

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(lastFrame()).toContain("Corbits Code");
  expect(lastFrame()).toContain("> ");
  expect(lastFrame()).toContain("test-model");
});

test("App does not scroll the event log with arrow keys (arrows belong to the prompt box)", async () => {
  const emitter = new EventEmitter();
  const { lastFrame, stdin } = await renderAppReady(emitter, { stdout: { columns: 100, rows: 20 } });

  for (let i = 0; i < 20; i++) {
    emitter.emit("event", {
      type: "message.received",
      seq: i + 1,
      data: { message: { content: `prompt-${i}` } } as unknown as ReactorEmittedEvent["data"],
    } satisfies ReactorEmittedEvent);
  }
  await tick();
  expect(lastFrame()).toContain("prompt-19");

  for (let i = 0; i < 60; i++) {
    stdin.write("\x1B[A");
    await tick();
  }
  // Arrow keys no longer scroll the log — pinned-to-bottom content stays visible.
  expect(lastFrame()).toContain("prompt-19");
});

test("/model editing a non-default provider preserves the global default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ic-agent-settings-"));
  try {
    const emitter = new EventEmitter();
    const globalSettingsPath = join(dir, "settings.json");
    await writeFile(
      globalSettingsPath,
      JSON.stringify({ defaultProvider: "a", providers: {} }),
      "utf8",
    );
    const multiProviders = [
      { name: "a", baseURL: "https://a/v1", apiKey: "a-key", models: ["a-model"] },
      { name: "b", baseURL: "https://b/v1", apiKey: "b-key", models: ["b-model"] },
    ];
    const { stdin } = await renderAppReady(emitter, {
      stdout: { columns: 120, rows: 30 },
      initialModel: "b-model",
      initialProvider: "b",
      providers: multiProviders,
      globalSettingsPath,
      globalDefaultProvider: "a",
      cwd: dir,
    });

    settleRun(emitter);
    await tick();
    await writeKeys(stdin, ["/model", "\r", "e", "\r", "\r", "\r", "\r", "\r"]);
    await tick();

    expect((await loadSettings(globalSettingsPath))?.defaultProvider).toBe("a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/model deleting a non-default provider preserves the global default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ic-agent-settings-"));
  try {
    const emitter = new EventEmitter();
    const globalSettingsPath = join(dir, "settings.json");
    await writeFile(
      globalSettingsPath,
      JSON.stringify({ defaultProvider: "a", providers: {} }),
      "utf8",
    );
    const multiProviders = [
      { name: "a", baseURL: "https://a/v1", apiKey: "a-key", models: ["a-model"] },
      { name: "b", baseURL: "https://b/v1", apiKey: "b-key", models: ["b-model"] },
    ];
    const { stdin } = await renderAppReady(emitter, {
      stdout: { columns: 120, rows: 30 },
      initialModel: "b-model",
      initialProvider: "b",
      providers: multiProviders,
      globalSettingsPath,
      globalDefaultProvider: "a",
      cwd: dir,
    });

    settleRun(emitter);
    await tick();
    await writeKeys(stdin, ["/model", "\r", "x", "y"]);
    await tick();

    const settings = await loadSettings(globalSettingsPath);
    expect(settings?.defaultProvider).toBe("a");
    expect(settings?.providers.b).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
