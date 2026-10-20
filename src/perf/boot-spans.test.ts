import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";

import { main } from "../index.js";
import { clear, snapshot } from "./index.js";
import { endBootSpans, startBootSpans } from "./boot-spans.js";
import { createHarness } from "../tui/harness.js";
import { mountRunnerHost } from "../tui/runner/host.js";

test("boot starts boot and first-paint spans before config exits", async () => {
  clear();
  endBootSpans();
  await expect(main(["--help"])).rejects.toThrow();
  const open = snapshot().filter((span) => span.endNs === undefined);
  expect(open.some((span) => span.name === "boot")).toBe(true);
  expect(open.some((span) => span.name === "first-paint")).toBe(true);
  endBootSpans();
  clear();
});

test("mount ends the boot and first-paint spans", async () => {
  clear();
  endBootSpans();
  startBootSpans();
  const harness = await createHarness({ width: 80, height: 24 });
  const host = await mountRunnerHost({
    title: "test",
    eventEmitter: new EventEmitter(),
    send: () => undefined,
    interrupt: () => undefined,
    deliver: () => undefined,
    providers: {},
    onModelSelect: () => undefined,
    commands: [],
    onCommand: () => undefined,
    chrome: () => ({ agents: [] }),
    subscribeChrome: () => () => undefined,
    subAgentSessions: () => [],
    createRenderer: async () => harness.renderer,
  });
  try {
    const done = snapshot().filter((span) => span.endNs !== undefined);
    expect(done.some((span) => span.name === "boot")).toBe(true);
    expect(done.some((span) => span.name === "first-paint")).toBe(true);
  } finally {
    host.dispose();
    harness.destroy();
    clear();
  }
});
