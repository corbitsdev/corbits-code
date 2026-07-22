import pkg from "../../package.json" with { type: "json" };
import type { Settings } from "../config/settings.js";

// Compiled-in defaults, overridable via env for testing. An empty API key
// disables export entirely regardless of the enabled flag.
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_POSTHOG_API_KEY = "";

export const POSTHOG_HOST = process.env.INTERCODE_TELEMETRY_HOST ?? DEFAULT_POSTHOG_HOST;
export const POSTHOG_API_KEY = process.env.INTERCODE_TELEMETRY_KEY ?? DEFAULT_POSTHOG_API_KEY;

export type TelemetryEvent = "cli_start" | "session_end";

// Per-event property allowlist. Anything not listed here is stripped before
// the payload leaves the process — this is the single choke point for what
// telemetry can ever contain.
const EVENT_PROPERTY_ALLOWLIST: Record<TelemetryEvent, readonly string[]> = {
  cli_start: [],
  session_end: ["status", "turn_count", "duration_ms", "session_mode"],
};

function truthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

// Fail closed: telemetry only runs when explicitly not disabled, the DNT
// convention is absent, and a real installation id and API key exist.
export function resolveTelemetryEnabled(
  settings: Settings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  apiKey: string = POSTHOG_API_KEY,
): boolean {
  if (settings?.telemetry?.enabled === false) return false;
  if (env.INTERCODE_TELEMETRY === "0") return false;
  if (truthyEnvFlag(env.DO_NOT_TRACK)) return false;
  if (typeof settings?.telemetry?.installationId !== "string" || settings.telemetry.installationId.length === 0) {
    return false;
  }
  if (apiKey.length === 0) return false;
  return true;
}

function allowedProperties(
  event: TelemetryEvent,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (properties === undefined) return {};
  const allowed = EVENT_PROPERTY_ALLOWLIST[event];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in properties) result[key] = properties[key];
  }
  return result;
}

export type CreateTelemetryOptions = {
  settings: Settings | null | undefined;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  host?: string;
  apiKey?: string;
};

export type Telemetry = {
  enabled: boolean;
  capture(event: TelemetryEvent, properties?: Record<string, unknown>): void;
};

// Fire-and-forget PostHog capture client. Never throws, never blocks the
// caller — errors (including timeouts) are swallowed silently since
// telemetry must never affect product behavior.
export function createTelemetry(options: CreateTelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const host = options.host ?? POSTHOG_HOST;
  const apiKey = options.apiKey ?? POSTHOG_API_KEY;
  const enabled = resolveTelemetryEnabled(options.settings, env, apiKey);
  const fetchFn = options.fetchFn ?? fetch;
  const installationId = options.settings?.telemetry?.installationId ?? "";

  function capture(event: TelemetryEvent, properties?: Record<string, unknown>): void {
    if (!enabled) return;
    if (!(event === "cli_start" || event === "session_end")) return;

    const body = {
      api_key: apiKey,
      event,
      distinct_id: installationId,
      properties: {
        ...allowedProperties(event, properties),
        $geoip_disable: true,
        service_version: pkg.version,
        os_type: process.platform,
        os_arch: process.arch,
        schema_version: 1,
      },
    };

    fetchFn(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {
      // Swallow all errors — telemetry must never surface failures.
    });
  }

  return { enabled, capture };
}
