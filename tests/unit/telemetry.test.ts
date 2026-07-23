import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetry, resolveTelemetryEnabled, telemetryDisabledByEnv } from "../../src/telemetry/index.js";
import { ensureTelemetrySettings } from "../../src/config/settings.js";
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

test("telemetryDisabledByEnv reflects env kills only", () => {
  expect(telemetryDisabledByEnv({})).toBe(false);
  expect(telemetryDisabledByEnv({ INTERCODE_TELEMETRY: "0" })).toBe(true);
  expect(telemetryDisabledByEnv({ DO_NOT_TRACK: "1" })).toBe(true);
  expect(telemetryDisabledByEnv({ DO_NOT_TRACK: "true" })).toBe(true);
  expect(telemetryDisabledByEnv({ DO_NOT_TRACK: "0" })).toBe(false);
});

test("telemetryDisabledByEnv treats any falsy INTERCODE_TELEMETRY value as disable", () => {
  for (const value of ["0", "false", "FALSE", "off", "no", ""]) {
    expect(telemetryDisabledByEnv({ INTERCODE_TELEMETRY: value })).toBe(true);
  }
  expect(telemetryDisabledByEnv({ INTERCODE_TELEMETRY: "1" })).toBe(false);
  expect(telemetryDisabledByEnv({ INTERCODE_TELEMETRY: "true" })).toBe(false);
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
    [settingsWith("id"), { DO_NOT_TRACK: "1" }],
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
    exit_reason: "done",
    secret_field: "should-not-appear",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.length).toBe(1);
  const body = calls[0] as { properties: Record<string, unknown> };
  expect(body.properties.status).toBe("ok");
  expect(body.properties.turn_count).toBe(3);
  expect(body.properties.duration_ms).toBe(100);
  expect(body.properties.session_mode).toBe("single");
  expect(body.properties.exit_reason).toBe("done");
  expect(body.properties.secret_field).toBeUndefined();
});

test("capture strips properties not in message_send's allowlist", async () => {
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
  telemetry.capture("message_send", {
    provider_id: "anthropic",
    model_id: "claude-x",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 1,
    cache_write_tokens: 2,
    thinking_tokens: 3,
    duration_ms: 400,
    prompt: "should-not-appear",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.length).toBe(1);
  const body = calls[0] as { event: string; properties: Record<string, unknown> };
  expect(body.event).toBe("message_send");
  expect(body.properties.provider_id).toBe("anthropic");
  expect(body.properties.model_id).toBe("claude-x");
  expect(body.properties.input_tokens).toBe(10);
  expect(body.properties.output_tokens).toBe(20);
  expect(body.properties.cache_read_tokens).toBe(1);
  expect(body.properties.cache_write_tokens).toBe(2);
  expect(body.properties.thinking_tokens).toBe(3);
  expect(body.properties.duration_ms).toBe(400);
  expect(body.properties.prompt).toBeUndefined();
});

test("capture payload shape includes distinct_id and common props, with no client-side geoip flag", async () => {
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
  expect(body.properties.$geoip_disable).toBeUndefined();
  expect(body.properties.schema_version).toBe(1);
  expect(typeof body.properties.service_version).toBe("string");
  expect(body.properties.os_type).toBe(process.platform);
  expect(body.properties.os_arch).toBe(process.arch);
});

test("flush resolves after pending captures settle", async () => {
  let resolveFetch: (() => void) | undefined;
  const impl = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = () => resolve(new Response("1", { status: 200 }));
    })) as unknown as typeof fetch;
  const telemetry = createTelemetry({ settings: settingsWith("id"), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("cli_start");
  let flushed = false;
  const flushPromise = telemetry.flush().then(() => {
    flushed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(flushed).toBe(false);

  resolveFetch?.();
  await flushPromise;
  expect(flushed).toBe(true);
});

test("flush gives up after its deadline when a request never settles", async () => {
  const impl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const telemetry = createTelemetry({ settings: settingsWith("id"), env: {}, fetchFn: impl, apiKey: "test-key" });
  telemetry.capture("cli_start");
  const start = Date.now();
  await telemetry.flush();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2000);
});

test("flush resolves even when the underlying fetch rejects", async () => {
  const impl = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
  const telemetry = createTelemetry({ settings: settingsWith("id"), env: {}, fetchFn: impl, apiKey: "test-key" });
  telemetry.capture("cli_start");
  await expect(telemetry.flush()).resolves.toBeUndefined();
});

test("flush resolves immediately when nothing is pending", async () => {
  const telemetry = createTelemetry({ settings: settingsWith("id"), env: {}, apiKey: "" });
  await expect(telemetry.flush()).resolves.toBeUndefined();
});

test("ensureTelemetrySettings called twice keeps installationId and enabled flag unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "intercode-telemetry-settings-"));
  const path = join(dir, "settings.json");
  try {
    const first = await ensureTelemetrySettings(path);
    expect(typeof first.telemetry?.installationId).toBe("string");
    expect(first.telemetry?.installationId.length).toBeGreaterThan(0);

    const second = await ensureTelemetrySettings(path);
    expect(second.telemetry?.installationId).toBe(first.telemetry?.installationId);
    expect(second.telemetry?.enabled).toBe(first.telemetry?.enabled);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
