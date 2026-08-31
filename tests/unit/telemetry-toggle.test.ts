import { test, expect } from "bun:test";
import {
  createTelemetryToggleHandler,
  type TelemetryToggleDeps,
} from "../../src/telemetry/toggle.js";
import { createTelemetry, getSessionId } from "../../src/telemetry/index.js";
import type { Settings } from "../../src/config/settings.js";
import type { Telemetry } from "../../src/telemetry/index.js";

function fakeDeps(overrides: Partial<TelemetryToggleDeps> = {}): {
  deps: TelemetryToggleDeps;
  getInstance: () => Telemetry;
  fetchCalls: () => number;
} {
  let instance: Telemetry = createTelemetry({
    settings: { providers: {}, telemetry: { enabled: true, installationId: "id" } },
    env: {},
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
    loadSettings: async () => ({
      providers: {},
      telemetry: { enabled: true, installationId: "id" },
    }),
    telemetryDisabledByEnv: () => false,
    ensureTelemetrySettings: async () => ({
      providers: {},
      telemetry: { enabled: true, installationId: "id" },
    }),
    saveGlobalSettings: async () => {},
    // env is pinned to {} (matching telemetry.test.ts) so a developer's real
    // DO_NOT_TRACK / CORBITS_TELEMETRY never bleeds into these tests.
    createTelemetry: (opts) =>
      createTelemetry({ ...opts, env: opts.env ?? {}, apiKey: opts.apiKey ?? "test-key", fetchFn }),
    ...overrides,
  };
  return { deps, getInstance: () => instance, fetchCalls: () => calls };
}

test("queued enable cannot publish after a later opt-out while disable load is blocked", async () => {
  let releaseEnable: (() => void) | undefined;
  let releaseDisableLoad: (() => void) | undefined;
  let signalEnableStarted: (() => void) | undefined;
  let signalDisableLoadStarted: (() => void) | undefined;
  const enableStarted = new Promise<void>((resolve) => {
    signalEnableStarted = resolve;
  });
  const disableLoadStarted = new Promise<void>((resolve) => {
    signalDisableLoadStarted = resolve;
  });
  const published: boolean[] = [];
  const { deps, getInstance, fetchCalls } = fakeDeps({
    setTelemetry: (telemetry) => {
      published.push(telemetry.enabled);
      current = telemetry;
    },
    getTelemetry: () => current,
    ensureTelemetrySettings: async () => {
      signalEnableStarted?.();
      await new Promise<void>((resolve) => {
        releaseEnable = resolve;
      });
      return { providers: {}, telemetry: { enabled: true, installationId: "id" } };
    },
    loadSettings: async () => {
      signalDisableLoadStarted?.();
      await new Promise<void>((resolve) => {
        releaseDisableLoad = resolve;
      });
      return { providers: {}, telemetry: { enabled: true, installationId: "id" } };
    },
  });
  let current = getInstance();
  let tail = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const handler = createTelemetryToggleHandler("/fake/path", deps, enqueue);

  handler(true);
  await enableStarted;
  handler(false);
  const publishedAfterOff = published.length;
  releaseEnable?.();
  await disableLoadStarted;

  expect(published.slice(publishedAfterOff)).not.toContain(true);
  expect(current.enabled).toBe(false);
  current.capture("cli_start");
  await current.flush();
  expect(fetchCalls()).toBe(0);

  releaseDisableLoad?.();
  await tail;
});

test("toggle off disables the singleton synchronously, before any await", () => {
  const { deps, getInstance } = fakeDeps();
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  expect(handler(false)).toBe(true);
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

// Opting out is a statement about activity already generated, not only about
// activity to come: events captured before the toggle must never be sent
// afterwards. Dropping the singleton is not enough on its own — the outgoing
// instance's batch timer would still fire and post its queue — so this test
// guards the explicit discard. If a future change makes opt-out flush what it
// was holding, this fails, and that is the point.
test("opting out discards events captured before the toggle instead of sending them", async () => {
  let sends = 0;
  const fetchFn = (() => {
    sends++;
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const { deps, getInstance } = fakeDeps({
    createTelemetry: (opts) =>
      createTelemetry({
        ...opts,
        env: opts.env ?? {},
        apiKey: opts.apiKey ?? "test-key",
        fetchFn,
        // Short enough that an undiscarded queue would reach the network well
        // inside this test's wait, rather than passing by outrunning a timer.
        batch: { intervalMs: 20 },
      }),
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);

  handler(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  getInstance().capture("cli_start");
  expect(sends).toBe(0);

  handler(false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(getInstance().enabled).toBe(false);
  expect(sends).toBe(0);
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

test("toggle on while env-killed writes nothing and swaps no instance", async () => {
  let ensureCalled = false;
  let saveCalled = false;
  const initial: Telemetry = {
    enabled: false,
    installationId: "",
    capture: () => {},
    captureIntentional: () => false,
    flush: async () => {},
    discard: () => {},
  };
  let setInstance: Telemetry | undefined;
  const { deps } = fakeDeps({
    getTelemetry: () => initial,
    setTelemetry: (t) => {
      setInstance = t;
    },
    telemetryDisabledByEnv: () => true,
    ensureTelemetrySettings: async () => {
      ensureCalled = true;
      return { providers: {} };
    },
    saveGlobalSettings: async () => {
      saveCalled = true;
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  expect(handler(true)).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ensureCalled).toBe(false);
  expect(saveCalled).toBe(false);
  expect(setInstance).toBeUndefined();
});

test("toggle off still persists while env-killed", async () => {
  let saved: Settings | undefined;
  const { deps, getInstance } = fakeDeps({
    telemetryDisabledByEnv: () => true,
    saveGlobalSettings: async (_path, settings) => {
      saved = settings;
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(saved?.telemetry?.enabled).toBe(false);
  expect(getInstance().enabled).toBe(false);
});

test("toggle on generates an installationId when the on-disk settings lack one", async () => {
  let saved: Settings | undefined;
  const { deps, getInstance } = fakeDeps({
    ensureTelemetrySettings: async () => ({
      providers: {},
      telemetry: { installationId: "fresh-id" },
    }),
    saveGlobalSettings: async (_path, settings) => {
      saved = settings;
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(saved?.telemetry?.installationId).toBe("fresh-id");
  expect(saved?.telemetry?.enabled).toBe(true);
  expect(getInstance().enabled).toBe(true);
});

test("toggle on failure to ensure settings skips persistence and leaves the instance unchanged", async () => {
  let saveCalled = false;
  const { deps, getInstance } = fakeDeps({
    ensureTelemetrySettings: async () => {
      throw new Error("disk full");
    },
    saveGlobalSettings: async () => {
      saveCalled = true;
    },
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);
  handler(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(saveCalled).toBe(false);
  expect(getInstance().enabled).toBe(true);
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

test("session_id on captured payloads stays constant across an enable/disable/enable toggle cycle", async () => {
  const capturedBodies: { batch: { properties: Record<string, unknown> }[] }[] = [];
  const fetchFn = ((_url: string, init: RequestInit) => {
    capturedBodies.push(JSON.parse(init.body as string));
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const { deps, getInstance } = fakeDeps({
    createTelemetry: (opts) =>
      createTelemetry({ ...opts, env: opts.env ?? {}, apiKey: opts.apiKey ?? "test-key", fetchFn }),
  });
  const handler = createTelemetryToggleHandler("/fake/path", deps);

  // Re-enable once up front so the captured instance is one built through
  // deps.createTelemetry (and thus fetchFn) rather than fakeDeps' bootstrap
  // instance, which is wired to its own separate fetch counter.
  handler(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  getInstance().capture("cli_start");
  // Toggling off discards the outgoing instance and its queue, so anything
  // captured before it has to leave the process first.
  await getInstance().flush();

  handler(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  getInstance().capture("cli_start"); // disabled: no fetch, but proves the swapped instance is live

  handler(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  getInstance().capture("cli_start");
  await getInstance().flush();

  expect(capturedBodies.length).toBe(2);
  const sessionId = capturedBodies[0]!.batch[0]!.properties.session_id;
  expect(typeof sessionId).toBe("string");
  expect((sessionId as string).length).toBeGreaterThan(0);
  expect(capturedBodies[1]!.batch[0]!.properties.session_id).toBe(sessionId);
  expect(sessionId).toBe(getSessionId());
});
