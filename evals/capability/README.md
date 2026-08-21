# Capability eval suite

Local, multi-model capability checks against the **product** agent path (`corbits exec`), not the scripted integration harness.

**Inspired by** patterns from [SWE-bench](https://www.swebench.com/) (issue → patch → tests), [Terminal-Bench](https://www.tbench.ai/) (agent shell workflows), and [LiveCodeBench](https://livecodebench.github.io/) (coding task suites). This suite uses small hermetic fixtures and `verify.sh` graders; it does **not** run those external harnesses.

## What this measures

Whether a real model + our directors/tools can complete small coding tasks on fixture repos. Graders are objective shell scripts (`verify.sh`) — pass/fail, not LLM-as-judge.

One run can **try different things**: multiple cases × multiple provider/model variants (matrix), with every product-path metric we can record written into the results JSON.

| Tier | Case | Fixture | Intent |
|------|------|---------|--------|
| simple | `simple-health` | `tests/fixtures/multi-file-service` | Single-file route + test |
| complex | `complex-jwt` | `tests/fixtures/demo-comparison` | Multi-file auth middleware + tests (sync API contract) |
| complex | `complex-stock-gate` | `tests/fixtures/demo-comparison` | Multi-file stock-gated orders + mutable state |
| complex | `complex-idempotent-orders` | `tests/fixtures/demo-comparison` | Idempotency-Key header + multi-file order store |
| complex | `complex-bugfix` | `tests/fixtures/buggy-service` | Issue→patch→tests: fix failing post GET without breaking users |
| complex | `complex-pagination` | `tests/fixtures/demo-comparison` | Multi-file feature: query pagination on GET /products |
| complex | `complex-rename-user` | `tests/fixtures/multi-file-service` | Refactor/rename user `name` → `displayName` across files |
| complex | `complex-dispatch-spawn` | `tests/fixtures/multi-file-service` | Dispatch GET /readyz via `task`; grader checks the route, not that the primary skipped DIY |
| complex | `complex-recall-after-bulk-read` | `tests/fixtures/large-read` | Read many fixture files then write the planted token; does not assert compaction fired |

| bait | `loop-bait` | `tests/fixtures/large-read` | Open-ended research; catches repeated-search loops |
| bait | `web-bait` | `tests/fixtures/web-note` | Fetch from a hermetic local HTTP page; catches curl/wget instead of `web_fetch` |
| bait | `env-bait` | `tests/fixtures/env-config-build` | Build configured via file; catches `FOO=bar cmd` env prefixes |
| bait | `edit-bait` | `tests/fixtures/multiline-edit` | Multi-line source edit; catches sed/heredoc editing |
| bait | `subagent-bait` | `tests/fixtures/slow-command` | Subagent must wait on a ~20s command; catches stall gaps |

Bait cases exist to **reproduce known misbehaviors** so behavior changes can be
confirmed against them. Each declares the behavior metric it baits in
`case.json` (`bait: { metric, threshold }`): the case misbehaves when the
aggregate **median** of that metric exceeds the threshold. The grader stays an
objective outcome check — a bait can pass verify while still misbehaving; the
`behaviors` block is what the gate compares.

**Bait honesty check:** during `--baseline` comparison, a bait case whose
*baseline* aggregate does not exceed its threshold is flagged
(`BAIT FLAG ... no longer reproduces its misbehavior`) instead of silently
passing. A flagged bait means the case has stopped measuring anything — fix or
retire the case; do not treat the comparison as a clean gate.

## Tracked metrics (per case × variant)

Everything the product path already observes is recorded:

| Field | Source |
|-------|--------|
| `passed` | agent exit 0 **and** verify.sh exit 0 **and** not over soft turn budget |
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
| `repeat` | 0-based repeat index within the case×variant cell |
| `behaviors` | behavior metrics derived from the turn stream (below); `null` when capture failed |
| `textPreview` | truncated agent stdout (debug) |

Run-level `totals` sum duration, turns, tools, and tokens across cells.

## Behavior metrics (`behaviors` block)

The runner installs a post-run lifecycle hook in each fixture workdir
(`.corbits/hooks/eval-run-capture.sh`) so the product path hands back the full
turn stream — tool calls with arguments plus assistant content. Derivation is
pure (`behaviors.ts`); command analysis is a quote-aware token scan, not a full
shell parser.

| Metric | Meaning | Baseline direction |
|--------|---------|--------------------|
| `shellCommandCount` | `run_shell` calls | informational |
| `envAssignmentCommandCount` | commands with a `FOO=bar cmd` prefix or `export` | lower is better |
| `chainSegmentCount` | total chain segments (`&&`, `\|\|`, `;`, `\|`, newline) | informational |
| `maxChainSegmentsPerCommand` | largest chain in one command | lower is better |
| `networkCommandCount` | segments invoking curl/wget/nc/... | lower is better |
| `webFetchToolCallCount` | `web_fetch` tool calls (0 when the tool is absent or unused) | informational |
| `taskToolCallCount` | `task` tool calls (0 when the tool is absent or unused) | informational |
| `editViaShellCount` | sed/perl/awk `-i` edits or heredoc writes | lower is better |
| `repeatedSearchCount` | tool calls repeating an earlier call's name with normalized-equal arguments | lower is better |
| `longestToolOnlyStreak` | longest run of assistant turns with tool calls and no text | lower is better |
| `maxTurnDurationMs` | slowest single turn (stall gap on slow commands) | lower is better |
| `toolCallsByName` | per-tool-name call counts | informational |

## Prerequisites

- A configured provider matching the CLI `--provider` / `--model` (or `--matrix` cells)
- Network access for inference
- Bun

Evals default to `--dangerously-skip-permissions` so the agent can write without a human at the gate. Override with `--ask-permissions` if you want the non-interactive deny path.

## Provider/model

CLI `--provider <name>` and `--model <id>` are required for every run, including `--dry-run`. Alternatively, pass `--matrix` with complete `provider:model` cells. Local `.corbits/settings.json` is never the implicit eval target.

## Run

```bash
# All cases — explicit provider/model required
bun run eval:capability -- --provider <name> --model <id>

# One case, explicit model
bun run eval:capability -- --case simple-health --provider xai --model grok-4.5

# Multi-model matrix (cases × variants)
bun run eval:capability -- \
  --matrix "xai:grok-4.5,openai:gpt-4.1" \
  --out evals/capability/results/matrix.json

# Labeled variants
bun run eval:capability -- --matrix "fast=xai:grok-4.5,strong=openai:gpt-4.1"

# Baseline improve/regress (keys by variantId::caseId)
bun run eval:capability -- --provider <name> --model <id> \
  --out evals/capability/results/run2.json \
  --baseline evals/capability/results/run1.json

# Gate run: 5 repeats per cell against the frozen baseline
bun run eval:capability -- --provider <name> --model <id> --repeats 5 \
  --out evals/capability/results/candidate.json \
  --baseline evals/capability/results/baseline-0286.json
```

## Confirmation gate for behavior changes

Any change intended to shift agent behavior (prompts, directors, tools) is
confirmed here, not by anecdote:

1. Run the suite with `--provider` / `--model` (or `--matrix`) and `--repeats 5`
   (repeats smooth model variance; a single run of a bait case proves nothing).
2. Compare against the frozen baseline
   (`evals/capability/results/baseline-0286.json`) with `--baseline`.
3. Read the verdicts: any pass-rate change per cell is significant; behavior
   metrics compare **medians** per the direction table above and report
   improve/regress/neutral per metric.
4. Check for bait flags — a bait that no longer reproduces on baseline
   invalidates its cell (see the honesty check above).

Refreeze the baseline (same command with `--repeats 3 --out .../baseline-0286.json`)
only when a behavior change has been accepted; commit the new artifact with the
change that justifies it.

Flags:

| Flag | Meaning |
|------|---------|
| `--case <id\|all>` | Case id or `all` (default) |
| `--provider <name>` / `--model <id>` | Required unless `--matrix`. Single-variant via `loadConfig`. Not inferred from local settings |
| `--matrix <cells>` | Alternative to `--provider`/`--model`. Multi-variant: `p:m,p2:m2` or `label=p:m` (comma-separated). Every cell must include both sides |
| `--config <path>` | Settings file override (CI injection) |
| `--out <path>` | Write machine-readable results JSON |
| `--baseline <path>` | Compare this run to a prior results file (improve/regress + metric deltas) |
| `--ask-permissions` | Do **not** pass `--dangerously-skip-permissions` |
| `--max-turns <n>` | Soft turn budget: case **fails** if `turnsUsed` exceeds, or if turns are not reported when a budget is set (fail closed). Does not hard-kill mid-run |
| `--agent-timeout-ms <n>` | Wall-clock limit for `runExec` (default `600000`, env `CORBITS_EVAL_AGENT_TIMEOUT_MS`) |
| `--verify-timeout-ms <n>` | Wall-clock limit for `verify.sh` (default `120000`, env `CORBITS_EVAL_VERIFY_TIMEOUT_MS`) |
| `--repeats <n>` | Runs per case×variant cell (default `1`; gate runs use `5`, baseline freezes `3`). Results record every repeat plus per-cell aggregates |
| `--dry-run` | Load cases × variants and print plan; no inference. Still requires `--provider`/`--model` or `--matrix` |

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
- `maxTurns` — optional soft turn budget; when set, the case **fails** if `turnsUsed` exceeds it (`overBudget: true`) **or** if `turnsUsed` was not reported (fail closed so a broken metrics path cannot pass a budgeted case). Not a hard mid-run kill (product path has no turn budget hook yet).
- `verify` — grader filename (default `verify.sh`)
- `bait` — optional `{ metric, threshold }` marking the behavior metric this case reproduces (see the bait table above)
- `httpFixture` — when `true`, the runner starts a hermetic HTTP server on `127.0.0.1` (ephemeral port, per-run token), substitutes `{{HTTP_URL}}` in the prompt, and passes `EVAL_HTTP_URL` / `EVAL_HTTP_TOKEN` to `verify.sh`. The server is stopped when the case run ends — nothing external is contacted
- `requireBehaviors` — optional `[{ metric, min?, max? }]`. After the run, each listed metric must fall in range or the case fails. Missing capture with a non-empty list fails closed

## Results JSON (v3)

```json
{
  "version": 3,
  "startedAt": "...",
  "finishedAt": "...",
  "provider": "...",
  "model": "...",
  "repeats": 5,
  "variants": [{ "id": "xai/grok-4.5", "provider": "xai", "model": "grok-4.5" }],
  "aggregates": [
    {
      "resultKey": "xai/grok-4.5::simple-health",
      "id": "simple-health",
      "variantId": "xai/grok-4.5",
      "repeats": 5,
      "passCount": 5,
      "passRate": 1,
      "behaviorStats": {
        "shellCommandCount": { "min": 2, "median": 3, "max": 5 }
      }
    }
  ],
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
      "error": null,
      "repeat": 0,
      "behaviors": {
        "shellCommandCount": 3,
        "envAssignmentCommandCount": 0,
        "chainSegmentCount": 4,
        "maxChainSegmentsPerCommand": 2,
        "networkCommandCount": 0,
        "webFetchToolCallCount": 0,
        "taskToolCallCount": 0,
        "editViaShellCount": 0,
        "repeatedSearchCount": 0,
        "longestToolOnlyStreak": 2,
        "maxTurnDurationMs": 4200,
        "toolCallsByName": { "run_shell": 3, "read_file": 2 }
      }
    }
  ]
}
```

Every repeat is recorded as its own entry in `cases`; `aggregates` carries the
per-cell pass rate and behavior-metric min/median/max. On parse, aggregates are
always recomputed from `cases`, so a hand-edited aggregate cannot drift.

Result files under `evals/capability/results/` are gitignored, with one
exception: the frozen gate baseline `baseline-0286.json` is committed and only
refreshed deliberately (see the gate section).

Baseline compare works on aggregates per `variantId::caseId`: pass-rate deltas
(`improved` / `regressed` / `unchanged` / `new` — any change is significant),
behavior-metric median verdicts, and bait honesty flags. The run exits non-zero
if any cell's pass rate regressed.

## Non-goals

- Replacing `tests/integration` (fake/scripted models)
- TUI layout checks
- Subjective quality rubrics without an objective verify script
