# Telemetry

Corbits Code sends a small amount of anonymous usage telemetry to PostHog to help
us understand aggregate usage. It is opt-out. **Ambient** product and AI events
contain no PII and never include prompts, code, file contents, or paths.
**Intentional** free text the operator submits via `/feedback` is the sole
exception — that path can ship when ambient telemetry is off, still subject to
env kill switches (see Intentional feedback below).

## What's collected

Each event carries a small set of properties:

| Event               | When                                                                                | Properties                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli_start`         | Once per used session (see First-run disclosure)                                    | (none beyond common properties)                                                                                                                                                                                                                                                          |
| `session_end`       | When a TUI session finishes                                                         | `status`, `turn_count`, `duration_ms`, `session_mode`, `exit_reason`                                                                                                                                                                                                                     |
| `$ai_generation`    | Once per completed turn (may be sampled); always on turn failure                    | `$ai_trace_id`, `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`, `$ai_is_error`, `$ai_error`, `$ai_cache_read_input_tokens`, `$ai_cache_creation_input_tokens`, `$ai_reasoning_tokens`, `tool_call_count`, `tool_error_count`, `subagent_call_count` |
| `$ai_span`          | Opt-in only — once per top-level tool call when `CORBITS_TELEMETRY_AI_SPANS` is set | `$ai_trace_id`, `$ai_span_id`, `$ai_parent_id`, `$ai_span_name`, `$ai_is_error`                                                                                                                                                                                                          |
| `slash_command`     | A slash command is dispatched (shared product-event path)                           | `command_name`                                                                                                                                                                                                                                                                           |
| `skill_used`        | `use_skill` loads a skill that resolved                                             | (none beyond common properties)                                                                                                                                                                                                                                                          |
| `plugin_loaded`     | First successful load of a plugin identity in this process                          | `origin`                                                                                                                                                                                                                                                                                 |
| `subagent_start`    | A `task` / fleet dispatch begins                                                    | `agent_name`                                                                                                                                                                                                                                                                             |
| `subagent_end`      | A `task` / fleet dispatch finishes                                                  | `agent_name`, `status`, `duration_ms`, `model`, `turn_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `tool_call_count`, `tool_error_count`, `stop_reason`, `parent_trace_id`                                                    |
| `permission_prompt` | An approval prompt is answered (or abandoned)                                       | `decision`, `permission_kind`                                                                                                                                                                                                                                                            |
| `compaction`        | The compactor actually folds turns away                                             | `mode`, `duration_ms`, `turns_before`, `turns_after`                                                                                                                                                                                                                                     |
| `crash`             | A fatal error reaches the process-level handler                                     | `kind`, `error_class`                                                                                                                                                                                                                                                                    |
| `auth_failure`      | A provider rejects the stored credentials                                           | `auth_provider`                                                                                                                                                                                                                                                                          |
| `survey sent`       | User submits intentional feedback via `/feedback`                                   | `$survey_id`, `$survey_response`, `$survey_questions`, `turn_trace_id`                                                                                                                                                                                                                   |

`compaction` is deliberately silent on the runs where the compactor decides
there is nothing to compact — an event that also fires on no-ops makes its own
duration and turn-count averages meaningless.

Common properties attached to every event: a random installation UUID
(`distinct_id`), `session_id`, `$app_version` (PostHog's standard Version
property, the running package version), `service_version` (same value, kept
for existing custom-property dashboards), `os_type`, `os_arch`, and a
`schema_version` for forward compatibility. Ambient product and AI events also
carry `$process_person_profile: false` so PostHog treats them as anonymous
(batch capture otherwise defaults to identified processing). Intentional
`survey sent` omits that flag so `/feedback` can still join a person profile
if one is ever created.

Approximate country-level location is derived server-side by PostHog from the
request IP; no location data is collected by the client.

Every event is capped to an explicit property allowlist before it leaves the
process — no other field can ever be attached, even by accident.

`$ai_provider` is the canonical provider kind resolved by the runtime (e.g.
`openai-compatible`), never the free-text name you gave the provider in
onboarding or settings. `$ai_model` is the model identifier exactly as
configured — it is the one user-entered string that is sent, so do not put
anything identifying in a model name.

## Names are never sent, only categories

Most of the things a usage event would naturally want to name are named by
someone other than us: an MCP server key is a key in your settings, a skill is
a directory in your repo, a plugin id is chosen by its author, an agent profile
and a plugin's slash commands are project-local. On a private repo those names
are your employer, your internal services, or fragments of your paths.

So none of them are transmitted. Each is matched against a fixed list of names
this project itself ships and reported as that name, or as `custom` when it
matches nothing — with `mcp` as its own bucket for `permission_kind`, so the
share of prompts driven by MCP stays visible without the server key coming
with it. `agent_name` on `subagent_*` is the same pattern: first-party
director ids from `DIRECTOR_IDS` (and the legacy `worker` alias) are reported
by id; project-defined or marketplace profile ids become `custom`.
`skill_used` and `plugin_loaded` go further: there is no first-party list of
skills or plugins to match against, so `skill_used` carries no name at all and
`plugin_loaded` carries only `origin`, the discovery tier (`repo`, `user`,
`project`, `path`). Enabled telemetry reports the same plugin identity at most
once per runtime reporter, including across reloads. Disabled/no-op loads do not
consume that identity, so enabling telemetry later can report the first real
load.

`error_class` is bucketed the same way: only the error types defined by the
language are reported by name, because an error subclass defined in
application or plugin code is as author-chosen as any other string. It appears
on `crash` and nowhere else, so the column means one thing everywhere it is
recorded.

`auth_provider` is a separate property for that reason: it names which
provider's sign-in was rejected (`codex`, `xai`, `anthropic`, `other`),
chosen from a fixed first-party set in `src/tui/session-chrome.ts`. No
part of the provider's rejection message is sent.

The mapping is `src/telemetry/classify.ts`, and the tests that feed each
emission site a deliberately identifying name and assert it reaches no part of
the payload are in `tests/unit/telemetry-product-events.test.ts`.

## AI observability events

`$ai_generation` and (optionally) `$ai_span` are the PostHog AI observability
events, emitted from `src/telemetry/ai-observability.ts`. PostHog's LLM
analytics views query the `$ai_`-prefixed properties and nothing else, which
is why these names are not ours to choose. `$ai_latency` is a duration in
**seconds** as a float, per PostHog's schema — the runtime measures
milliseconds and converts.

**Default volume shape (CL-6816):** each completed primary turn emits **one**
`$ai_generation` with tool/subagent aggregates folded onto it
(`tool_call_count`, `tool_error_count`, `subagent_call_count`). Per-call
`$ai_span` events are **off by default**. Set `CORBITS_TELEMETRY_AI_SPANS` to
a truthy value (`1`, `true`, …) to restore per-call spans for debugging.
Leaf `runSubAgent` workers do not emit `$ai_*`; worker rollups travel on
`subagent_end` instead. Both TUI and exec install the same turn observer, so a
worker ending during an active parent turn carries that turn's `parent_trace_id`.

A deterministic representative fixture uses 10 parent turns with 80 parent tool
calls and 4 workers totaling 24 turns and 96 tool calls. The former per-call and
worker-generation shape is 218 billable events; the default aggregate shape is
18 (10 generations plus 4 start/end pairs), a 91.7% reduction. This is a test
fixture, not a claim about production PostHog traffic.

Successful `$ai_generation` events may be sampled with
`CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE` (a float in `0`–`1`, default `1.0`
= keep all). An empty env value is treated as unset (keep all), not as `0`.
Errored generations (`$ai_is_error: true`), `crash`, and `auth_failure` always
ship regardless of the sample rate. When a successful generation is sampled
out, opt-in `$ai_span`s for that turn are skipped too — a span without its
parent generation is not useful in PostHog traces.

The trace is **flat**. Every turn gets one `$ai_trace_id` derived from the
runtime's session id and the turn index; the turn's `$ai_generation` and each
of its `$ai_span`s (when spans are enabled) carry it, and every span's
`$ai_parent_id` is that same trace id rather than another span. PostHog
documents `$ai_parent_id` as accepting either a trace id or a span id, so
this is a legal trace, and it is all the runtime can honestly describe: the
turn record only exposes top-level tool calls. No `$ai_trace` event is
emitted — PostHog synthesises the trace from its children.

`$ai_span_id` is the provider-generated opaque tool call id. It identifies
the call within the trace and carries nothing else.

`$ai_span_name` is one of a fixed enum (`tool_call`, `subagent_call`). The raw
tool name is never sent: an MCP tool name embeds the server identifier it was
configured under, which can be a local path.

`$ai_error` is likewise one of a fixed enum (`rate_limit`, `auth`, `timeout`,
`cancelled`, `inference_failed`). The provider's error message is classified
into one of these and then discarded — a raw message routinely embeds the
request URL, a prompt excerpt, or a file path.

Cache and reasoning token counts use PostHog's documented cost-property names
(`$ai_cache_read_input_tokens`, `$ai_cache_creation_input_tokens`,
`$ai_reasoning_tokens`) so LLM cost views see them. Confirmed against PostHog
manual-capture installation docs and the cost-properties reference (CL-5749).

Stopping a turn mid-inference is reported, not silent: the runtime aborts the
in-flight call and classifies the resulting error as `cancelled`, so a stopped
turn produces the same errored `$ai_generation` as a failed one and is told
apart by `$ai_error`. A turn that never reaches inference at all — suspended
at an approval prompt and never resumed — emits nothing, because the runtime
raises no event for it.

Terminal generation settlement belongs to `src/session/run-sink.ts`.
`inference.error` records only a pending attempt failure: retry success or a
completed message run discards it. `inference.done` settles success and only
then applies successful-generation sampling. A failed `message.run.ended`
settles an unresolved turn once as an unsampled terminal failure, attributed to
the provider/model snapshot from the latest `inference.start`. Therefore a
parent turn emits at most one terminal `$ai_generation`, including retry and
failover paths.

## What's never collected

- Prompts, model output, or any conversation content (except intentional
  free-text the operator types into `/feedback` — see below)
- File paths, file contents, or repo/project names
- Names anyone but this project chose: MCP servers, skills, plugins, agent
  profiles, plugin-registered slash commands, error subclasses (see above)
- Shell commands, tool arguments, or tool results
- API keys, tokens, or any other credential
- Anything not in the allowlist above

## Intentional feedback (`/feedback`)

`/feedback` is a first-party slash command that captures operator free text as
a PostHog custom survey response (`survey sent`). Two UX modes:

1. `/feedback <text>` — send immediately
2. bare `/feedback` — prompts for free text; the next non-command Enter submits
   that line as the response (Empty Enter cancels)

Free text is capped at 2000 characters. When known, the last turn’s
`$ai_trace_id` is attached as `turn_trace_id` so a report can be linked to the
recent generation.

This path is **intentional**: it can still ship when ambient product telemetry
is off (`settings.telemetry.enabled === false` or the Telemetry toggle Off),
because the operator typed the text for that purpose. Hard env kill switches
still win — `DO_NOT_TRACK=1` or `CORBITS_TELEMETRY=0/false/off/no` block
`/feedback` as well. Sending also requires an installation id and API key.
Unlike ambient events, `survey sent` does not stamp `$process_person_profile:
false`, so the response can join a person profile if one is ever created.

Survey id / question id are **baked into the client** (Corbits team survey
`Corbits Code Feedback`). Same trust class as the public PostHog project key —
operators never configure them. Optional env overrides
(`CORBITS_FEEDBACK_SURVEY_ID`, `CORBITS_FEEDBACK_QUESTION_ID`) exist for tests
and forks; setting either to empty fails closed and hides the command from the
slash menu. Success copy says “sent” after the capture is accepted and flushed
toward PostHog (best-effort network delivery is not awaited on the operator
path). Free text over 2000 characters is truncated with an explicit notice.

## Opting out

Any of the following disables ambient product telemetry (not intentional
`/feedback` unless noted):

- Turn it off in the TUI: `/settings` → Telemetry tab → Off
- Set `"telemetry": { "enabled": false }` in `~/.corbits/settings.json`
- `CORBITS_TELEMETRY` set to any falsy value: `0`, `false`, `off`, `no`, or empty
  (also blocks intentional `/feedback`)
- `DO_NOT_TRACK=1` (the standard [Console Do Not Track](https://consoledonottrack.com/)
  convention; also blocks intentional `/feedback`)

Turning ambient telemetry off discards whatever is still queued and unsent for
product events. Events captured earlier in the session but not yet transmitted
are thrown away at the moment you opt out, not sent on the way out — opting out
covers the activity you have already generated, not just the activity still to
come. Installation identity is retained so intentional `/feedback` can still
send (unless an env kill switch is active).

Env kill switches disable **everything**, including `/feedback`. The settings
toggle alone does not.

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
`docs/PERFTRACE.md`. That pipe is separate: it does not expand the events
above, and product telemetry opt-out does not control OTEL export.
