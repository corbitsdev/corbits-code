/**
 * Opt-in OTLP/HTTP JSON export for PerfTrace (CL-5173).
 *
 * Maps the in-process PerfSpan tree to OTEL spans and POSTs to the operator's
 * collector. Disabled config paths do no network. Network/config failures are
 * logged and swallowed — never thrown to callers.
 *
 * No @opentelemetry/sdk dependency: hand-rolled OTLP HTTP JSON only.
 */

import { createHash, randomBytes } from "node:crypto";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import type { Settings } from "../config/settings.js";
import type { PerfSpan } from "./index.js";
import {
  resolveOtelExportConfig,
  type EnabledOtelExportConfig,
  type OtelExportConfig,
} from "./otel-config.js";
import { sanitizeTags } from "./sanitize.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "perf", "otel"]);

/** Upper bound so a slow collector cannot hold process exit indefinitely. */
const EXPORT_TIMEOUT_MS = 3000;

/** OTLP span kind: INTERNAL (1). */
const SPAN_KIND_INTERNAL = 1;

export type FlushToOtelOptions = {
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Wall-clock anchor for converting monotonic hrtime to unix nano.
   * Defaults to Date.now() * 1e6 ns aligned with process.hrtime.bigint().
   */
  wallAnchor?: { monoNs: bigint; unixNs: bigint };
  /** Override open-span end time (defaults to now). */
  nowMonoNs?: () => bigint;
  /** Fixed trace id for deterministic tests (32 hex chars). */
  traceId?: string;
};

export type FlushPerfToOtelOptions = FlushToOtelOptions & {
  /** Spans to export; when omitted, caller supplies via getSpans. */
  spans?: readonly PerfSpan[];
  /** Lazy snapshot provider — defaults supplied by perf/index flushPerfToOtel. */
  getSpans?: () => readonly PerfSpan[];
};

/** OTLP JSON attribute value (subset we emit). */
export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number };
};

export type OtlpExportPayload = {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
};

function defaultWallAnchor(): { monoNs: bigint; unixNs: bigint } {
  return {
    monoNs: process.hrtime.bigint(),
    unixNs: BigInt(Date.now()) * 1_000_000n,
  };
}

/** Convert monotonic ns to unix epoch ns using a shared wall/mono anchor. */
export function monoToUnixNano(
  monoNs: bigint,
  anchor: { monoNs: bigint; unixNs: bigint },
): bigint {
  return anchor.unixNs + (monoNs - anchor.monoNs);
}

/**
 * Stable 16-hex-char OTEL span id from an opaque PerfSpan id.
 * Must be non-all-zero; hash guarantees a full 64-bit space.
 */
export function otelSpanId(perfId: string): string {
  return createHash("sha256").update(`span:${perfId}`).digest("hex").slice(0, 16);
}

export function newOtelTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Resolve the OTLP traces URL. Appends `/v1/traces` unless the endpoint already
 * ends with that path (operators sometimes paste full collector URLs).
 */
export function otlpTracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  if (base.endsWith("/v1/traces")) return base;
  return `${base}/v1/traces`;
}

export function tagsToOtlpAttributes(
  tags: PerfSpan["tags"] | undefined,
): OtlpKeyValue[] {
  // Defense in depth: re-sanitize even though start/end/mark already did.
  const safe = sanitizeTags(tags as Record<string, unknown> | undefined);
  if (safe === undefined) return [];

  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(safe)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      out.push({ key, value: { stringValue: value } });
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      if (Number.isInteger(value)) {
        out.push({ key, value: { intValue: String(value) } });
      } else {
        out.push({ key, value: { doubleValue: value } });
      }
    }
  }
  // Stable order for tests and collector diffs.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

function resourceAttributes(config: EnabledOtelExportConfig): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(config.resourceAttributes)) {
    attrs.push({ key, value: { stringValue: value } });
  }
  // service.name is guaranteed by resolveOtelExportConfig, but keep explicit.
  if (!attrs.some((a) => a.key === "service.name")) {
    attrs.push({ key: "service.name", value: { stringValue: config.serviceName } });
  }
  attrs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return attrs;
}

/**
 * Map PerfSpan[] → OTLP HTTP JSON payload (one resource, one scope, one trace).
 * Open spans (no endNs) use `nowMonoNs` as end so partial trees still export.
 */
export function buildOtlpPayload(
  spans: readonly PerfSpan[],
  config: EnabledOtelExportConfig,
  options: FlushToOtelOptions = {},
): OtlpExportPayload {
  const anchor = options.wallAnchor ?? defaultWallAnchor();
  const nowMono = options.nowMonoNs ?? (() => process.hrtime.bigint());
  const traceId = options.traceId ?? newOtelTraceId();
  const endFallback = nowMono();

  const otlpSpans: OtlpSpan[] = spans.map((span) => {
    const endMono = span.endNs ?? endFallback;
    const startUnix = monoToUnixNano(span.startNs, anchor);
    const endUnix = monoToUnixNano(endMono, anchor);
    // Guard inverted times if clock anchor is weird in tests.
    const startTimeUnixNano = startUnix <= endUnix ? startUnix : endUnix;
    const endTimeUnixNano = endUnix >= startTimeUnixNano ? endUnix : startTimeUnixNano;

    const otlp: OtlpSpan = {
      traceId,
      spanId: otelSpanId(span.id),
      name: span.name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: startTimeUnixNano.toString(),
      endTimeUnixNano: endTimeUnixNano.toString(),
      attributes: tagsToOtlpAttributes(span.tags),
      status: { code: 0 }, // UNSET
    };
    if (span.parentId !== undefined && span.parentId.length > 0) {
      otlp.parentSpanId = otelSpanId(span.parentId);
    }
    return otlp;
  });

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(config) },
        scopeSpans: [
          {
            scope: { name: "corbits-code.perf", version: "1" },
            spans: otlpSpans,
          },
        ],
      },
    ],
  };
}

/**
 * POST spans to the operator's OTLP HTTP/JSON collector.
 * Never throws. No-op when spans is empty.
 */
export async function flushToOtel(
  spans: readonly PerfSpan[],
  config: EnabledOtelExportConfig,
  options: FlushToOtelOptions = {},
): Promise<void> {
  if (spans.length === 0) return;

  const fetchFn = options.fetchFn ?? fetch;
  const url = otlpTracesUrl(config.endpoint);
  const body = JSON.stringify(buildOtlpPayload(spans, config, options));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...config.headers,
  };

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn("OTEL export failed: HTTP {status} from {url}", {
        status: response.status,
        url,
      });
    }
  } catch (err) {
    log.warn("OTEL export failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve settings/env and flush when export is enabled.
 * Zero network when disabled or config is invalid (invalid is logged once).
 * Never throws.
 *
 * Provide spans via `options.spans` or `options.getSpans`. When neither is set,
 * this is a no-op (perf/index `flushPerfToOtel` wires snapshot()).
 */
export async function flushPerfToOtel(
  settings?: Settings | null,
  env: NodeJS.ProcessEnv = process.env,
  options: FlushPerfToOtelOptions = {},
): Promise<void> {
  let config: OtelExportConfig;
  try {
    const resolved = resolveOtelExportConfig(settings, env);
    if (!resolved.ok) {
      log.warn("OTEL export skipped: {message}", { message: resolved.message });
      return;
    }
    config = resolved.config;
  } catch (err) {
    log.warn("OTEL export config resolution failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!config.enabled) return;

  const spans = options.spans ?? options.getSpans?.() ?? [];
  await flushToOtel(spans, config, options);
}
