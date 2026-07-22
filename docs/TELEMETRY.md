# Telemetry

Intercode sends a small amount of anonymous usage telemetry to PostHog to help
us understand aggregate usage. It is opt-out, contains no PII, and never
includes prompts, code, file contents, or paths.

## What's collected

Three events, each with a small set of properties:

| Event | When | Properties |
|---|---|---|
| `cli_start` | Once per process launch | (none beyond common properties) |
| `session_end` | When a TUI session finishes | `status`, `turn_count`, `duration_ms`, `session_mode`, `exit_reason` |
| `message_send` | Once per completed turn | `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `thinking_tokens`, `duration_ms` |

Common properties attached to every event: a random installation UUID
(`distinct_id`), `service_version`, `os_type`, `os_arch`, and a
`schema_version` for forward compatibility.

Approximate country-level location is derived server-side by PostHog from the
request IP; no location data is collected by the client.

Every event is capped to an explicit property allowlist before it leaves the
process — no other field can ever be attached, even by accident.

## What's never collected

- Prompts, model output, or any conversation content
- File paths, file contents, or repo/project names
- API keys, tokens, or any other credential
- Anything not in the allowlist above

## Opting out

Any of the following disables telemetry entirely:

- Turn it off in the TUI: `/settings` → Telemetry tab → Off
- Set `"telemetry": { "enabled": false }` in `~/.intercode/settings.json`
- `INTERCODE_TELEMETRY=0`
- `DO_NOT_TRACK=1` (the standard [Console Do Not Track](https://consoledonottrack.com/) convention)

Re-enable from the same Telemetry tab or by removing the env var / settings
override.

## Identification

`installationId` is a random UUID (`crypto.randomUUID()`) generated once on
first run and stored in `~/.intercode/settings.json`. It identifies an
installation, not a person — there is no account, email, or other PII behind
it.

## Backend

Events are sent to PostHog. PostHog derives an approximate country from the
request IP server-side; the client sends no location data itself. No
self-hosted or third-party analytics beyond PostHog are used.
