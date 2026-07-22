import { test, expect } from "bun:test";
import { createTelemetryToggleHandler, type TelemetryToggleDeps } from "../../src/telemetry/toggle.js";
import { createTelemetry } from "../../src/telemetry/index.js";
import type { Settings } from "../../src/config/settings.js";
import type { Telemetry } from "../../src/telemetry/index.js";

function fakeDeps(overrides: Partial<TelemetryToggleDeps> = {}): {
  deps: TelemetryToggleDeps;
  getInstance: () => Telemetry;
  fetchCalls: () => number;
} {
  let instance: Telemetry = createTelemetry({
    settings: { providers: {}, telemetry: { enabled: true, installationId: "id" } },
    apiKey: "test-key",
  });
  let calls = 0;
  const fetchFn = (() => {
    calls++;
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;

  const deps: TelemetryToggleDeps = {
    getTelemetry: () => instance,
    setTelemetry: (t) => {
      instance = t;
    },
    loadSettings: async () => ({ providers: {}, telemetry: { enabled: true, installationId: "id" } }),
    saveGlobalSettings: async () => {},
    createTelemetry: (opts) => createTelemetry({ ...opts, apiKey: opts.apiKey ?? "test-key", fetchFn }),
    ...overrides,
  };
  return { deps, getInstance: () => instance, fetchCalls: () => calls };
}

test("toggle off disables the singleton synchronously, before any await", () => {
  const { deps, getInstance } = fakeDeps();
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(false);
  // No awaited microtask has run yet — assert on the return of the sync call.
  expect(getInstance().enabled).toBe(false);
});

test("capture called immediately after toggle-off makes zero fetch calls", () => {
  const { deps, getInstance, fetchCalls } = fakeDeps();
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(false);
  getInstance().capture("cli_start");
  expect(fetchCalls()).toBe(0);
});

test("save rejection leaves the singleton disabled with no unhandled rejection", async () => {
  const { deps, getInstance } = fakeDeps({
    saveGlobalSettings: async () => {
      throw new Error("disk full");
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(false);
  expect(getInstance().enabled).toBe(false);
  // Let the rejected async persistence path run to completion.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(getInstance().enabled).toBe(false);
});

test("load failure skips persistence entirely and stays disabled in memory", async () => {
  let saveCalled = false;
  const { deps, getInstance } = fakeDeps({
    loadSettings: async () => {
      throw new Error("corrupt json");
    },
    saveGlobalSettings: async () => {
      saveCalled = true;
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(saveCalled).toBe(false);
  expect(getInstance().enabled).toBe(false);
});

test("toggle on re-enables after settings load/save resolve", async () => {
  let saved: Settings | undefined;
  const { deps, getInstance } = fakeDeps({
    saveGlobalSettings: async (_path, settings) => {
      saved = settings;
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(saved?.telemetry?.enabled).toBe(true);
  expect(getInstance().enabled).toBe(true);
});
