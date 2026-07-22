import { test, expect } from "bun:test";
import { createTelemetry, resolveTelemetryEnabled } from "../../src/telemetry/index.js";
import type { Settings } from "../../src/config/settings.js";

function settingsWith(installationId?: string, enabled?: boolean): Settings {
  return {
    providers: {},
    telemetry: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(installationId !== undefined ? { installationId } : {}),
    },
  };
}

function fakeFetch(): { impl: typeof fetch; calls: () => number } {
  let count = 0;
  const impl = (() => {
    count++;
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls: () => count };
}

test("resolveTelemetryEnabled is false when settings.telemetry.enabled is false", () => {
  expect(resolveTelemetryEnabled(settingsWith("id", false), {})).toBe(false);
});

test("resolveTelemetryEnabled is false when INTERCODE_TELEMETRY=0", () => {
  expect(resolveTelemetryEnabled(settingsWith("id"), { INTERCODE_TELEMETRY: "0" })).toBe(false);
});

test("resolveTelemetryEnabled is false when DO_NOT_TRACK is truthy", () => {
  expect(resolveTelemetryEnabled(settingsWith("id"), { DO_NOT_TRACK: "1" })).toBe(false);
});

test("resolveTelemetryEnabled is false when installationId is missing", () => {
  expect(resolveTelemetryEnabled(settingsWith(undefined), {})).toBe(false);
});

test("createTelemetry never fetches when api key is empty (default)", () => {
  const { impl, calls } = fakeFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "",
  });
  telemetry.capture("cli_start");
  expect(calls()).toBe(0);
  expect(telemetry.enabled).toBe(false);
});

test("createTelemetry never fetches for any kill-switch combination", () => {
  const cases: [Settings, NodeJS.ProcessEnv][] = [
    [settingsWith("id", false), {}],
    [settingsWith("id"), { INTERCODE_TELEMETRY: "0" }],
    [settingsWith("id"), { DO_NOT_TRACK: "true" }],
    [settingsWith(undefined), {}],
  ];
  for (const [settings, env] of cases) {
    const { impl, calls } = fakeFetch();
    const telemetry = createTelemetry({ settings, env, fetchFn: impl, apiKey: "test-key" });
    telemetry.capture("cli_start");
    expect(calls()).toBe(0);
  }
});

test("capture rejects unknown event names", () => {
  const { impl, calls } = fakeFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("unknown_event" as never);
  expect(calls()).toBe(0);
});

test("capture strips properties not in the event's allowlist", async () => {
  const calls: unknown[] = [];
  const impl = ((_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("session_end", {
    status: "ok",
    turn_count: 3,
    duration_ms: 100,
    session_mode: "single",
    secret_field: "should-not-appear",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.length).toBe(1);
  const body = calls[0] as { properties: Record<string, unknown> };
  expect(body.properties.status).toBe("ok");
  expect(body.properties.turn_count).toBe(3);
  expect(body.properties.duration_ms).toBe(100);
  expect(body.properties.session_mode).toBe("single");
  expect(body.properties.secret_field).toBeUndefined();
});

test("capture payload shape includes distinct_id, geoip disable, and common props", async () => {
  const calls: unknown[] = [];
  const impl = ((_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const telemetry = createTelemetry({
    settings: settingsWith("my-install-id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("cli_start");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const body = calls[0] as {
    api_key: string;
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  };
  expect(body.api_key).toBe("test-key");
  expect(body.event).toBe("cli_start");
  expect(body.distinct_id).toBe("my-install-id");
  expect(body.properties.$geoip_disable).toBe(true);
  expect(body.properties.schema_version).toBe(1);
  expect(typeof body.properties.service_version).toBe("string");
  expect(body.properties.os_type).toBe(process.platform);
  expect(body.properties.os_arch).toBe(process.arch);
});
