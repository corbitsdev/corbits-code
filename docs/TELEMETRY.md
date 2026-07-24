# Telemetry

Intercode sends a small amount of anonymous usage telemetry to PostHog to help
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
(`distinct_id`), `service_version`, `os_type`, `os_arch`, and a
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
- Set `"telemetry": { "enabled": false }` in `~/.intercode/settings.json`
- `INTERCODE_TELEMETRY` set to any falsy value: `0`, `false`, `off`, `no`, or empty
- `DO_NOT_TRACK=1` (the standard [Console Do Not Track](https://consoledonottrack.com/) convention)

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
first run and stored in `~/.intercode/settings.json`. It identifies an
installation, not a person — there is no account, email, or other PII behind
it.

## Backend

Events are sent to PostHog. PostHog derives an approximate country from the
request IP server-side; the client sends no location data itself. No
self-hosted or third-party analytics beyond PostHog are used.
