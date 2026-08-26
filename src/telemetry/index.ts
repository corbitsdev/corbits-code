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
export const TELEMETRY_AI_SPANS_ENV = `${ENV_PREFIX}TELEMETRY_AI_SPANS`;
export const TELEMETRY_GENERATION_SAMPLE_RATE_ENV = `${ENV_PREFIX}TELEMETRY_GENERATION_SAMPLE_RATE`;

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

export interface BatchTuning {
  size?: number;
  intervalMs?: number;
  queueLimit?: number;
}

// Shown once per installation, in whichever surface a new user reaches
// first: the onboarding panel on a fresh install (so disclosure accompanies
// the very first event), and the TUI banner otherwise.
export const TELEMETRY_NOTICE =
  "Anonymous usage telemetry is enabled (no prompts, code, or paths collected). Free text only leaves via /feedback if you send it. Disable ambient events in /settings > Telemetry; DO_NOT_TRACK / CORBITS_TELEMETRY=0 blocks all telemetry including feedback. Docs: docs/TELEMETRY.md";

export type TelemetryEvent =
  | "cli_start"
  | "session_end"
  | "$ai_generation"
  | "$ai_span"
  | "slash_command"
  | "skill_used"
  | "plugin_loaded"
  | "subagent_start"
  | "subagent_end"
  | "permission_prompt"
  | "compaction"
  | "crash"
  | "auth_failure"
  // PostHog Surveys event name (space included). Intentional operator feedback
  // from /feedback — can ship when ambient product telemetry is off; still
  // blocked by env kill switches. See captureIntentional.
  | "survey sent";

// Fixed enum of AI observability span names. The raw tool name is never sent
// as a property: an MCP tool name carries the server identifier it was
// configured under (`mcp__<server>__<tool>`), which can be a local path or
// otherwise identifying string. Callers map a tool call to one of these
// kinds before capturing "$ai_span".
export const AI_SPAN_KINDS = ["tool_call", "subagent_call"] as const;
export type AiSpanKind = (typeof AI_SPAN_KINDS)[number];

// Fixed enum of AI observability error reasons. A provider error message is
// free text that routinely carries request URLs, prompt excerpts, and file
// paths, so the message itself never leaves the process — callers classify
// it into one of these before capturing.
export const AI_ERROR_KINDS = [
  "rate_limit",
  "auth",
  "timeout",
  "cancelled",
  "inference_failed",
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

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
// capture() appends ($app_version, service_version, os_type, os_arch,
// schema_version, session_id), this bounds everything telemetry can ever contain.
const EVENT_PROPERTY_ALLOWLIST: Record<TelemetryEvent, readonly string[]> = {
  cli_start: [],
  session_end: ["status", "turn_count", "duration_ms", "session_mode", "exit_reason"],
  // PostHog's LLM analytics views read the $ai_-prefixed properties and
  // nothing else, so every field these two events exist to surface has to
  // carry the documented name: an unprefixed property still arrives, but
  // only as an ordinary custom property no trace, cost, or latency view
  // will ever query.
  //
  // $ai_provider/$ai_model carry canonical runtime ids, never the free-text
  // name a user gave a provider in onboarding or settings. $ai_latency is
  // in seconds, per PostHog's schema.
  //
  // Cache and reasoning token counts use PostHog's documented cost-property
  // names (manual-capture installation + cost-properties reference):
  // $ai_cache_read_input_tokens, $ai_cache_creation_input_tokens,
  // $ai_reasoning_tokens. Unprefixed names land as custom properties and
  // are invisible to cost/token views (CL-5749).
  $ai_generation: [
    "$ai_trace_id",
    "$ai_provider",
    "$ai_model",
    "$ai_input_tokens",
    "$ai_output_tokens",
    "$ai_latency",
    "$ai_is_error",
    "$ai_error",
    "$ai_cache_read_input_tokens",
    "$ai_cache_creation_input_tokens",
    "$ai_reasoning_tokens",
    // Aggregates folded from per-call spans (CL-6816). Custom properties —
    // PostHog LLM cost views still only query the $ai_*-prefixed fields above.
    "tool_call_count",
    "tool_error_count",
    "subagent_call_count",
  ],

  // The trace is flat: every span's $ai_parent_id is the turn's
  // $ai_trace_id. PostHog documents $ai_parent_id as accepting a trace id or
  // another span id, so a flat trace is legal and it is all the runtime can
  // honestly describe — TurnContext only sees top-level tool calls.
  // $ai_span_name is one of AI_SPAN_KINDS only, never the raw tool name.
  $ai_span: ["$ai_trace_id", "$ai_span_id", "$ai_parent_id", "$ai_span_name", "$ai_is_error"],
  // Every identifier below is a first-party enum produced by
  // src/telemetry/classify.ts, not the name the user or author wrote. The
  // allowlist bounds which keys travel; the classifiers bound which values
  // can, and the two are independent guards on purpose.
  slash_command: ["command_name"],
  // Skill names are project- or plugin-authored with no first-party set to
  // match against, so the event counts skill use and carries nothing else.
  skill_used: [],
  // origin is the discovery tier (repo/user/project/path); the manifest id is
  // author-chosen free text and is not sent.
  plugin_loaded: ["origin"],
  subagent_start: ["agent_name"],
  subagent_end: [
    "agent_name",
    "status",
    "duration_ms",
    "model",
    "turn_count",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "tool_call_count",
    "tool_error_count",
    "stop_reason",
    "parent_trace_id",
  ],

  permission_prompt: ["decision", "permission_kind"],
  compaction: ["mode", "duration_ms", "turns_before", "turns_after"],
  crash: ["kind", "error_class"],
  // Which provider rejected the credentials, not why — the rejection detail is
  // provider-authored text and error_class means a JS constructor name.
  auth_failure: ["auth_provider"],
  // Intentional /feedback survey response (PostHog custom survey capture shape).
  // Free text is only sent because the operator typed it for that purpose.
  // turn_trace_id links to the last $ai_generation in this session when known.
  "survey sent": ["$survey_id", "$survey_questions", "$survey_response", "turn_trace_id"],
};

const FALSY_ENV_FLAG_VALUES = new Set(["", "0", "false", "off", "no"]);

// Trimmed so .env files and shell scripts that produce " 0" or "false\n"
// still count as an opt-out — opt-out parsing must fail toward disabled.
export function truthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !FALSY_ENV_FLAG_VALUES.has(value.trim().toLowerCase());
}

/** Opt-in debug: emit per-call `$ai_span` events alongside generation aggregates. */
export function aiSpansEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnvFlag(env[TELEMETRY_AI_SPANS_ENV]);
}

/**
 * Sample rate for successful `$ai_generation` events (0–1). Default 1.0 (no
 * drop). Errors (`$ai_is_error: true`), `crash`, and `auth_failure` always ship.
 */
export function generationSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TELEMETRY_GENERATION_SAMPLE_RATE_ENV];
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
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
  if (
    typeof settings?.telemetry?.installationId !== "string" ||
    settings.telemetry.installationId.length === 0
  ) {
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
    // Own-property only: `in` would pick "constructor" or "toString" off
    // Object.prototype and ship a function as a property value.
    if (Object.hasOwn(properties, key)) result[key] = properties[key];
  }
  return result;
}

export interface CreateTelemetryOptions {
  settings: Settings | null | undefined;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  host?: string;
  apiKey?: string;
  batch?: BatchTuning;
}

interface QueuedEvent {
  event: TelemetryEvent;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface Telemetry {
  enabled: boolean;
  /**
   * Installation distinct id used as PostHog `distinct_id`. Empty when the
   * instance has no identity (held first-run no-op, or never generated).
   * Exposed so ambient opt-out can preserve identity for intentional capture.
   */
  installationId: string;
  capture(event: TelemetryEvent, properties?: Record<string, unknown>): void;
  /**
   * Intentional capture that can run when ambient product telemetry is off
   * (`settings.telemetry.enabled === false`). Only `"survey sent"` is accepted —
   * this is not a second ambient path. Still blocked by env kill switches
   * (`DO_NOT_TRACK`, `CORBITS_TELEMETRY=0`), a missing installation id, or a
   * missing API key. Does not re-enable ambient events.
   * @returns true when the event was queued for send
   */
  captureIntentional(event: TelemetryEvent, properties?: Record<string, unknown>): boolean;
  // Sends whatever is queued and waits briefly for it to settle, giving up
  // after a short deadline so a slow endpoint can never hold up process
  // exit. Callers use this to bound exit against dropped fire-and-forget
  // requests without ever making capture() itself blocking.
  flush(): Promise<void>;
  // Throws away everything queued and disarms the batch timer, so nothing
  // captured before this call can ever reach the network. Opting out uses
  // this: a user who says stop mid-session is saying they do not want the
  // activity they have already generated sent, which makes discarding the
  // queue the honest reading of that intent and flushing it a betrayal.
  discard(): void;
}

// Stand-in for callers that were constructed without a telemetry handle —
// tests, and any code path that runs before startup has built the real one.
// Modules take Telemetry as an injected dependency rather than reaching for a
// global, and this is what makes "not injected" mean "emits nothing" instead
// of "throws".
export const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  installationId: "",
  capture: () => {},
  captureIntentional: () => false,
  flush: async () => {},
  discard: () => {},
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
  // Intentional events (operator /feedback) may ship when ambient is
  // settings-disabled, but never when env kill switches fire or identity/key
  // is missing. Does not re-enable ambient capture.
  const intentionalEnabled =
    !telemetryDisabledByEnv(env) && apiKey.length > 0 && installationId.length > 0;

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

  function enqueue(event: TelemetryEvent, properties?: Record<string, unknown>): void {
    // Own-property only: `in` walks Object.prototype, so capture("toString")
    // or capture("constructor") would clear the guard this exists to be and
    // hand allowedProperties a function where it expects an allowlist array.
    if (!Object.hasOwn(EVENT_PROPERTY_ALLOWLIST, event)) return;

    queue.push({
      event,
      timestamp: new Date().toISOString(),
      properties: {
        ...allowedProperties(event, properties),
        // PostHog's built-in Version breakdown reads $app_version; without it
        // every event buckets as "Other". service_version is the same value
        // kept for dashboards that already filter on the custom property.
        $app_version: pkg.version,
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

  function capture(event: TelemetryEvent, properties?: Record<string, unknown>): void {
    if (!enabled) return;
    enqueue(event, properties);
  }

  function captureIntentional(
    event: TelemetryEvent,
    properties?: Record<string, unknown>,
  ): boolean {
    // One intentional door: free-text survey only. Ambient product/AI events
    // must never ride the ambient-bypass path.
    if (event !== "survey sent") return false;
    if (!intentionalEnabled) return false;
    enqueue(event, properties);
    return true;
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

  // A request already on the wire cannot be unsent, but nothing still held
  // in memory follows it.
  function discard(): void {
    cancelTimer();
    queue.length = 0;
  }

  return { enabled, installationId, capture, captureIntentional, flush, discard };
}
