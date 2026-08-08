import { randomUUID } from "node:crypto";

import pkg from "../../package.json" with { type: "json" };
import { ENV_PREFIX } from "../branding.js";
import type { Settings } from "../config/settings.js";

// Compiled-in defaults, overridable via env for testing. An empty API key
// disables export entirely regardless of the enabled flag.
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_POSTHOG_API_KEY = "phc_BWpXcEx3XBH2EiuNi3fXrdzfgnfbVe4WbVyfR8r5KbLp";

const TELEMETRY_HOST_ENV = `${ENV_PREFIX}TELEMETRY_HOST`;
const TELEMETRY_KEY_ENV = `${ENV_PREFIX}TELEMETRY_KEY`;
export const TELEMETRY_ENV = `${ENV_PREFIX}TELEMETRY`;

export const POSTHOG_HOST = process.env[TELEMETRY_HOST_ENV] ?? DEFAULT_POSTHOG_HOST;
export const POSTHOG_API_KEY = process.env[TELEMETRY_KEY_ENV] ?? DEFAULT_POSTHOG_API_KEY;

// Upper bound on how long flush() may hold up process exit; anything still
// in flight past this is dropped.
const FLUSH_DEADLINE_MS = 500;

// Batching defaults. A busy turn can emit an event per tool call, so events
// accumulate until either trigger fires rather than opening a socket each
// time. The queue limit bounds memory when the endpoint is unreachable —
// a captive portal or hung proxy would otherwise grow the queue for the
// whole session behind a single stuck request.
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BATCH_INTERVAL_MS = 10_000;
const DEFAULT_QUEUE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 3000;

export type BatchTuning = {
  size?: number;
  intervalMs?: number;
  queueLimit?: number;
};

// Shown once per installation, in whichever surface a new user reaches
// first: the onboarding panel on a fresh install (so disclosure accompanies
// the very first event), and the TUI banner otherwise.
export const TELEMETRY_NOTICE =
  "Anonymous usage telemetry is enabled (no prompts, code, or paths collected). Disable in /settings > Telemetry. Docs: docs/TELEMETRY.md";

export type TelemetryEvent = "cli_start" | "session_end" | "inference_turn";

// One id per interactive process (TUI session or CLI invocation), generated
// once at module load and reused by every createTelemetry() instance for the
// life of the process — including across the toggle handler's re-creation on
// enable/disable — so PostHog can group every event this process emits into
// one session. Future emitters (AI turn events, feedback) read this via
// getSessionId() rather than generating their own.
const SESSION_ID = randomUUID();

export function getSessionId(): string {
  return SESSION_ID;
}

// Per-event property allowlist. Anything not listed here is stripped before
// the payload leaves the process. Together with the fixed common properties
// capture() appends (service_version, os_type, os_arch, schema_version,
// session_id), this bounds everything telemetry can ever contain.
const EVENT_PROPERTY_ALLOWLIST: Record<TelemetryEvent, readonly string[]> = {
  cli_start: [],
  session_end: ["status", "turn_count", "duration_ms", "session_mode", "exit_reason"],
  inference_turn: [
    "provider_id",
    "model_id",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "thinking_tokens",
    "duration_ms",
  ],
};

const FALSY_ENV_FLAG_VALUES = new Set(["", "0", "false", "off", "no"]);

// Trimmed so .env files and shell scripts that produce " 0" or "false\n"
// still count as an opt-out — opt-out parsing must fail toward disabled.
function truthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !FALSY_ENV_FLAG_VALUES.has(value.trim().toLowerCase());
}

// Env kills win over everything and require no settings at all — callers use
// this to skip settings writes (installationId generation) entirely.
// CORBITS_TELEMETRY set to any falsy value ("0", "false", "off", "")
// disables, through the same flag parsing as DO_NOT_TRACK, so the two kill
// switches agree on what counts as "off".
export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[TELEMETRY_ENV] !== undefined && !truthyEnvFlag(env[TELEMETRY_ENV])) return true;
  return truthyEnvFlag(env.DO_NOT_TRACK);
}

// Fail closed: telemetry only runs when explicitly not disabled, the DNT
// convention is absent, and a real installation id and API key exist.
export function resolveTelemetryEnabled(
  settings: Settings | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  apiKey: string = POSTHOG_API_KEY,
): boolean {
  if (settings?.telemetry?.enabled === false) return false;
  if (telemetryDisabledByEnv(env)) return false;
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
  batch?: BatchTuning;
};

type QueuedEvent = {
  event: TelemetryEvent;
  properties: Record<string, unknown>;
  timestamp: string;
};

export type Telemetry = {
  enabled: boolean;
  capture(event: TelemetryEvent, properties?: Record<string, unknown>): void;
  // Sends whatever is queued and waits briefly for it to settle, giving up
  // after a short deadline so a slow endpoint can never hold up process
  // exit. Callers use this to bound exit against dropped fire-and-forget
  // requests without ever making capture() itself blocking.
  flush(): Promise<void>;
};

// Fire-and-forget PostHog batch client. Never throws, never blocks the
// caller — errors (including timeouts) are swallowed silently since
// telemetry must never affect product behavior.
export function createTelemetry(options: CreateTelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const host = options.host ?? POSTHOG_HOST;
  const apiKey = options.apiKey ?? POSTHOG_API_KEY;
  const enabled = resolveTelemetryEnabled(options.settings, env, apiKey);
  const fetchFn = options.fetchFn ?? fetch;
  const installationId = options.settings?.telemetry?.installationId ?? "";

  const batchSize = options.batch?.size ?? DEFAULT_BATCH_SIZE;
  const batchIntervalMs = options.batch?.intervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const queueLimit = options.batch?.queueLimit ?? DEFAULT_QUEUE_LIMIT;

  const queue: QueuedEvent[] = [];
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  async function send(events: QueuedEvent[]): Promise<void> {
    const body = {
      api_key: apiKey,
      batch: events.map((queued) => ({
        event: queued.event,
        timestamp: queued.timestamp,
        properties: { ...queued.properties, distinct_id: installationId },
      })),
    };
    try {
      await fetchFn(`${host}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Swallow all errors — telemetry must never surface failures.
    }
  }

  // Returns the existing drain when one is running so at most one request is
  // ever open: events captured mid-flight are picked up by that drain's next
  // iteration instead of opening a second socket.
  function drain(): Promise<void> {
    if (inFlight !== null) return inFlight;
    const running = (async () => {
      while (queue.length > 0) {
        await send(queue.splice(0, batchSize));
      }
    })().finally(() => {
      inFlight = null;
    });
    inFlight = running;
    return running;
  }

  function capture(event: TelemetryEvent, properties?: Record<string, unknown>): void {
    if (!enabled) return;
    if (!(event === "cli_start" || event === "session_end" || event === "inference_turn")) return;

    queue.push({
      event,
      timestamp: new Date().toISOString(),
      properties: {
        ...allowedProperties(event, properties),
        service_version: pkg.version,
        os_type: process.platform,
        os_arch: process.arch,
        schema_version: 1,
        session_id: SESSION_ID,
      },
    });

    // Oldest first: a stuck endpoint makes the head of the queue the least
    // likely to still be worth reporting, and unbounded growth is never an
    // acceptable alternative.
    if (queue.length > queueLimit) queue.splice(0, queue.length - queueLimit);

    if (queue.length >= batchSize) {
      cancelTimer();
      void drain();
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, batchIntervalMs);
      timer.unref?.();
    }
  }

  async function flush(): Promise<void> {
    cancelTimer();
    if (queue.length === 0 && inFlight === null) return;
    // Race against a short deadline: stragglers are dropped rather than
    // allowed to delay exit for the full per-request AbortSignal window.
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, FLUSH_DEADLINE_MS);
        deadline.unref?.();
      }),
    ]);
  }

  return { enabled, capture, flush };
}
