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

Current tasks span distinct types:

| Task | Type |
|---|---|
| `targeted-edit` | single-file fix |
| `multi-file-feature` | add a function across files |
| `bug-fix-repro` | bug fix driven by a reproduction test |

Add more by dropping in another `repo/ + prompt.txt + verify.sh` folder.

## Variants

A variant is `{ prompt, provider, model }`, not just a prompt. Provider/model are
injected per run via the CL-927 `--config <path>` flag — each variant points at
its own settings file — so the same harness A/Bs across prompt, model, and
provider with no new machinery.

## Running

```bash
bun run eval --a <settingsA.json> --b <settingsB.json> [--tasks t1,t2] [--runs N]
```

- `--a` / `--b` — CL-927 settings files defining each variant's provider/model.
- `--provider-a` / `--model-a` (and `-b`) — optional selection within a settings file.
- `--tasks` — comma-separated subset (default: all).
- `--runs` — runs per task; results are collapsed by median to absorb LLM
  run-to-run variance (default 1).

Scored runs need **real provider credentials** in the settings files. See
`variants/example.settings.json` for the format.

## Metrics

Per task/variant: pass/fail (from `verify.sh`), turns, tool calls (count + by
type), token usage, cost, and wall-clock. **Pricing guard:** a model unknown to
the pricing source reports `unknown` rather than a misleading `$0.00`; supply a
`priceOverride` on the variant to score an unpriced model.
