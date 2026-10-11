import { randomUUID } from "node:crypto";

import pkg from "../../package.json" with { type: "json" };
import { ENV_PREFIX } from "../branding.js";
import type { Settings } from "../config/settings.js";

// Compile-time defaults, env-overridable for tests. An empty API key
// disables export even when the flag says enabled.
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_POSTHOG_API_KEY =
  "phc_BWpXcEx3XBH2EiuNi3fXrdzfgnfbVe4WbVyfR8r5KbLp";

const TELEMETRY_HOST_ENV = `${ENV_PREFIX}TELEMETRY_HOST`;
const TELEMETRY_KEY_ENV = `${ENV_PREFIX}TELEMETRY_KEY`;
export const TELEMETRY_ENV = `${ENV_PREFIX}TELEMETRY`;
export const TELEMETRY_AI_SPANS_ENV = `${ENV_PREFIX}TELEMETRY_AI_SPANS`;
export const TELEMETRY_GENERATION_SAMPLE_RATE_ENV = `${ENV_PREFIX}TELEMETRY_GENERATION_SAMPLE_RATE`;

export const POSTHOG_HOST =
  process.env[TELEMETRY_HOST_ENV] ?? DEFAULT_POSTHOG_HOST;

export const POSTHOG_API_KEY =
  process.env[TELEMETRY_KEY_ENV] ?? DEFAULT_POSTHOG_API_KEY;

// Upper bound on how long flush() may hold up exit; anything past it drops.
const FLUSH_DEADLINE_MS = 500;

// Batching defaults: events accumulate until size or interval fires instead
// of one socket per event. The queue limit caps memory when the endpoint is
// unreachable.
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BATCH_INTERVAL_MS = 10_000;
const DEFAULT_QUEUE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 3000;

export interface BatchTuning {
  size?: number;
  intervalMs?: number;
  queueLimit?: number;
}

// Shown once per install on the first surface a new user reaches: the
// onboarding panel on a fresh install, the TUI banner otherwise.
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
  | "summarizer_failure"
  | "crash"
  | "auth_failure"
  | "auth_success"
  | "mcp_connect"
  | "mcp_oauth"
  // PostHog Surveys event name (space included). Intentional /feedback —
  // can ship with ambient telemetry off; still blocked by env kills.
  | "survey sent";

// Fixed span-name enum. Raw tool names never ship: an MCP tool id carries
// its configured server identifier (`mcp__<server>__<tool>`), which can be
// a local path. Callers classify a tool call before capturing "$ai_span".
export const AI_SPAN_KINDS = ["tool_call", "subagent_call"] as const;
export type AiSpanKind = (typeof AI_SPAN_KINDS)[number];

// Fixed error-reason enum. Provider error text is free text with URLs,
// prompt excerpts, and paths, so it never leaves the process; callers
// classify before capturing.
export const AI_ERROR_KINDS = [
  "rate_limit",
  "auth",
  "timeout",
  "cancelled",
  "inference_failed",
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

// One id per interactive process (TUI session or CLI invocation), generated
// once at module load and reused by every instance — including across the
// toggle's re-creation — so PostHog groups this process's events into one
// session. Other emitters read it via getSessionId().
const SESSION_ID = randomUUID();

export function getSessionId(): string {
  return SESSION_ID;
}

// Per-event property allowlist; anything else is stripped before send. With
// the fixed common props capture() appends, this bounds everything
// telemetry can contain.
const EVENT_PROPERTY_ALLOWLIST: Record<TelemetryEvent, readonly string[]> = {
  cli_start: ["surface"],
  session_end: [
    "status",
    "turn_count",
    "duration_ms",
    "session_mode",
    "exit_reason",
  ],
  // PostHog's LLM analytics views query only $ai_-prefixed properties.
  // $ai_provider/$ai_model are canonical runtime ids, never user-typed
  // names. $ai_latency is seconds per PostHog's schema; cache/reasoning
  // counts use PostHog's documented cost-property names.
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
    "$ai_cache_reporting_exclusive",
    "$ai_reasoning_tokens",
    // Aggregates folded from per-call spans.
    "tool_call_count",
    "tool_error_count",
    "subagent_call_count",
  ],

  // Flat trace: every span parents onto the turn's $ai_trace_id (TurnContext
  // only sees top-level tool calls). $ai_span_name is always one of
  // AI_SPAN_KINDS.
  $ai_span: [
    "$ai_trace_id",
    "$ai_span_id",
    "$ai_parent_id",
    "$ai_span_name",
    "$ai_is_error",
  ],
  // All identifiers are first-party enums from classify.ts, never user or
  // author names. The allowlist bounds keys; the classifiers bound values;
  // independent guards on purpose.
  slash_command: ["command_name"],
  // skill_name is a bundled corbits-skills name (see classifySkillName) or
  // "custom" — project/plugin names never ship.
  skill_used: ["skill_name"],
  // origin is the discovery tier (repo/user/project/path); the manifest id
  // is author-chosen free text, not sent.
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
  compaction: [
    "mode",
    "duration_ms",
    "turns_before",
    "turns_after",
    "live_tokens",
  ],
  // provider/model are canonical runtime ids (same trust class as
  // $ai_provider/$ai_model); error_kind is a first-party enum, never the
  // provider's error text.
  summarizer_failure: ["provider", "model", "error_kind", "duration_ms"],
  crash: ["kind", "error_class"],
  // Which provider rejected, not why — the rejection detail is provider-
  // authored text; error_class is a JS constructor name.
  auth_failure: ["auth_provider"],
  // Which provider accepted credentials during setup (OAuth login or
  // validated API key), same first-party enum as auth_failure — never the
  // settings catalog name (operator-authored free text).
  auth_success: ["auth_provider"],
  // One MCP connection attempt: transport is http vs stdio, never the server
  // name or URL; result is the settled outcome, never the error text.
  mcp_connect: ["transport", "result"],
  // One MCP browser-OAuth wait outcome: completed, cancelled (operator
  // abandoned/denied), or timed out. No server identity.
  mcp_oauth: ["result"],
  // Intentional /feedback survey response (PostHog custom survey shape).
  // Free text only because the operator typed it for that purpose.
  // turn_trace_id links the last $ai_generation when known.
  "survey sent": [
    "$survey_id",
    "$survey_questions",
    "$survey_response",
    "turn_trace_id",
  ],
};

const FALSY_ENV_FLAG_VALUES = new Set(["", "0", "false", "off", "no"]);

// Trimmed so ".env" files and shell " 0"/"false\n" values still opt out —
// opt-out parsing fails toward disabled.
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
export function generationSampleRate(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[TELEMETRY_GENERATION_SAMPLE_RATE_ENV];
  if (raw === undefined) return 1;
  const trimmed = raw.trim();
  // Empty env is unset, not 0 — Number("") is 0 and would silently drop
  // every successful generation.
  if (trimmed.length === 0) return 1;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

// Env kills win over settings and need none — callers skip settings writes
// entirely. Falsy CORBITS_TELEMETRY and truthy DO_NOT_TRACK share the same
// flag parsing, so the two switches agree on what counts as "off".
export function telemetryDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[TELEMETRY_ENV] !== undefined && !truthyEnvFlag(env[TELEMETRY_ENV]))
    return true;
  return truthyEnvFlag(env.DO_NOT_TRACK);
}

// Fail closed: runs only when not disabled, DNT is absent, and a real
// installation id and API key exist.
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
    // Own-property only: `in` would pull "constructor"/"toString" off
    // Object.prototype and ship a function as a value.
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
  // Upper bound on how long flush() may hold up exit, in ms. Defaults to
  // FLUSH_DEADLINE_MS; tests override to exercise the give-up contract
  // without paying the production 500ms.
  flushDeadlineMs?: number;
}

interface QueuedEvent {
  event: TelemetryEvent;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface Telemetry {
  enabled: boolean;
  /**
   * PostHog `distinct_id`. Empty when the instance has no identity (held
   * first-run no-op). Exposed so ambient opt-out can preserve identity for
   * intentional capture.
   */
  installationId: string;
  capture(event: TelemetryEvent, properties?: Record<string, unknown>): void;
  /**
   * Intentional capture that runs when ambient telemetry is off. Only
   * `"survey sent"` is accepted — not a second ambient path. Still blocked by
   * env kills, a missing installation id, or a missing API key; never
   * re-enables ambient events.
   * @returns true when the event was queued for send
   */
  captureIntentional(
    event: TelemetryEvent,
    properties?: Record<string, unknown>,
  ): boolean;
  // Sends queued events and waits up to a short deadline so a slow endpoint
  // can never hold up exit; capture() itself never blocks.
  flush(): Promise<void>;
  // Drops the queue and disarms the batch timer so nothing captured before
  // this call ships. Opting out uses this: a user who stops mid-session
  // does not want already-generated activity sent — discarding is the
  // honest reading, flushing a betrayal.
  discard(): void;
}

// Stand-in for callers without a telemetry handle — tests, and code that
// runs before startup builds the real one. Modules inject Telemetry rather
// than reaching for a global, so "not injected" means "emits nothing", not
// "throws".
export const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  installationId: "",
  capture: () => undefined,
  captureIntentional: () => false,
  flush: async () => undefined,
  discard: () => undefined,
};

// Fire-and-forget PostHog batch client. Never throws or blocks; errors
// (including timeouts) are swallowed since telemetry must never affect
// product behavior.
export function createTelemetry(options: CreateTelemetryOptions): Telemetry {
  const env = options.env ?? process.env;
  const host = options.host ?? POSTHOG_HOST;
  const apiKey = options.apiKey ?? POSTHOG_API_KEY;
  const enabled = resolveTelemetryEnabled(options.settings, env, apiKey);
  const fetchFn = options.fetchFn ?? fetch;
  const installationId = options.settings?.telemetry?.installationId ?? "";
  // Intentional /feedback may ship when ambient is settings-disabled, never
  // when env kills fire or identity/key is missing; does not re-enable
  // ambient capture.
  const intentionalEnabled =
    !telemetryDisabledByEnv(env) &&
    apiKey.length > 0 &&
    installationId.length > 0;

  const batchSize = options.batch?.size ?? DEFAULT_BATCH_SIZE;
  const batchIntervalMs =
    options.batch?.intervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const flushDeadlineMs = options.flushDeadlineMs ?? FLUSH_DEADLINE_MS;
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
      // Swallow all errors — telemetry never surfaces failures.
    }
  }

  // Reuses the running drain so at most one request is open; mid-flight
  // captures join that drain's next iteration.
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

  function enqueue(
    event: TelemetryEvent,
    properties: Record<string, unknown> | undefined,
    mode: "ambient" | "intentional",
  ): void {
    // Own-property only: `in` walks the prototype, so capture("toString") or
    // capture("constructor") would defeat the allowlist guard.
    if (!Object.hasOwn(EVENT_PROPERTY_ALLOWLIST, event)) return;

    queue.push({
      event,
      timestamp: new Date().toISOString(),
      properties: {
        ...allowedProperties(event, properties),
        // Ambient events are anonymous: PostHog batch defaults to identified
        // processing, so stamp this explicitly. Intentional /feedback may
        // stay identified so a survey can join a person profile if one is
        // ever created.
        ...(mode === "ambient" ? { $process_person_profile: false } : {}),
        // PostHog's built-in Version breakdown reads $app_version; without it
        // every event buckets as "Other". service_version is the same value
        // kept for dashboards filtering on the custom property.
        $app_version: pkg.version,
        service_version: pkg.version,
        os_type: process.platform,
        os_arch: process.arch,
        schema_version: 1,
        session_id: SESSION_ID,
      },
    });

    // Drop oldest first: a stuck endpoint makes the head least worth
    // reporting; unbounded growth is never acceptable.
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

  function capture(
    event: TelemetryEvent,
    properties?: Record<string, unknown>,
  ): void {
    if (!enabled) return;
    enqueue(event, properties, "ambient");
  }

  function captureIntentional(
    event: TelemetryEvent,
    properties?: Record<string, unknown>,
  ): boolean {
    // One intentional door, free-text survey only; ambient events never ride
    // the bypass path.
    if (event !== "survey sent") return false;
    if (!intentionalEnabled) return false;
    enqueue(event, properties, "intentional");
    return true;
  }

  async function flush(): Promise<void> {
    cancelTimer();
    if (queue.length === 0 && inFlight === null) return;
    // Race the deadline: stragglers drop rather than delay exit for the full
    // per-request AbortSignal window.
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, flushDeadlineMs);
        deadline.unref?.();
      }),
    ]);
  }

  // A request already on the wire cannot be unsent; nothing still in memory
  // follows it.
  function discard(): void {
    cancelTimer();
    queue.length = 0;
  }

  return {
    enabled,
    installationId,
    capture,
    captureIntentional,
    flush,
    discard,
  };
}
