import { test, expect } from "bun:test";
import {
  activateHeldTelemetry,
  telemetryFirstRunPending,
  type FirstRunDeps,
} from "../../src/adapters/telemetry/first-run.js";
import { createTelemetry, type Telemetry } from "../../src/adapters/telemetry/index.js";
import type { Settings } from "../../src/config/settings.js";

function settingsWith(overrides: Settings["telemetry"] = {}): Settings {
  return { providers: {}, telemetry: { installationId: "id", ...overrides } };
}

function fakeDeps(overrides: Partial<FirstRunDeps> = {}): {
  deps: FirstRunDeps;
  getInstance: () => Telemetry | undefined;
  fetchCalls: () => number;
  markCalls: () => number;
} {
  let instance: Telemetry | undefined;
  let calls = 0;
  let marks = 0;
  const fetchFn = (() => {
    calls++;
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;

  const deps: FirstRunDeps = {
    loadSettings: async () => settingsWith(),
    markTelemetryNoticeShown: async () => {
      marks++;
    },
    createTelemetry: (opts) => createTelemetry({ ...opts, env: {}, apiKey: "test-key", fetchFn }),
    setTelemetry: (t) => {
      instance = t;
    },
    ...overrides,
  };
  return { deps, getInstance: () => instance, fetchCalls: () => calls, markCalls: () => marks };
}

test("telemetryFirstRunPending is true only when enabled and notice never shown", () => {
  expect(telemetryFirstRunPending(settingsWith(), {})).toBe(true);
  expect(telemetryFirstRunPending(settingsWith({ noticeShown: true }), {})).toBe(false);
  expect(telemetryFirstRunPending(settingsWith({ enabled: false }), {})).toBe(false);
  expect(telemetryFirstRunPending({ providers: {} }, {})).toBe(false);
  expect(telemetryFirstRunPending(settingsWith(), { DO_NOT_TRACK: "1" })).toBe(false);
});

test("an opt-out during activation's async window wins: no swap, no send", async () => {
  let intent = true;
  const { deps, getInstance, fetchCalls } = fakeDeps({
    loadSettings: async () => {
      // The user opts out while activation is reading settings from disk;
      // the toggle has already swapped in a disabled singleton and the
      // activation must not clobber it.
      intent = false;
      return settingsWith();
    },
  });
  await activateHeldTelemetry("/fake/path", () => intent, deps);
  expect(getInstance()).toBeUndefined();
  expect(fetchCalls()).toBe(0);
});

test("activation stamps the notice, swaps the singleton, and fires cli_start", async () => {
  const { deps, getInstance, fetchCalls, markCalls } = fakeDeps();
  await activateHeldTelemetry("/fake/path", () => true, deps);
  expect(markCalls()).toBe(1);
  expect(getInstance()?.enabled).toBe(true);
  await getInstance()?.flush();
  expect(fetchCalls()).toBe(1);
});

test("activation after an opt-out landed on disk sends nothing", async () => {
  const { deps, getInstance, fetchCalls } = fakeDeps({
    loadSettings: async () => settingsWith({ enabled: false }),
  });
  await activateHeldTelemetry("/fake/path", () => true, deps);
  expect(getInstance()?.enabled).toBe(false);
  expect(fetchCalls()).toBe(0);
});

test("activation stays held when settings cannot be read", async () => {
  const { deps, getInstance, fetchCalls } = fakeDeps({
    loadSettings: async () => {
      throw new Error("corrupt json");
    },
  });
  await activateHeldTelemetry("/fake/path", () => true, deps);
  expect(getInstance()).toBeUndefined();
  expect(fetchCalls()).toBe(0);
});

test("a failed notice stamp does not block activation", async () => {
  const { deps, getInstance, fetchCalls } = fakeDeps({
    markTelemetryNoticeShown: async () => {
      throw new Error("disk full");
    },
  });
  await activateHeldTelemetry("/fake/path", () => true, deps);
  expect(getInstance()?.enabled).toBe(true);
  await getInstance()?.flush();
  expect(fetchCalls()).toBe(1);
});
