---
name: corbits-system-one
description: Use @corbits/system-one for fast typed decisions (choice, score, yes/no) over a JSON state. Load when adding routing, gating, or triage in front of an agent.
user-invocable: false
---

# Corbits System One

`@corbits/system-one` is a client for TypeSafe's Jev model. It is not a chat model and never generates text. You send a JSON `state` plus questions with unique ids, and you get one validated decision per id.

| Question type       | You supply                                     | Decision comes back as                            |
| ------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `choice`            | `criteria`: option name to description         | `choice`, `probabilities`, `confidence`           |
| `score`             | `criteria`: 2 to 10 ordered level descriptions | `score`, `legend`, `probabilities`                |
| `boolean` or `noul` | optional `criteria: { true?, false? }`         | `noul`: probability 0 to 1 that the answer is yes |

## Use

```ts
import { evaluate } from "@corbits/system-one";

const result = await evaluate({
  state: { action: "drop-database", env: "production", approvals: 0 },
  questions: [
    {
      id: "route",
      type: "choice",
      instructions: "What permission decision does this warrant?",
      criteria: { allow: "Low-risk request", deny: "Refuse the request" },
    },
    {
      id: "escalate",
      type: "boolean",
      instructions: "Must this be escalated for human approval?",
    },
  ],
  config: { timeoutMs: 15_000 },
});
if (result.fallback) return failClosed(result.reason);
const [route, escalate] = result.decisions;
```

- Key: `TYPESAFE_API_KEY` (official endpoint). The `gateway` endpoint uses `AI_GATEWAY_API_KEY`. `SYSTEM_ONE_API_KEY` is an alias on all of them.
- Failures are data. `evaluate` returns `{ fallback: true, reason }` for `no-key`, `timeout`, `network`, `http-error`, or `parse-error`, and throws only on invalid caller input. Branch on `result.fallback` and fail closed for gates.
- The default timeout is 1500 ms. No latency or pricing is published, so measure both yourself using the returned `latencyMs` and `usage`.
- One POST carries every question, so ask all your questions for a state in one call.
- `exactOptionalPropertyTypes` is on: omit optional keys instead of passing `undefined`.

## As an Interchange adapter

Register `createSystemOneAdapter()` under `SYSTEM_ONE_PROVIDER`. Pass questions per call with `inferenceOptions.providerOptions.systemOne = { state?, questions? }`. The adapter emits one `inference.text.delta` per decision (the token is decision JSON). A malformed body on this path is a `ProtocolMismatchError`, not a fallback.

## Local Ollama shim (CL-9925)

`createOllamaSystemOneEvaluator({ rootURL, model, fetchFn? })` in
`src/tools/decide-ollama.ts` is the local-SystemOne evaluator seam the decide
tool accepts as its `evaluate` dep. It POSTs `{ model, state, questions }` to
`{rootURL}/v1/systemone` and maps timeout, non-2xx, refused, and invalid
answers to `fallback: true`. Do not route this through the chat adapter or
`/api/chat` and `/api/generate`: the local clef-flash model rejects both.
The TYPESAFE endpoint stays the decide default; never mix backends in one
call. Sibling note: `@corbits/ollama-adapter` (not a dependency of this repo)
is chat-only and unrelated to this SystemOne path.

## Good uses

- A permission or escalation gate before a risky tool call (from the package's own examples).
- Routing or classifying a request before an agent runs, for example a `choice` between a cheap model, a strong model, and a specialist. Use `probabilities` to fall back to a default when confidence is low. This is an inference from the API shape, not a documented feature.
- Structured triage: intent, risk, and needs-human in one round trip.

Do not use it for generation, summaries, or tool-calling loops.

## Need more

- Upstream README in corbitsdev/corbits-system-one and the wire contract at https://docs.typesafe.ai.
- Chat inference providers: `use_skill corbits-inference`.
- Catalog: `use_skill corbits`.
