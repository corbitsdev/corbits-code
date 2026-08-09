# Telemetry

Corbits Code sends a small amount of anonymous usage telemetry to PostHog to help
us understand aggregate usage. It is opt-out, contains no PII, and never
includes prompts, code, file contents, or paths.

## What's collected

Three events, each with a small set of properties:

| Event | When | Properties |
|---|---|---|
| `cli_start` | Once per used session (see First-run disclosure) | (none beyond common properties) |
| `session_end` | When a TUI session finishes | `status`, `turn_count`, `duration_ms`, `session_mode`, `exit_reason` |
| `inference_turn` | Once per completed turn | `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `thinking_tokens`, `duration_ms` |

Common properties attached to every event: a random installation UUID
(`distinct_id`), `session_id`, `service_version`, `os_type`, `os_arch`, and a
`schema_version` for forward compatibility.

Approximate country-level location is derived server-side by PostHog from the
request IP; no location data is collected by the client.

Every event is capped to an explicit property allowlist before it leaves the
process — no other field can ever be attached, even by accident.

`provider_id` is the canonical provider kind resolved by the runtime (e.g.
`openai-compatible`), never the free-text name you gave the provider in
onboarding or settings. `model_id` is the model identifier exactly as
configured — it is the one user-entered string that is sent, so do not put
anything identifying in a model name.

## What's never collected

- Prompts, model output, or any conversation content
- File paths, file contents, or repo/project names
- API keys, tokens, or any other credential
- Anything not in the allowlist above

## Opting out

Any of the following disables telemetry entirely:

- Turn it off in the TUI: `/settings` → Telemetry tab → Off
- Set `"telemetry": { "enabled": false }` in `~/.corbits/settings.json`
- `CORBITS_TELEMETRY` set to any falsy value: `0`, `false`, `off`, `no`, or empty
- `DO_NOT_TRACK=1` (the standard [Console Do Not Track](https://consoledonottrack.com/) convention)

Turning telemetry off also discards whatever is still queued and unsent.
Events captured earlier in the session but not yet transmitted are thrown
away at the moment you opt out, not sent on the way out — opting out covers
the activity you have already generated, not just the activity still to
come. A batch already in flight to the server at the moment you opt out is
not recalled; discarding only reaches events still held in memory.

Re-enable from the same Telemetry tab or by removing the env var / settings
override. While an env kill is active the Telemetry tab cannot re-enable —
the env override always wins, and the attempt is refused rather than
silently ignored.

## First-run disclosure

Nothing is ever sent before the user has had the notice in front of them
and taken an affirmative action (consent by proceeding). Until the one-time
notice has been shown, startup leaves telemetry as a disabled no-op — no
event of any kind can leave the process. The notice renders in whichever
surface a new user reaches first: the onboarding panel on a fresh install,
the TUI banner otherwise. Telemetry then activates — and the held
`cli_start` fires — on the first affirmative action taken with the notice
visible: completing onboarding, or interactively submitting the first
prompt in the TUI. Quitting without acting sends nothing for that launch;
disabling in `/settings` before acting means nothing is ever sent. A user
who saw the notice but took no action starts sending from the next launch.

Two consequences worth naming. `cli_start` counts used sessions, not
launches: someone who launches, looks around, and quits never registers, so
the dashboard number is "sessions where the user did something", by design.
And explicitly switching the `/settings` Telemetry toggle to On while the
first-run hold is active is itself an affirmative action — it enables
telemetry immediately through the toggle path, without waiting for a first
prompt; the held `cli_start` still fires when (and only when) a first
prompt is later submitted.

## Identification

`installationId` is a random UUID (`crypto.randomUUID()`) generated once on
first run and stored in `~/.corbits/settings.json`. It identifies an
installation, not a person — there is no account, email, or other PII behind
it.

`session_id` is a separate random UUID minted fresh each time the CLI
process starts; it lives only in memory and is never written to disk or to
`~/.corbits/settings.json`. It lets events be correlated within a single run
and cannot be used to link one run to another.

## Backend

Events are sent to PostHog. PostHog derives an approximate country from the
request IP server-side; the client sends no location data itself. No
self-hosted or third-party analytics beyond PostHog are used.

## On the wire

Events are not sent one at a time. Each captured event is stamped with its
capture time and held in an in-memory queue, which is posted to PostHog's
`/batch/` endpoint when it reaches the batch size or when the batch
interval elapses, whichever comes first. At most one request is ever in
flight: events captured while a request is open wait for it rather than
opening another connection. Exit paths flush the queue, bounded by a short
deadline so a slow endpoint cannot delay quitting.

The queue has a hard depth limit. Once it is full — which in practice means
the endpoint is unreachable, as on a captive portal or behind a hung proxy
— the oldest queued events are dropped to make room for new ones. Telemetry
is therefore lossy by design: it never grows memory without bound, never
retries indefinitely, and never blocks or reports failures to the user.
Nothing is written to disk, so dropped events are gone rather than deferred
to a later run.

See `src/telemetry/index.ts` for the batch size, interval, and queue limit
in force.

## Not this document

Local performance tracing and optional OpenTelemetry export to an operator-owned
collector (Phoenix, PostHog OTEL, Jaeger, generic OTLP) are documented in
`docs/PERFTRACE.md`. That pipe is separate: it does not expand these three
events, and product telemetry opt-out does not control OTEL export.
