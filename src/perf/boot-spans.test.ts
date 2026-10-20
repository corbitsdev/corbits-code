import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { main, mainWithRunners } from "../index.js";
import {
  resetPricingMetadataRefreshForTests,
  schedulePricingMetadataRefresh,
} from "../cost/pricing-metadata.js";
import { clear, snapshot, type PerfSpan } from "./index.js";
import { endBootSpans, startBootSpans } from "./boot-spans.js";
import { createHarness } from "../tui/harness.js";
import { mountRunnerHost } from "../tui/runner/host.js";

function bootPair(spans: readonly PerfSpan[]): PerfSpan[] {
  return spans.filter(
    (span) => span.name === "boot" || span.name === "first-paint",
  );
}

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

let sandbox: string | undefined;

afterEach(() => {
  if (sandbox !== undefined) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

function sandboxArgs(
  subcommand: readonly string[],
  rest: readonly string[] = [],
): string[] {
  const root = mkdtempSync(join(tmpdir(), "boot-span-"));
  sandbox = root;
  const settingsDir = join(root, "home", ".corbits");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseURL: "http://localhost:1234",
          apiKey: "test-key",
          models: ["test-model"],
          defaultModel: "test-model",
        },
      },
      defaultProvider: "test-provider",
    }),
  );
  mkdirSync(join(root, "project"), { recursive: true });
  resetPricingMetadataRefreshForTests();
  schedulePricingMetadataRefresh({
    cachePath: join(settingsDir, "cache", "models-pricing.json"),
    fetchImpl: () => Promise.reject(new Error("network disabled in tests")),
  });
  return [
    ...subcommand,
    "--cwd",
    join(root, "project"),
    "--config",
    join(settingsDir, "settings.json"),
    ...rest,
  ];
}

test("exec closes boot spans before returning, without a TUI mount", async () => {
  clear();
  endBootSpans();
  const code = await mainWithRunners(sandboxArgs(["exec"], ["say hello"]), {
    runTUI: async () => 0,
    runExec: async () => 0,
    runOnboarding: async () => 0,
  });
  expect(code).toBe(0);
  const pair = bootPair(snapshot());
  expect(pair).toHaveLength(2);
  expect(pair.every((span) => span.endNs !== undefined)).toBe(true);
  clear();
});

test("a TUI that already closed boot spans is not ended twice", async () => {
  clear();
  endBootSpans();
  let closedAt: bigint | undefined;
  const code = await mainWithRunners(sandboxArgs([]), {
    runTUI: async () => {
      endBootSpans();
      closedAt = snapshot().find((span) => span.name === "boot")?.endNs;
      return 0;
    },
    runExec: async () => 0,
    runOnboarding: async () => 0,
  });
  expect(code).toBe(0);
  const boot = snapshot().find((span) => span.name === "boot");
  expect(boot?.endNs).toBe(closedAt);
  expect(bootPair(snapshot())).toHaveLength(2);
  clear();
});
