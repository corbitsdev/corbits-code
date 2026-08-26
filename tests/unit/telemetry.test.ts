import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelemetry,
  getSessionId,
  resolveTelemetryEnabled,
  telemetryDisabledByEnv,
} from "../../src/telemetry/index.js";
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

interface BatchBody {
  api_key: string;
  batch: { event: string; timestamp: string; properties: Record<string, unknown> }[];
}

function recordingFetch() {
  const bodies: BatchBody[] = [];
  const impl = ((_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as BatchBody);
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, bodies, events: () => bodies.flatMap((body) => body.batch) };
}

test("resolveTelemetryEnabled is false when settings.telemetry.enabled is false", () => {
  expect(resolveTelemetryEnabled(settingsWith("id", false), {})).toBe(false);
});

test("resolveTelemetryEnabled is false when CORBITS_TELEMETRY=0", () => {
  expect(resolveTelemetryEnabled(settingsWith("id"), { CORBITS_TELEMETRY: "0" })).toBe(false);
});

test("resolveTelemetryEnabled is false when DO_NOT_TRACK is truthy", () => {
  expect(resolveTelemetryEnabled(settingsWith("id"), { DO_NOT_TRACK: "1" })).toBe(false);
});

test("telemetryDisabledByEnv reflects env kills only", () => {
  expect(telemetryDisabledByEnv({})).toBe(false);
  expect(telemetryDisabledByEnv({ CORBITS_TELEMETRY: "0" })).toBe(true);
  expect(telemetryDisabledByEnv({ DO_NOT_TRACK: "1" })).toBe(true);
  expect(telemetryDisabledByEnv({ DO_NOT_TRACK: "true" })).toBe(true);
  expect(telemetryDisabledByEnv({ DO_NOT_TRACK: "0" })).toBe(false);
});

test("telemetryDisabledByEnv treats any falsy CORBITS_TELEMETRY value as disable", () => {
  for (const value of ["0", "false", "FALSE", "off", "no", "", " 0", "false\n", " off "]) {
    expect(telemetryDisabledByEnv({ CORBITS_TELEMETRY: value })).toBe(true);
  }
  expect(telemetryDisabledByEnv({ CORBITS_TELEMETRY: "1" })).toBe(false);
  expect(telemetryDisabledByEnv({ CORBITS_TELEMETRY: "true" })).toBe(false);
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
    [settingsWith("id"), { CORBITS_TELEMETRY: "0" }],
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
  const { impl, events } = recordingFetch();
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
  await telemetry.flush();
  expect(events().length).toBe(1);
  const body = events()[0]!;
  expect(body.properties.status).toBe("ok");
  expect(body.properties.turn_count).toBe(3);
  expect(body.properties.duration_ms).toBe(100);
  expect(body.properties.session_mode).toBe("single");
  expect(body.properties.exit_reason).toBe("done");
  expect(body.properties.secret_field).toBeUndefined();
});

test("capture strips properties not in $ai_generation's allowlist", async () => {
  const { impl, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("$ai_generation", {
    $ai_trace_id: "trace-1",
    $ai_provider: "openai-compatible",
    $ai_model: "model-x",
    $ai_input_tokens: 10,
    $ai_output_tokens: 20,
    $ai_latency: 0.4,
    $ai_is_error: false,
    $ai_cache_read_input_tokens: 1,
    $ai_cache_creation_input_tokens: 2,
    $ai_reasoning_tokens: 3,
    prompt: "should-not-appear",
    completion: "should-not-appear",
  });
  await telemetry.flush();
  expect(events().length).toBe(1);
  const body = events()[0]!;
  expect(body.event).toBe("$ai_generation");
  expect(body.properties.$ai_trace_id).toBe("trace-1");
  expect(body.properties.$ai_provider).toBe("openai-compatible");
  expect(body.properties.$ai_model).toBe("model-x");
  expect(body.properties.$ai_latency).toBe(0.4);
  expect(body.properties.prompt).toBeUndefined();
  expect(body.properties.completion).toBeUndefined();
});

test("capture strips properties not in $ai_span's allowlist, including raw tool name and args", async () => {
  const { impl, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("$ai_span", {
    $ai_trace_id: "trace-1",
    $ai_span_id: "span-1",
    $ai_parent_id: "trace-1",
    $ai_span_name: "tool_call",
    tool_name: "mcp__acme__fetch_secret",
    tool_arguments: { path: "/etc/passwd" },
    tool_result: "should-not-appear",
  });
  await telemetry.flush();
  expect(events().length).toBe(1);
  const body = events()[0]!;
  expect(body.event).toBe("$ai_span");
  expect(body.properties.$ai_trace_id).toBe("trace-1");
  expect(body.properties.$ai_span_id).toBe("span-1");
  expect(body.properties.$ai_parent_id).toBe("trace-1");
  expect(body.properties.$ai_span_name).toBe("tool_call");
  expect(body.properties.tool_name).toBeUndefined();
  expect(body.properties.tool_arguments).toBeUndefined();
  expect(body.properties.tool_result).toBeUndefined();
});

test("capture transmits nothing for an event name inherited from Object.prototype", async () => {
  const { impl, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    telemetry.capture(name as Parameters<typeof telemetry.capture>[0], {
      leaked: "should-not-appear",
    });
  }
  await telemetry.flush();
  expect(events().length).toBe(0);
});

test("capture ignores allowlisted property names inherited from a payload's prototype", async () => {
  const { impl, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  const properties = Object.create({ $ai_trace_id: "inherited-should-not-appear" }) as Record<
    string,
    unknown
  >;
  properties.$ai_span_id = "span-1";
  telemetry.capture("$ai_span", properties);
  await telemetry.flush();
  const body = events()[0];
  expect(body?.properties.$ai_span_id).toBe("span-1");
  expect(body?.properties.$ai_trace_id).toBeUndefined();
});

test("capture payload shape includes distinct_id and common props, with no client-side geoip flag", async () => {
  const { impl, bodies, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("my-install-id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("cli_start");
  await telemetry.flush();
  expect(bodies.length).toBe(1);
  expect(bodies[0]!.api_key).toBe("test-key");
  const body = events()[0]!;
  expect(body.event).toBe("cli_start");
  expect(body.properties.distinct_id).toBe("my-install-id");
  expect(typeof body.timestamp).toBe("string");
  expect(body.properties.$geoip_disable).toBeUndefined();
  expect(body.properties.$process_person_profile).toBe(false);
  expect(body.properties.schema_version).toBe(1);
  expect(typeof body.properties.service_version).toBe("string");
  expect(body.properties.$app_version).toBe(body.properties.service_version);
  expect(typeof body.properties.$app_version).toBe("string");
  expect(String(body.properties.$app_version).length).toBeGreaterThan(0);
  expect(body.properties.os_type).toBe(process.platform);
  expect(body.properties.os_arch).toBe(process.arch);
});

test("intentional survey capture omits anonymous person-processing flag", async () => {
  const { impl, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("my-install-id", false),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  expect(telemetry.enabled).toBe(false);
  expect(
    telemetry.captureIntentional("survey sent", {
      $survey_id: "s",
      $survey_response: "hello",
      $survey_questions: [],
    }),
  ).toBe(true);
  await telemetry.flush();
  const body = events()[0]!;
  expect(body.event).toBe("survey sent");
  expect(body.properties.$process_person_profile).toBeUndefined();
});

test("flush resolves after pending captures settle", async () => {
  let resolveFetch: (() => void) | undefined;
  const impl = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = () => resolve(new Response("1", { status: 200 }));
    })) as unknown as typeof fetch;
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });

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
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("cli_start");
  const start = Date.now();
  await telemetry.flush();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2000);
});

test("flush resolves even when the underlying fetch rejects", async () => {
  const impl = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("cli_start");
  await expect(telemetry.flush()).resolves.toBeUndefined();
});

test("flush resolves immediately when nothing is pending", async () => {
  const telemetry = createTelemetry({ settings: settingsWith("id"), env: {}, apiKey: "" });
  await expect(telemetry.flush()).resolves.toBeUndefined();
});

test("capture attaches the same session_id across multiple events in one process", async () => {
  const { impl, events } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("my-install-id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
  });
  telemetry.capture("cli_start");
  telemetry.capture("session_end", { status: "ok" });
  await telemetry.flush();
  const captured = events();
  expect(captured.length).toBe(2);
  const sessionId = captured[0]!.properties.session_id;
  expect(typeof sessionId).toBe("string");
  expect((sessionId as string).length).toBeGreaterThan(0);
  expect(captured[1]!.properties.session_id).toBe(sessionId);
  expect(sessionId).toBe(getSessionId());
});

test("ensureTelemetrySettings called twice keeps installationId and enabled flag unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "corbits-telemetry-settings-"));
  const path = join(dir, "settings.json");
  try {
    const first = await ensureTelemetrySettings(path);
    expect(typeof first.telemetry?.installationId).toBe("string");
    expect(first.telemetry?.installationId!.length).toBeGreaterThan(0);

    const second = await ensureTelemetrySettings(path);
    expect(second.telemetry?.installationId).toBe(first.telemetry?.installationId);
    expect(second.telemetry?.enabled).toBe(first.telemetry?.enabled);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function gatedFetch() {
  const releases: (() => void)[] = [];
  const bodies: BatchBody[] = [];
  let concurrent = 0;
  let peakConcurrent = 0;
  let open = false;
  const impl = ((_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as BatchBody);
    concurrent++;
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    return new Promise<Response>((resolve) => {
      const release = () => {
        concurrent--;
        resolve(new Response("1", { status: 200 }));
      };
      if (open) release();
      else releases.push(release);
    });
  }) as unknown as typeof fetch;
  return {
    impl,
    bodies,
    openGate: () => {
      open = true;
      for (const release of releases.splice(0)) release();
    },
    peak: () => peakConcurrent,
  };
}

const turnCounts = (body: BatchBody) => body.batch.map((entry) => entry.properties.turn_count);

test("capture posts batches to the /batch/ endpoint", async () => {
  const urls: string[] = [];
  const impl = ((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
    host: "https://telemetry.example",
  });
  telemetry.capture("cli_start");
  await telemetry.flush();
  expect(urls).toEqual(["https://telemetry.example/batch/"]);
});

test("reaching the batch size sends one request holding every queued event", async () => {
  const { impl, bodies } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
    batch: { size: 3, intervalMs: 60_000 },
  });
  telemetry.capture("session_end", { turn_count: 1 });
  telemetry.capture("session_end", { turn_count: 2 });
  expect(bodies.length).toBe(0);

  telemetry.capture("session_end", { turn_count: 3 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(bodies.length).toBe(1);
  expect(turnCounts(bodies[0]!)).toEqual([1, 2, 3]);
});

test("a partial batch is sent once the batch interval elapses", async () => {
  const { impl, bodies } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
    batch: { size: 100, intervalMs: 10 },
  });
  telemetry.capture("session_end", { turn_count: 1 });
  expect(bodies.length).toBe(0);

  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(bodies.length).toBe(1);
  expect(turnCounts(bodies[0]!)).toEqual([1]);
});

test("overflowing the queue drops the oldest events", async () => {
  const { impl, bodies } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
    batch: { size: 100, intervalMs: 60_000, queueLimit: 3 },
  });
  for (let turn = 1; turn <= 5; turn++) telemetry.capture("session_end", { turn_count: turn });
  await telemetry.flush();
  expect(bodies.length).toBe(1);
  expect(turnCounts(bodies[0]!)).toEqual([3, 4, 5]);
});

test("captures during a request queue behind it instead of opening a second one", async () => {
  const gate = gatedFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: gate.impl,
    apiKey: "test-key",
    batch: { size: 1, intervalMs: 60_000 },
  });
  telemetry.capture("session_end", { turn_count: 1 });
  telemetry.capture("session_end", { turn_count: 2 });
  telemetry.capture("session_end", { turn_count: 3 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(gate.bodies.length).toBe(1);

  gate.openGate();
  await telemetry.flush();
  expect(gate.peak()).toBe(1);
  expect(gate.bodies.map(turnCounts)).toEqual([[1], [2], [3]]);
});

test("flush drains a partially full queue within its deadline", async () => {
  const { impl, bodies } = recordingFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: impl,
    apiKey: "test-key",
    batch: { size: 100, intervalMs: 60_000 },
  });
  telemetry.capture("session_end", { turn_count: 1 });
  telemetry.capture("session_end", { turn_count: 2 });
  const start = Date.now();
  await telemetry.flush();
  expect(Date.now() - start).toBeLessThan(500);
  expect(bodies.length).toBe(1);
  expect(turnCounts(bodies[0]!)).toEqual([1, 2]);
});

test("a hung endpoint caps the queue and never opens a second request", async () => {
  const gate = gatedFetch();
  const telemetry = createTelemetry({
    settings: settingsWith("id"),
    env: {},
    fetchFn: gate.impl,
    apiKey: "test-key",
    batch: { size: 2, intervalMs: 60_000, queueLimit: 4 },
  });
  for (let turn = 1; turn <= 20; turn++) {
    telemetry.capture("session_end", { turn_count: turn });
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(gate.bodies.length).toBe(1);
  expect(gate.peak()).toBe(1);
  expect(turnCounts(gate.bodies[0]!)).toEqual([1, 2]);

  gate.openGate();
  await telemetry.flush();
  expect(gate.peak()).toBe(1);
  // Only the newest queueLimit events survived the overflow; everything
  // between the in-flight batch and them was shed rather than buffered.
  expect(gate.bodies.slice(1).flatMap(turnCounts)).toEqual([17, 18, 19, 20]);
});
