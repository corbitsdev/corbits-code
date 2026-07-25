# Capability eval suite

Local, multi-model capability checks against the **product** agent path (`corbits exec`), not the scripted integration harness.

## What this measures

Whether a real model + our directors/tools can complete small coding tasks on fixture repos. Graders are objective shell scripts (`verify.sh`) — pass/fail, not LLM-as-judge.

One run can **try different things**: multiple cases × multiple provider/model variants (matrix), with every product-path metric we can record written into the results JSON.

| Tier | Case | Fixture | Intent |
|------|------|---------|--------|
| simple | `simple-health` | `tests/fixtures/multi-file-service` | Single-file route + test |
| complex | `complex-jwt` | `tests/fixtures/demo-comparison` | Multi-file auth middleware + tests |

## Tracked metrics (per case × variant)

Everything the product path already observes is recorded:

| Field | Source |
|-------|--------|
| `passed` | agent exit 0 **and** verify.sh exit 0 |
| `agentExitCode` / `verifyExitCode` | process exits |
| `status` | run sink (`done` / `failed` / `cancelled`) |
| `sessionId` | exec session id |
| `durationMs` | wall clock for the whole case |
| `agentDurationMs` | product `runExec` duration |
| `verifyDurationMs` | grader wall time |
| `turnsUsed` | turn collector |
| `toolCallCount` | turn collector |
| `tokenUsage` | `{ input, output, cacheRead, cacheWrite, thinking }` |
| `maxTurns` / `overBudget` | case budget vs turns used |
| `provider` / `model` / `variantId` | resolved config for that cell (`variantId` is `provider:model` by default) |
| `skipPermissions` | whether permissions were skipped |
| `textPreview` | truncated agent stdout (debug) |

Run-level `totals` sum duration, turns, tools, and tokens across cells.

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
bun run eval:capability -- --case simple-health --provider xai/thegreataxios --model grok-4.5

# Multi-model matrix (cases × variants)
bun run eval:capability -- \
  --matrix "xai/thegreataxios:grok-4.5,openai:gpt-4.1" \
  --out evals/capability/results/matrix.json

# Labeled variants
bun run eval:capability -- --matrix "fast=xai:grok-4.5,strong=openai:gpt-4.1"

# Baseline improve/regress (keys by variantId::caseId)
bun run eval:capability -- --out evals/capability/results/run2.json \
  --baseline evals/capability/results/run1.json
```

Flags:

| Flag | Meaning |
|------|---------|
| `--case <id\|all>` | Case id or `all` (default) |
| `--provider` / `--model` | Single-variant override via `loadConfig` |
| `--matrix <cells>` | Multi-variant: `p:m,p2:m2` or `label=p:m` (comma-separated) |
| `--config <path>` | Settings file override (CI injection) |
| `--out <path>` | Write machine-readable results JSON |
| `--baseline <path>` | Compare this run to a prior results file (improve/regress + metric deltas) |
| `--ask-permissions` | Do **not** pass `--dangerously-skip-permissions` |
| `--max-turns <n>` | Override case `maxTurns` |
| `--dry-run` | Load cases × variants and print plan; no inference |

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
- `maxTurns` — optional turn budget (recorded; over-budget flagged)
- `verify` — grader filename (default `verify.sh`)

## Results JSON (v2)

```json
{
  "version": 2,
  "startedAt": "...",
  "finishedAt": "...",
  "provider": "...",
  "model": "...",
  "variants": [{ "id": "xai/grok-4.5", "provider": "xai", "model": "grok-4.5" }],
  "totals": {
    "total": 2,
    "passed": 2,
    "failed": 0,
    "durationMs": 60000,
    "turnsUsed": 12,
    "toolCallCount": 20,
    "tokenUsage": { "input": 10000, "output": 2000, "cacheRead": 0, "cacheWrite": 0, "thinking": 0 }
  },
  "cases": [
    {
      "resultKey": "xai/grok-4.5::simple-health",
      "id": "simple-health",
      "variantId": "xai/grok-4.5",
      "provider": "xai",
      "model": "grok-4.5",
      "passed": true,
      "agentExitCode": 0,
      "verifyExitCode": 0,
      "durationMs": 18000,
      "agentDurationMs": 17500,
      "verifyDurationMs": 200,
      "status": "done",
      "sessionId": "...",
      "turnsUsed": 4,
      "toolCallCount": 6,
      "tokenUsage": { "input": 5000, "output": 800, "cacheRead": 0, "cacheWrite": 0, "thinking": 0 },
      "maxTurns": 20,
      "overBudget": false,
      "skipPermissions": true,
      "error": null
    }
  ]
}
```

Result files under `evals/capability/results/` are gitignored — do not commit them.

Baseline compare prints `improved` / `regressed` / `unchanged` per `variantId::caseId`, optional duration/turn/token deltas, and exits non-zero if any cell regressed.

## Non-goals

- Replacing `tests/integration` (fake/scripted models)
- TUI layout checks
- Subjective quality rubrics without an objective verify script
