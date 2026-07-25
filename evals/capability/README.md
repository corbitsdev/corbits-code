# Capability eval suite

Local, multi-model capability checks against the **product** agent path (`corbits exec`), not the scripted integration harness.

## What this measures

Whether a real model + our directors/tools can complete small coding tasks on fixture repos. Graders are objective shell scripts (`verify.sh`) — pass/fail, not LLM-as-judge.

| Tier | Case | Fixture | Intent |
|------|------|---------|--------|
| simple | `simple-health` | `tests/fixtures/multi-file-service` | Single-file route + test |
| complex | `complex-jwt` | `tests/fixtures/demo-comparison` | Multi-file auth middleware + tests |

## Prerequisites

- Configured provider (same as interactive `corbits`)
- Network access for inference
- Bun

Evals default to `--dangerously-skip-permissions` so the agent can write without a human at the gate. Override with `--ask-permissions` if you want the non-interactive deny path.

## Run

```bash
# All cases with the configured default provider/model
bun run eval:capability

# One case, explicit model
bun run eval:capability -- --case simple-health --provider firepass --model fp-small

# Write results JSON and compare to a previous baseline
bun run eval:capability -- --out evals/capability/results/run.json
bun run eval:capability -- --out evals/capability/results/run2.json \
  --baseline evals/capability/results/run.json
```

Flags:

| Flag | Meaning |
|------|---------|
| `--case <id\|all>` | Case id or `all` (default) |
| `--provider` / `--model` | Passed through to `loadConfig` |
| `--config <path>` | Settings file override (CI injection) |
| `--out <path>` | Write machine-readable results JSON |
| `--baseline <path>` | Compare this run to a prior results file (improve/regress) |
| `--ask-permissions` | Do **not** pass `--dangerously-skip-permissions` |
| `--max-turns <n>` | Override case `maxTurns` |
| `--dry-run` | Load cases and print plan; no inference |

## Case format

Each case is a directory under `evals/capability/cases/<id>/`:

```
case.json   # metadata + prompt
verify.sh   # objective grader (exit 0 = pass)
```

`case.json` fields:

- `id` — stable id (matches directory name)
- `tier` — `simple` \| `complex`
- `title` — human label
- `fixture` — path relative to repo root (copied into a temp workdir)
- `prompt` — task text for `corbits exec`
- `maxTurns` — optional turn budget
- `verify` — grader filename (default `verify.sh`)

## Results JSON

```json
{
  "version": 1,
  "startedAt": "...",
  "finishedAt": "...",
  "provider": "...",
  "model": "...",
  "cases": [
    {
      "id": "simple-health",
      "tier": "simple",
      "passed": true,
      "agentExitCode": 0,
      "verifyExitCode": 0,
      "durationMs": 12345,
      "error": null
    }
  ]
}
```

Baseline compare prints `improved` / `regressed` / `unchanged` per case and exits non-zero if any case regressed.

## Non-goals

- Replacing `tests/integration` (fake/scripted models)
- TUI layout checks
- Subjective quality rubrics without an objective verify script
