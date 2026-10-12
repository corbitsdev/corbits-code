# Dispatch routing eval (first `@corbits/evals` eval)

First eval wired through the published [`@corbits/evals`](https://github.com/corbitsdev/corbits-evals#readme)
package (CL-10452). It exercises the **real dispatch director system prompt**
(`agents/dispatch/src/prompt.ts`, exported by `@corbits/code-agent-dispatch`)
against **brand-new routing requests**: each case is a user request that the
dispatch director must route to one specialist.

## Run

```sh
bun scripts/eval-prompts-dispatch.ts
# or
bun run eval:prompts-dispatch
```

The run calls a model through local Ollama by default (matching the package's
own examples). Override with env:

```sh
EVAL_MODEL=tev1:0.8b bun scripts/eval-prompts-dispatch.ts
EVAL_OLLAMA_URL=http://localhost:11434 EVAL_MODEL=qwen3:0.6b bun scripts/eval-prompts-dispatch.ts
```

## What it measures

The run composes the dispatch card **verbatim** + the case request + a fixed
reply-format stanza (harness glue so the routing decision is measurable), then
asks the model which specialist it would spawn. Checks:

| Check    | Helper     | Passes when                                        |
| -------- | ---------- | -------------------------------------------------- |
| `routes` | `mentions` | the reply names the expected specialist            |
| `noDiy`  | `avoids`   | the reply does not volunteer to do the work itself |
| `fast`   | `under`    | the run finishes within 120s                       |

## Cases

`cases.jsonl` — 9 brand-new routing prompts. Each case:

```json
{
  "name": "map-retry-backoff",
  "input": "Where does the repo handle retry backoff? Find every call site and sketch the flow between them.",
  "expect": { "route": "explorer", "decoys": ["coder", "planner"] }
}
```

`expect.route` is the correct specialist; `expect.decoys` lists the likely
wrong picks for humans scanning the report.

## Gates

Per check, `allow` in `scripts/eval-prompts-dispatch.ts`:

- `routes: { miss: 6, drop: 0 }` — the gate trips only when fewer than 3 of 9
  cases route correctly. Calibrated to the local smoke model (`qwen3:0.6b`,
  observed 3/9); **tighten when running a capable model** (e.g. `miss: 1`).
- `noDiy: { miss: 2 }`
- `fast: 0`

`compare` + `save` point at `last.json`: each run compares drops against the
previous stored run, then replaces it. Until a capable-model baseline is
stored, drops are not gated.

## Integration notes

- `@corbits/evals@0.1.1` is a devDependency (LGPL-2.1-only — see the PR body).
- The package's `evaluate()` is the whole harness: run, cases, checks, and
  per-check miss/drop allowances in one call. It rejects with `EvalFailure`
  when a check breaks its allowance; `.report.markdown()` prints the summary.
- Jev (LLM-as-judge string/`ask` checks) needs the `@corbits/system-one`
  gateway; this eval uses code checks only so it runs offline.
- Trajectory scoring (`ranSteps` / `@corbits/evals/workflow`) is the
  CL-10452 follow-up: this first eval uses a plain function run.
