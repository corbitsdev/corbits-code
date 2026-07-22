# Telemetry

Intercode sends a small amount of anonymous usage telemetry to PostHog to help
us understand aggregate usage. It is opt-out, contains no PII, and never
includes prompts, code, file contents, or paths.

## What's collected

Two events, each with a small set of properties:

| Event | When | Properties |
|---|---|---|
| `cli_start` | Once per process launch | (none beyond common properties) |
| `session_end` | When a TUI session finishes | `status`, `turn_count`, `duration_ms`, `session_mode` |

Common properties attached to every event: a random installation UUID
(`distinct_id`), `service_version`, `os_type`, `os_arch`, and a
`schema_version` for forward compatibility. IP-based geolocation is disabled
(`$geoip_disable: true`).

Every event is capped to an explicit property allowlist before it leaves the
process — no other field can ever be attached, even by accident.

## What's never collected

- Prompts, model output, or any conversation content
- File paths, file contents, or repo/project names
- API keys, tokens, or any other credential
- IP address geolocation (disabled at the PostHog level)
- Anything not in the allowlist above

## Opting out

Any of the following disables telemetry entirely:

- `/telemetry off` in the TUI
- Set `"telemetry": { "enabled": false }` in `~/.intercode/settings.json`
- `INTERCODE_TELEMETRY=0`
- `DO_NOT_TRACK=1` (the standard [Console Do Not Track](https://consoledonottrack.com/) convention)

Re-enable with `/telemetry on` or by removing the env var / settings override.

## Identification

`installationId` is a random UUID (`crypto.randomUUID()`) generated once on
first run and stored in `~/.intercode/settings.json`. It identifies an
installation, not a person — there is no account, email, or other PII behind
it.

## Backend

Events are sent to PostHog with geoip lookups disabled. No self-hosted or
third-party analytics beyond PostHog are used.
