# Codex / Responses SSE fixtures

Sanitized multi-event streams for golden tests of `parseResponse` in
`src/provider/codex-responses-adapter.ts`.

Each `*.json` file is a JSON array of Responses SSE **data payloads** (the
object after `data: ` on each SSE line). No real tokens, prompts, account IDs,
or user content — placeholders only.

| Fixture | Covers |
| --- | --- |
| `interleaved-reasoning-text-tools.json` | Reasoning summary + text + function_call, encrypted signature, usage |
| `incomplete.json` | Truncated stream ending in `response.incomplete` |
| `failed.json` | `response.failed` with error message |
| `error.json` | Top-level stream `error` event |
| `lifecycle-ignored.json` | `response.created` / `in_progress` / content_part / `*.done` envelopes |

Loaded by `tests/unit/codex-sse-fixtures.test.ts`.
