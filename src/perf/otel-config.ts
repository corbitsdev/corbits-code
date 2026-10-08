/**
 * Settings/env surface for opt-in OTEL export — no SDK, no network;
 * PerfTrace stays independent. Fail closed: invalid endpoint/headers/attrs
 * yield a stable error, never a half-enabled export. Secrets never enter
 * privacy-strict dumps.
 */

import type { Settings } from "../config/settings.js";

/** Stable operator-facing error code for invalid OTEL export config. */
export const OTEL_CONFIG_INVALID = "OTEL_CONFIG_INVALID" as const;

/** Default resource service name when neither settings nor env set one. */
export const DEFAULT_OTEL_SERVICE_NAME = "corbits-code";

// Standard OTEL env keys (prefer conventions over CORBITS_* for export config).
export const OTEL_ENV = {
  endpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
  headers: "OTEL_EXPORTER_OTLP_HEADERS",
  serviceName: "OTEL_SERVICE_NAME",
  resourceAttributes: "OTEL_RESOURCE_ATTRIBUTES",
} as const;

/** Non-secret settings block for OTEL export (global settings only). */
export interface OtelSettings {
  /** Explicit off switch. When false and no env endpoint, export stays
   * disabled. */
  enabled?: boolean;
  /** OTLP base URL (http/https). Env OTEL_EXPORTER_OTLP_ENDPOINT overrides. */
  endpoint?: string;
  /**
   * Extra OTLP headers (auth). Prefer the env var so secrets stay out of
   * settings files.
   */
  headers?: Record<string, string>;
  /** Resource service.name. Env OTEL_SERVICE_NAME overrides. */
  serviceName?: string;
  /**
   * Extra resource attributes (merged; env keys win). Non-secret labels only.
   */
  resourceAttributes?: Record<string, string>;
}

export interface EnabledOtelExportConfig {
  enabled: true;
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  serviceName: string;
  resourceAttributes: Readonly<Record<string, string>>;
}

export interface DisabledOtelExportConfig {
  enabled: false;
}

export type OtelExportConfig =
  | EnabledOtelExportConfig
  | DisabledOtelExportConfig;

/**
 * Dump-safe view: no header values or other secrets. Privacy-strict
 * dumps must only ever receive this shape.
 */
export type OtelExportConfigDumpView =
  | { enabled: false }
  | {
      enabled: true;
      endpoint: string;
      serviceName: string;
      resourceAttributes: Readonly<Record<string, string>>;
      /** Header *names* only — values are never included. */
      headerNames: readonly string[];
    };

export type OtelConfigResolution =
  | { ok: true; config: OtelExportConfig }
  | { ok: false; code: typeof OTEL_CONFIG_INVALID; message: string };

export class OtelConfigError extends Error {
  readonly code = OTEL_CONFIG_INVALID;

  constructor(message: string) {
    super(message);
    this.name = "OtelConfigError";
  }
}

function trimOrEmpty(value: string | undefined): string {
  if (value === undefined) return "";
  return value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && trimOrEmpty(value).length > 0;
}

/**
 * Parse W3C-style `key=value,key2=value2` lists (headers / resource attrs).
 * Values may be percent-encoded; empty keys or malformed pairs fail closed.
 */
export function parseOtelKeyValueList(
  raw: string,
  label: string,
):
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string } {
  const out: Record<string, string> = {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: out };

  const parts = trimmed.split(",");
  for (const part of parts) {
    const segment = part.trim();
    if (segment.length === 0) {
      return {
        ok: false,
        message: `Invalid ${label}: empty entry in comma-separated list`,
      };
    }
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      return {
        ok: false,
        message: `Invalid ${label}: expected key=value entries, got ${JSON.stringify(segment)}`,
      };
    }
    const key = segment.slice(0, eq).trim();
    const rawValue = segment.slice(eq + 1).trim();
    if (key.length === 0) {
      return { ok: false, message: `Invalid ${label}: empty key` };
    }
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      return {
        ok: false,
        message: `Invalid ${label}: could not decode value for key ${JSON.stringify(key)}`,
      };
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

function validateEndpoint(
  raw: string,
): { ok: true; endpoint: string } | { ok: false; message: string } {
  const endpoint = raw.trim();
  if (endpoint.length === 0) {
    return {
      ok: false,
      message: "OTEL endpoint must be a non-empty http(s) URL",
    };
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return {
      ok: false,
      message: `OTEL endpoint is not a valid URL: ${JSON.stringify(endpoint)}`,
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: `OTEL endpoint must use http or https (got ${url.protocol.replace(":", "")})`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message:
        "OTEL endpoint must not embed credentials; pass auth via OTEL_EXPORTER_OTLP_HEADERS or settings.otel.headers",
    };
  }

  // Drop trailing slash so exporters append /v1/traces consistently.
  const normalized = endpoint.replace(/\/+$/, "");
  return { ok: true, endpoint: normalized };
}

function validateStringMap(
  map: Record<string, string> | undefined,
  label: string,
):
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string } {
  if (map === undefined) return { ok: true, value: {} };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      return { ok: false, message: `Invalid ${label}: empty key` };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        message: `Invalid ${label}: value for ${JSON.stringify(key)} must be a string`,
      };
    }
    out[key.trim()] = value;
  }
  return { ok: true, value: out };
}

/**
 * Precedence (env over settings):
 * - endpoint: env > settings
 * - headers: env list fully replaces settings when set; else settings
 * - serviceName: env > settings.serviceName > attrs["service.name"] > default
 * - resourceAttributes: settings then env (env wins on conflict); after merge,
 *   attrs["service.name"] is synced to the resolved serviceName
 *
 * No endpoint → disabled (ok); invalid or malformed → not ok.
 */
export function resolveOtelExportConfig(
  settings?: Settings | null,
  env: NodeJS.ProcessEnv = process.env,
): OtelConfigResolution {
  const otel = settings?.otel;
  const envEndpointRaw = trimOrEmpty(env[OTEL_ENV.endpoint]);
  const envHeadersRaw = env[OTEL_ENV.headers];
  const envServiceNameRaw = trimOrEmpty(env[OTEL_ENV.serviceName]);
  const envResourceAttrsRaw = env[OTEL_ENV.resourceAttributes];

  const settingsEndpoint = isNonEmptyString(otel?.endpoint)
    ? otel.endpoint.trim()
    : "";
  const endpointRaw =
    envEndpointRaw.length > 0 ? envEndpointRaw : settingsEndpoint;

  // settings.otel.enabled === false forces off unless env sets an endpoint.
  if (otel?.enabled === false && envEndpointRaw.length === 0) {
    return { ok: true, config: { enabled: false } };
  }

  if (endpointRaw.length === 0) {
    const settingsHeaders =
      otel?.headers !== undefined && Object.keys(otel.headers).length > 0;
    const envHeadersSet = isNonEmptyString(envHeadersRaw);
    if (settingsHeaders || envHeadersSet) {
      return {
        ok: false,
        code: OTEL_CONFIG_INVALID,
        message:
          "OTEL export headers are set but no endpoint is configured (set OTEL_EXPORTER_OTLP_ENDPOINT or settings.otel.endpoint)",
      };
    }
    if (otel?.enabled === true) {
      return {
        ok: false,
        code: OTEL_CONFIG_INVALID,
        message:
          "OTEL export is enabled but no endpoint is configured (set OTEL_EXPORTER_OTLP_ENDPOINT or settings.otel.endpoint)",
      };
    }
    // Service name / resource attrs alone do not enable export.
    return { ok: true, config: { enabled: false } };
  }

  const endpointResult = validateEndpoint(endpointRaw);
  if (!endpointResult.ok) {
    return {
      ok: false,
      code: OTEL_CONFIG_INVALID,
      message: endpointResult.message,
    };
  }

  let headers: Record<string, string> = {};
  if (envHeadersRaw !== undefined) {
    const parsed = parseOtelKeyValueList(envHeadersRaw, OTEL_ENV.headers);
    if (!parsed.ok) {
      return { ok: false, code: OTEL_CONFIG_INVALID, message: parsed.message };
    }
    headers = parsed.value;
  } else {
    const settingsHeaders = validateStringMap(
      otel?.headers,
      "settings.otel.headers",
    );
    if (!settingsHeaders.ok) {
      return {
        ok: false,
        code: OTEL_CONFIG_INVALID,
        message: settingsHeaders.message,
      };
    }
    headers = settingsHeaders.value;
  }

  let resourceAttributes: Record<string, string> = {};
  const settingsAttrs = validateStringMap(
    otel?.resourceAttributes,
    "settings.otel.resourceAttributes",
  );
  if (!settingsAttrs.ok) {
    return {
      ok: false,
      code: OTEL_CONFIG_INVALID,
      message: settingsAttrs.message,
    };
  }
  resourceAttributes = { ...settingsAttrs.value };

  if (envResourceAttrsRaw !== undefined) {
    const parsed = parseOtelKeyValueList(
      envResourceAttrsRaw,
      OTEL_ENV.resourceAttributes,
    );
    if (!parsed.ok) {
      return { ok: false, code: OTEL_CONFIG_INVALID, message: parsed.message };
    }
    resourceAttributes = { ...resourceAttributes, ...parsed.value };
  }

  // Sync attrs["service.name"] to the resolved name so the two never diverge.
  const attrServiceName = trimOrEmpty(resourceAttributes["service.name"]);
  const serviceName =
    envServiceNameRaw.length > 0
      ? envServiceNameRaw
      : isNonEmptyString(otel?.serviceName)
        ? otel.serviceName.trim()
        : attrServiceName.length > 0
          ? attrServiceName
          : DEFAULT_OTEL_SERVICE_NAME;

  if (serviceName.length === 0) {
    return {
      ok: false,
      code: OTEL_CONFIG_INVALID,
      message: "OTEL service name must be non-empty when set",
    };
  }

  resourceAttributes["service.name"] = serviceName;

  return {
    ok: true,
    config: {
      enabled: true,
      endpoint: endpointResult.endpoint,
      headers: Object.freeze({ ...headers }),
      serviceName,
      resourceAttributes: Object.freeze({ ...resourceAttributes }),
    },
  };
}

/**
 * Hard-startup callers use this; soft paths call resolveOtelExportConfig
 * and branch on ok.
 */
export function requireOtelExportConfig(
  settings?: Settings | null,
  env: NodeJS.ProcessEnv = process.env,
): OtelExportConfig {
  const result = resolveOtelExportConfig(settings, env);
  if (!result.ok) {
    throw new OtelConfigError(result.message);
  }
  return result.config;
}

/** Attr keys that look secret-bearing — values redacted in dump views only. */
const SENSITIVE_ATTR_KEY = /secret|token|key|password|auth/i;

/**
 * Redact secret-bearing resource attribute values for dump/log views
 * (no mutation).
 */
export function redactResourceAttributesForDump(
  attrs: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = SENSITIVE_ATTR_KEY.test(key) ? "[redacted]" : value;
  }
  return Object.freeze(out);
}

/**
 * Header values stripped. Use this, never raw headers.
 */
export function otelConfigForDump(
  config: OtelExportConfig,
): OtelExportConfigDumpView {
  if (!config.enabled) return { enabled: false };
  return {
    enabled: true,
    endpoint: config.endpoint,
    serviceName: config.serviceName,
    resourceAttributes: redactResourceAttributesForDump(
      config.resourceAttributes,
    ),
    headerNames: Object.freeze(Object.keys(config.headers).sort()),
  };
}
