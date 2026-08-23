# Codex / Responses SSE fixtures

Sanitized multi-event streams for golden tests of `parseResponse` in
`src/provider/codex-responses-adapter.ts`.

Each `*.json` file is a JSON array of Responses SSE **data payloads** (the
object after `data: ` on each SSE line). No real tokens, prompts, account IDs,
or user content — placeholders only.

| Fixture                                 | Covers                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `interleaved-reasoning-text-tools.json` | Reasoning summary + text + function_call, encrypted signature, usage   |
| `incomplete.json`                       | Truncated stream ending in `response.incomplete`                       |
| `failed.json`                           | `response.failed` with error message                                   |
| `error.json`                            | Top-level stream `error` event                                         |
| `lifecycle-ignored.json`                | `response.created` / `in_progress` / content_part / `*.done` envelopes |

Loaded by `tests/unit/codex-sse-fixtures.test.ts`.

## First-class InferenceEvent shapes (adapter output)

These fixtures pin the **adapter → InferenceEvent** mapping (not harness-normalized
events). Expected first-class types:

| Wire / condition                                                       | InferenceEvent                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `response.reasoning_*` / reasoning `output_item`                       | `inference.thinking.delta`, `inference.thinking.signature` |
| `response.output_text.delta`                                           | `inference.text.delta`                                     |
| `function_call` on `output_item.added`                                 | `inference.tool_call.start` (real `call_id`)               |
| `response.function_call_arguments.delta`                               | `inference.tool_call.delta`                                |
| `response.completed` with usage                                        | `inference.usage`                                          |
| `response.incomplete`                                                  | no events (terminal for stream helpers)                    |
| `response.failed` / top-level `error`                                  | throw `ProtocolMismatchError`                              |
| lifecycle envelopes (`created`, `in_progress`, `*.done`, content_part) | no events                                                  |

### `tool_call.delta` callId (intentional)

On `tool_call.start`, the adapter emits the backend's real `call_id`. On argument
deltas it emits `callId: String(blockIndex)` — a **placeholder** keyed to the
block index registered on start. The inference harness resolves that placeholder
via `indexToCallId` (see `vendor/intx-inference` harness comments). Golden tests
assert the adapter wire shape, not the post-harness real id.

### Usage

Usage is emitted only from `response.completed` (not from incomplete or failed
streams). There is no separate incremental-usage path in this adapter.
