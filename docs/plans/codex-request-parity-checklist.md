# Codex request parity checklist (CL-5168)

**Status:** spike artifact — docs only; no production change in this issue  
**Sources:** Corbits `src/provider/codex-responses-adapter.ts` `buildRequest`; openai/codex public Responses usage; nanocodex (gakonst) as lean-client reference; plan `docs/plans/codex-adapter-enhancements.md`  
**Statuses:** `already_match` · `safe_to_add` · `backend_rejected` · `unknown` · `intentionally_different`

Corbits target: ChatGPT Codex backend (`chatgpt.com/backend-api/codex/responses`), **not** platform `api.openai.com`. Reference clients may target either surface; mark carefully.

---

## Body fields

| Field | Corbits today | openai/codex (ref) | nanocodex (ref) | Status | Notes |
|---|---|---|---|---|---|
| `model` | yes | yes | yes | already_match | Required |
| `input` | full history each turn | full or chained | full or chained | already_match | Continuity via full replay + encrypted reasoning; no delta input yet |
| `instructions` | pinned via `codexInstructions()` | official Codex prompt | often official or close | already_match | Corbits disk/bundled pin; product prompt is **not** here |
| `store` | `false` | typically false for CLI | false | already_match | Backend requires off for encrypted reasoning path |
| `stream` | `true` | true for interactive | true | already_match | |
| `include` | `["reasoning.encrypted_content"]` | encrypted reasoning include | similar when supported | already_match | Round-trip signatures on thinking blocks |
| `parallel_tool_calls` | `false` | varies | varies | intentionally_different | Spike later whether `true` is safe with Corbits tool runtime |
| `tools` | flat Responses tools when present | yes | yes | already_match | |
| `tool_choice` | `"auto"` when tools present | auto / none | auto | already_match | |
| `reasoning.effort` | from `providerOptions.reasoning_effort` when string ≠ `"none"` | yes | yes | already_match | Mapping only; role defaults are product (CL-5162) |
| `reasoning.summary` | `"auto"` when effort set | often auto | often auto | already_match | |
| `prompt_cache_key` | Codex session id when present | session/cache key patterns | session-ish keys | already_match | Confirm vs best clients under load (measure later) |
| `previous_response_id` | **omitted** | may use for continuity | may use | safe_to_add | **Only after PerfTrace attribution (CL-5167)** says payload/transport material |
| `max_output_tokens` | **omitted** | often omitted on Codex backend | often omitted | backend_rejected | Corbits intentionally omits; backend rejects |
| `generate` / warmup | **omitted** | some clients warmup | unknown | unknown | Spike only after attribution (CL-5172) |
| Chat Completions fields (`messages`, `max_tokens`, …) | never | N/A | N/A | intentionally_different | Wrong protocol; must stay absent |
| Free-form body extras | none | varies | varies | unknown | Backend rejects unknown fields aggressively — add only with live probe |

---

## Headers

| Header | Corbits today | openai/codex (ref) | nanocodex (ref) | Status | Notes |
|---|---|---|---|---|---|
| `content-type` | `application/json` | yes | yes | already_match | |
| `accept` | `text/event-stream` | SSE | SSE or WS | already_match | HTTP SSE path only today |
| `authorization` | bearer sentinel → harness injects token | bearer | bearer | already_match | |
| `openai-beta` | `responses=experimental` | responses experimental | similar | already_match | |
| `originator` | `codex_cli_rs` (from authorize extras) | codex_cli_rs | may differ | already_match | Match official CLI identity |
| `chatgpt-account-id` | when account present | required for subscription | when available | already_match | From tokens / providerOptions |
| `session_id` | when session id present | session headers | session-ish | already_match | Paired with `prompt_cache_key` |
| WebSocket upgrade / WS protocol headers | none | if WS client | if WS client | unknown | No WS in Corbits (CL-5164 gated) |
| Extra product headers | none | product-specific | lean | unknown | Do not invent without backend proof |

---

## Input item types (Corbits)

| Item type | Corbits | Status |
|---|---|---|
| `message` (user/assistant/system/developer) | yes; product system → leading `developer` bridge | already_match / intentionally_different |
| `function_call` | yes | already_match |
| `function_call_output` | yes | already_match |
| `reasoning` + `encrypted_content` | yes (signature round-trip) | already_match |
| Image parts | yes (`input_image`) | already_match |

Bridge message: wraps Corbits system prompt in branded environment tags and states Codex-CLI-only tools do not exist. This is product-correct, not a parity bug.

---

## Transport

| Capability | Corbits | Status |
|---|---|---|
| HTTP POST + SSE | yes | already_match |
| WebSocket | no | unknown / gated by CL-5167 + CL-5164 |
| `previous_response_id` chaining | no | safe_to_add after measure (CL-5161) |
| Connection warmup | no | unknown (CL-5172) |

---

## Recommended follow-ups (do not implement in CL-5168)

1. **Measure first** — PerfTrace attribution (sibling project) before transport bets  
2. **Body key snapshot tests** — lock allowlist so Chat Completions fields cannot leak  
3. **`parallel_tool_calls: true` live spike** — only with tool-runtime safety review  
4. **`previous_response_id` / WS / warmup** — only if CL-5167 shows transport share is material  

---

## Field count

- Body rows: 17  
- Header rows: 9  
- Input item rows: 5  
- Transport rows: 4  

**Production code changed in this issue:** none.
