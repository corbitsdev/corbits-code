import { afterEach, describe, expect, test } from "bun:test";

import type { Settings } from "../config/settings.js";
import { clear, end, snapshot, start, type PerfSpan } from "./index.js";
import {
  buildOtlpPayload,
  flushPerfToOtel,
  flushToOtel,
  monoToUnixNano,
  otelSpanId,
  otlpTracesUrl,
  tagsToOtlpAttributes,
} from "./otel-sink.js";
import type { EnabledOtelExportConfig } from "./otel-config.js";

afterEach(() => {
  clear();
});

const enabledConfig = (
  overrides: Partial<EnabledOtelExportConfig> = {},
): EnabledOtelExportConfig => ({
  enabled: true,
  endpoint: "http://localhost:4318",
  headers: {},
  serviceName: "corbits-code",
  resourceAttributes: { "service.name": "corbits-code" },
  ...overrides,
});

const baseSettings = (otel?: Settings["otel"]): Settings => ({
  providers: {},
  ...(otel !== undefined ? { otel } : {}),
});

const mockFetch = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  impl as unknown as typeof fetch;

describe("otlpTracesUrl", () => {
  test("appends /v1/traces to base endpoint", () => {
    expect(otlpTracesUrl("http://localhost:4318")).toBe("http://localhost:4318/v1/traces");
  });

  test("does not double-append when path already ends with /v1/traces", () => {
    expect(otlpTracesUrl("https://app.phoenix.arize.com/v1/traces")).toBe(
      "https://app.phoenix.arize.com/v1/traces",
    );
  });

  test("strips trailing slash before appending", () => {
    expect(otlpTracesUrl("http://localhost:4318/")).toBe("http://localhost:4318/v1/traces");
  });
});

describe("otelSpanId", () => {
  test("is 16 hex chars and stable", () => {
    const a = otelSpanId("1");
    const b = otelSpanId("1");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(otelSpanId("2")).not.toBe(a);
  });
});

describe("tagsToOtlpAttributes", () => {
  test("maps string and integer tags", () => {
    const attrs = tagsToOtlpAttributes({
      provider_id: "openai",
      count: 3,
      transport: "ws",
    });
    expect(attrs).toEqual([
      { key: "count", value: { intValue: "3" } },
      { key: "provider_id", value: { stringValue: "openai" } },
      { key: "transport", value: { stringValue: "ws" } },
    ]);
  });

  test("re-sanitizes forbidden keys at export", () => {
    const attrs = tagsToOtlpAttributes({
      provider_id: "xai",
      prompt: "secret",
      path: "/tmp/x",
    } as never);
    expect(attrs).toEqual([{ key: "provider_id", value: { stringValue: "xai" } }]);
  });
});

describe("buildOtlpPayload", () => {
  test("maps parent links, names, and times", () => {
    const turnId = start("turn");
    const infId = start("inference", { parentId: turnId, tags: { model_id: "m1" } });
    end(infId);
    end(turnId);
    const spans: PerfSpan[] = [
      {
        id: turnId,
        name: "turn",
        startNs: 1000n,
        endNs: 5000n,
      },
      {
        id: infId,
        name: "inference",
        parentId: turnId,
        startNs: 2000n,
        endNs: 4000n,
        tags: { model_id: "m1" },
      },
    ];

    const anchor = { monoNs: 0n, unixNs: 1_000_000_000_000n };
    const payload = buildOtlpPayload(spans, enabledConfig(), {
      wallAnchor: anchor,
      traceId: "a".repeat(32),
    });

    const otlpSpans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(otlpSpans).toHaveLength(2);

    const turn = otlpSpans.find((s) => s.name === "turn")!;
    const inf = otlpSpans.find((s) => s.name === "inference")!;
    expect(turn.traceId).toBe("a".repeat(32));
    expect(turn.spanId).toBe(otelSpanId(turnId));
    expect(turn.parentSpanId).toBeUndefined();
    expect(turn.startTimeUnixNano).toBe(monoToUnixNano(1000n, anchor).toString());
    expect(turn.endTimeUnixNano).toBe(monoToUnixNano(5000n, anchor).toString());

    expect(inf.parentSpanId).toBe(otelSpanId(turnId));
    expect(inf.attributes).toEqual([{ key: "model_id", value: { stringValue: "m1" } }]);

    const resource = payload.resourceSpans[0]!.resource.attributes;
    expect(
      resource.some(
        (a) => a.key === "service.name" && "stringValue" in a.value && a.value.stringValue === "corbits-code",
      ),
    ).toBe(true);
  });

  test("open spans use nowMonoNs as end", () => {
    const spans: PerfSpan[] = [{ id: "open1", name: "session", startNs: 10n }];
    const anchor = { monoNs: 0n, unixNs: 0n };
    const payload = buildOtlpPayload(spans, enabledConfig(), {
      wallAnchor: anchor,
      nowMonoNs: () => 99n,
      traceId: "b".repeat(32),
    });
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.startTimeUnixNano).toBe("10");
    expect(span.endTimeUnixNano).toBe("99");
  });
});

describe("flushToOtel", () => {
  test("POSTs OTLP JSON with headers to /v1/traces", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = mockFetch(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 200 });
    });

    const spans: PerfSpan[] = [{ id: "1", name: "turn", startNs: 1n, endNs: 2n }];
    await flushToOtel(
      spans,
      enabledConfig({
        endpoint: "https://collector.example",
        headers: { Authorization: "Bearer secret" },
      }),
      { fetchFn, traceId: "c".repeat(32), wallAnchor: { monoNs: 0n, unixNs: 0n } },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://collector.example/v1/traces");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer secret");

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      resourceSpans: unknown[];
    };
    expect(body.resourceSpans).toHaveLength(1);
  });

  test("empty spans do not call fetch", async () => {
    let called = 0;
    const fetchFn = mockFetch(async () => {
      called += 1;
      return new Response(null, { status: 200 });
    });
    await flushToOtel([], enabledConfig(), { fetchFn });
    expect(called).toBe(0);
  });

  test("network errors are swallowed", async () => {
    const fetchFn = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      flushToOtel([{ id: "1", name: "turn", startNs: 1n, endNs: 2n }], enabledConfig(), {
        fetchFn,
      }),
    ).resolves.toBeUndefined();
  });

  test("non-2xx responses are swallowed", async () => {
    const fetchFn = mockFetch(async () => new Response("nope", { status: 503 }));
    await expect(
      flushToOtel([{ id: "1", name: "turn", startNs: 1n, endNs: 2n }], enabledConfig(), {
        fetchFn,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("flushPerfToOtel", () => {
  test("disabled config performs zero network", async () => {
    let called = 0;
    const fetchFn = mockFetch(async () => {
      called += 1;
      return new Response(null, { status: 200 });
    });

    const id = start("turn");
    end(id);
    await flushPerfToOtel(baseSettings(), {}, { fetchFn });
    expect(called).toBe(0);
  });

  test("enabled config snapshots and POSTs", async () => {
    const calls: string[] = [];
    const fetchFn = mockFetch(async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 200 });
    });

    const id = start("session");
    end(id);

    await flushPerfToOtel(baseSettings({ endpoint: "http://127.0.0.1:4318" }), {}, { fetchFn, getSpans: snapshot });
    expect(calls).toEqual(["http://127.0.0.1:4318/v1/traces"]);
  });

  test("invalid config does not throw and does not fetch", async () => {
    let called = 0;
    const fetchFn = mockFetch(async () => {
      called += 1;
      return new Response(null, { status: 200 });
    });

    await expect(
      flushPerfToOtel(baseSettings({ enabled: true }), {}, { fetchFn }),
    ).resolves.toBeUndefined();
    expect(called).toBe(0);
  });

  test("explicit spans override ring snapshot", async () => {
    const bodies: string[] = [];
    const fetchFn = mockFetch(async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(null, { status: 200 });
    });

    // Ring has a session span — should be ignored when spans is provided.
    start("session");
    const only: PerfSpan[] = [
      { id: "only", name: "tool", startNs: 1n, endNs: 2n, tags: { tool_id: "t1" } },
    ];
    await flushPerfToOtel(
      baseSettings({ endpoint: "http://localhost:4318" }),
      {},
      {
        fetchFn,
        spans: only,
        traceId: "d".repeat(32),
        wallAnchor: { monoNs: 0n, unixNs: 0n },
      },
    );
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]!) as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ name: string }> }>;
      }>;
    };
    const names = parsed.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name);
    expect(names).toEqual(["tool"]);
  });
});
