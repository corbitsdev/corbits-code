# Public benchmark smokes

Local capability evals (`evals/capability`) stay the daily product gate.

This directory is for **small public-bench smokes** so we can see how Corbits
stacks up against other coding harnesses (Claude Code, OpenHands, Aider, …)
without vendoring a full leaderboard runner into product CI.

## Constraints

- Provider and model are caller-supplied (`--provider` and `--model`).
- Docker Desktop may be under-provisioned for full SWE-bench eval images
  (docs want ~120GB disk / 16GB RAM; arm64 is experimental).
- Start with **one instance**, not Lite/Verified full.

## One-shot SWE-bench Lite

```bash
# Dry plan (loads HF row, prints prompt)
bun scripts/eval-public-swe-one.ts --dry-run --provider <name> --model <id>

# Default instance: psf__requests-3362 (small repo, single failing test)
bun scripts/eval-public-swe-one.ts \
  --provider xai \
  --model grok-4.5

# Pick any Lite instance_id
bun scripts/eval-public-swe-one.ts --instance pallets__flask-4992 \
  --provider <provider> --model <model>
```

What it does:

1. Loads the instance from HuggingFace (`princeton-nlp/SWE-bench_Lite` test).
2. Clones the GitHub repo at `base_commit` into a temp workdir.
3. Runs **Corbits product exec** (`loadConfig` + `runExec`) with the issue text.
4. Writes under `evals/public/results/<instance>-<timestamp>/`:
   - `instance.json`, `prompt.txt`
   - `prediction.patch`, `preds.json`, `preds.jsonl`
   - `report.json` (turns, tools, duration, patch size)

What it does **not** do yet:

- Official Docker `resolved` / `not resolved` grading (optional `--evaluate` only
  writes a manual checklist; full harness is separate and heavy).

## Scoring later

Point the official SWE-bench / mini-SWE-agent eval harness at `preds.jsonl`.
Until that runs, treat the smoke as: **did Corbits produce a non-empty patch on a
real public issue?**

## vs competitors

| Claim                            | Fair?                                                     |
| -------------------------------- | --------------------------------------------------------- |
| Corbits@Grok patch on instance X | Yes (this smoke)                                          |
| % resolved on SWE-bench Lite     | Only after official Docker eval on a frozen instance list |
| vs Claude Code on TB2            | Harbor adapter (not this script)                          |

## Related

- Product gates: `evals/capability/`
