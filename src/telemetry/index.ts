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

// Shown once per installation, in whichever surface a new user reaches
// first: the onboarding panel on a fresh install (so disclosure accompanies
// the very first event), and the TUI banner otherwise.
export const TELEMETRY_NOTICE =
  "Anonymous usage telemetry is enabled (no prompts, code, or paths collected). Disable in /settings > Telemetry. Docs: docs/TELEMETRY.md";

export type TelemetryEvent =
  | "cli_start"
  | "session_end"
  | "inference_turn"
  | "slash_command"
  | "skill_used"
  | "plugin_loaded"
  | "plugin_used"
  | "subagent_start"
  | "subagent_end"
  | "permission_prompt"
  | "compaction"
  | "crash"
  | "auth_failure";

// A per-process identifier, minted once and reused for every capture() call
// in this process (see CL-5727). It links events from the same run without
// ever carrying identity: it is not persisted and not derived from anything
// user-controlled.
const sessionId = crypto.randomUUID();

export function getSessionId(): string {
  return sessionId;
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
  // command_name is the canonical registry name only (e.g. "feedback") —
  // never the raw command line or any argument text typed after it.
  slash_command: ["command_name"],
  // skill_name is the resolved, known-skill identifier only, and only sent
  // when resolution succeeded — never a filesystem path.
  skill_used: ["skill_name"],
  // plugin_id is the manifest-declared id, never the plugin's local path.
  plugin_loaded: ["plugin_id", "origin"],
  plugin_used: ["plugin_id"],
  subagent_start: ["agent_name", "parent_session_id"],
  subagent_end: ["agent_name", "parent_session_id", "status", "duration_ms"],
  // decision and permission_kind are fixed enums — never the literal
  // command, tool args, or file path being approved.
  permission_prompt: ["decision", "permission_kind"],
  compaction: ["trigger", "duration_ms", "turns_before", "turns_after"],
  // error_class is a fixed/allowlisted code — never a raw error message.
  crash: ["error_class"],
  auth_failure: ["error_class"],
};

const KNOWN_EVENTS = new Set<TelemetryEvent>(Object.keys(EVENT_PROPERTY_ALLOWLIST) as TelemetryEvent[]);

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
};

export type Telemetry = {
  enabled: boolean;
  capture(event: TelemetryEvent, properties?: Record<string, unknown>): void;
  // Waits briefly for captures currently in flight to settle, giving up
  // after a short deadline so a slow endpoint can never hold up process
  // exit. Callers use this to bound exit against dropped fire-and-forget
  // requests without ever making capture() itself blocking.
  flush(): Promise<void>;
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

  // Tracked so flush() can wait for in-flight requests without making
  // capture() itself awaitable.
  const pending = new Set<Promise<void>>();

  function capture(event: TelemetryEvent, properties?: Record<string, unknown>): void {
    if (!enabled) return;
    if (!KNOWN_EVENTS.has(event)) return;

    const body = {
      api_key: apiKey,
      event,
      distinct_id: installationId,
      properties: {
        ...allowedProperties(event, properties),
        service_version: pkg.version,
        os_type: process.platform,
        os_arch: process.arch,
        schema_version: 1,
        session_id: sessionId,
      },
    };

    const request = fetchFn(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
      .then(() => undefined)
      .catch(() => {
        // Swallow all errors — telemetry must never surface failures.
      });
    pending.add(request);
    void request.finally(() => pending.delete(request));
  }

  async function flush(): Promise<void> {
    if (pending.size === 0) return;
    // Race against a short deadline: stragglers are dropped rather than
    // allowed to delay exit for the full 3s per-request AbortSignal window.
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_DEADLINE_MS);
        timer.unref?.();
      }),
    ]);
  }

  return { enabled, capture, flush };
}
