# Agent Eval Harness

An internal measurement tool — not a product feature. It scores headless agent
runs so prompt, model, and provider changes are **measured, not guessed**. It is
the prerequisite for the system-prompt overhaul (CL-1220), whose acceptance
depends on a measured improvement here.

## Tasks

Each eval task is a self-contained folder under `eval/tasks/<name>/`:

- `repo/` — the starting-state project the agent works on.
- `prompt.txt` — the instruction given to the agent.
- `verify.sh` — the objective grader. Exit `0` = success (typically the task's
  own test suite). The harness copies the whole task folder to a temp dir before
  the run, so `verify.sh` grades the agent-modified copy, not the original.

The harness code lives in `eval/lib/` (kept out of `src/` so it is never part of
the app build); the runner is `scripts/eval.ts`.

Current tasks span distinct types:

| Task | Type |
|---|---|
| `targeted-edit` | single-file fix |
| `multi-file-feature` | add a function across files |
| `bug-fix-repro` | bug fix driven by a reproduction test |
| `multi-step-feature` | implement a helper and wire it into a caller |
| `refactor-rename` | rename a function and update all its callers |

Add more by dropping in another `repo/ + prompt.txt + verify.sh` folder.

Note: an ambiguous/underspecified task that should trigger `ask_operator` is
intentionally **not** included yet — in headless mode `ask_operator` blocks on
stdin with no operator present, which would hang the run. It needs a
non-blocking headless `ask_operator` first.

## Variants

A variant is `{ prompt, provider, model }`, not just a prompt. Provider/model are
injected per run via the CL-927 `--config <path>` flag — each variant points at
its own settings file — so the same harness A/Bs across prompt, model, and
provider with no new machinery.

## Running

```bash
bun run eval --a <settingsA.json> --b <settingsB.json> [--tasks t1,t2] [--runs N] \
  [--judge <settings.json> [--judge-provider <name>] [--judge-model <id>]] [--flat-fee]
```

- `--a` / `--b` — CL-927 settings files defining each variant's provider/model.
- `--provider-a` / `--model-a` (and `-b`) — optional selection within a settings file.
- `--tasks` — comma-separated subset (default: all).
- `--runs` — runs per task; results are collapsed by median to absorb LLM
  run-to-run variance (default 1).
- `--judge` — settings file for the **LLM judge** (same secure `--config`
  format); `--judge-provider`/`--judge-model` select within it. Omit to skip
  quality grading.
- `--flat-fee` — the variants' provider bills a flat fee (e.g. Firepass), so
  per-token cost is reported as `flat-fee` rather than `unknown`.

Scored runs need **real provider credentials** in the settings files. See
`variants/example.settings.json` for the format.

## Metrics

Per task/variant: pass/fail (from `verify.sh`), turns, tool calls (count + by
type), token usage, cost, wall-clock, and — when a judge is configured — quality
scores.

- **Pricing:** a model unknown to the pricing source reports `unknown` rather
  than a misleading `$0.00`; `flat-fee` providers report `flat-fee` (per-token
  cost is N/A); supply a `priceOverride` on a variant to score an unpriced
  metered model.
- **LLM judge:** a test-pass is necessary but not sufficient — a quantized model
  can pass tests while writing low-quality code. With `--judge`, the agent's diff
  is scored 1–5 on correctness (beyond the tests), scope/minimalism, code
  quality/style, and an overall "would a senior approve". A failed or absent
  judge reports `-`, never invented scores.
