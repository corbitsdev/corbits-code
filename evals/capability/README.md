# Capability eval suite

Local, multi-model capability checks against the **product** agent path (`corbits exec`), not the scripted integration harness.

**Inspired by** patterns from [SWE-bench](https://www.swebench.com/) (issue → patch → tests), [Terminal-Bench](https://www.tbench.ai/) (agent shell workflows), and [LiveCodeBench](https://livecodebench.github.io/) (coding task suites). This suite uses small hermetic fixtures and `verify.sh` graders; it does **not** run those external harnesses.

## What this measures

Whether a real model + our directors/tools can complete small coding tasks on fixture repos. Graders are objective shell scripts (`verify.sh`) — pass/fail, not LLM-as-judge.

Eval workdirs are initialized as git repositories (HEAD exists) so isolated workers and git-aware skills have a baseline.

One run can **try different things**: multiple cases × multiple provider/model variants (matrix), with every product-path metric we can record written into the results JSON.

## The suite is four cases, one per difficulty tier

| Tier    | Case         | Fixture                     | Turns | Target pass rate | What only this case can tell you                                                                                                                                      |
| ------- | ------------ | --------------------------- | ----- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `easy`  | `tier-easy`  | `tests/fixtures/tier-easy`  | 15    | ~100%            | Floor tripwire: the product path still works at all. Saturation here is _intentional_.                                                                                |
| `med`   | `tier-med`   | `tests/fixtures/tier-med`   | 25    | 70–90%           | Authority resolution: three decoys (a doc, a config, an unused module) disagree with the tests. Only fixing the _imported_ source counts.                             |
| `hard`  | `tier-hard`  | `tests/fixtures/tier-hard`  | 30    | 30–60%           | The crash surfaces in the wrong module next to a decoy TODO; the cause is one hop away. Masking the crash site goes green and fails held-out assertions.              |
| `xhard` | `tier-xhard` | `tests/fixtures/tier-xhard` | 40    | 0–25%            | The functional suite is **already green**. Grades production shape — versioned migrations, multi-worker-safe claiming, dead-letter inspection, no in-process polling. |

### Why four and not nineteen

The previous 19-case suite scored **92/95** on the last full matrix, with all
three failures on a single case. Suite v1's 14 cases were **14/14 on every
model**. It cost ~500 turns per model per run and carried almost no
information: a suite nothing fails cannot tell you whether a change helped.

**Standing rule: a case that saturates its target band gets promoted in
difficulty or retired — never kept as-is.** Without that rule the suite decays
back into a wall of passing tests. See CL-6963.

### Bait behavior is asserted, not given its own case

Tool-discipline baits (shell editing, env prefixes, curl instead of
`web_fetch`, search loops, skipped dispatch) used to be separate cases. They
validate _behavior_, not capability, so they now ride on the tier cases as
`requireBehaviors` bounds — the same mechanism that lets a case demand
`spawnAgentToolCallCount >= 1`:

```json
"requireBehaviors": [
  { "metric": "editViaShellCount", "max": 0 },
  { "metric": "repeatedSearchCount", "max": 6 }
]
```

One fixture can carry several at once, which beats paying a whole case for
each. `bait: { metric, threshold }` still exists for cases that exist purely to
reproduce a known misbehavior: the case misbehaves when the aggregate
**median** of that metric exceeds the threshold, and during `--baseline`
comparison a bait whose baseline no longer exceeds its threshold is flagged
(`BAIT FLAG ... no longer reproduces its misbehavior`) rather than silently
passing.

### Graders are deterministic and cheat-resistant

No LLM judging. Every tier's `verify.sh` is shell plus `bun`, and each one was
validated against both a correct fix and the obvious cheats before landing:

- Contract test files are pinned by **sha256** — editing expectations fails.
- `tier-med` rejects rewiring the import to the decoy module, and rejects
  hardcoded totals.
- `tier-hard` runs **held-out assertions** the agent never sees, so `?? 0`
  around the crash site is caught.
- `tier-xhard` fails its rubric on the starting fixture _even though the
  visible suite passes_.

## Tracked metrics (per case × variant)

Everything the product path already observes is recorded:

| Field                              | Source                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `passed`                           | agent exit 0 **and** verify.sh exit 0 **and** not over soft turn budget           |
| `agentExitCode` / `verifyExitCode` | process exits                                                                     |
| `status`                           | run sink (`done` / `failed` / `cancelled`)                                        |
| `sessionId`                        | exec session id                                                                   |
| `durationMs`                       | wall clock for the whole case                                                     |
| `agentDurationMs`                  | product `runExec` duration                                                        |
| `verifyDurationMs`                 | grader wall time                                                                  |
| `turnsUsed`                        | turn collector                                                                    |
| `toolCallCount`                    | turn collector                                                                    |
| `tokenUsage`                       | `{ input, output, cacheRead, cacheWrite, thinking }`                              |
| `provider` / `model` / `variantId` | resolved config for that cell (`variantId` is `provider:model` by default)        |
| `skipPermissions`                  | whether permissions were skipped                                                  |
| `repeat`                           | 0-based repeat index within the case×variant cell                                 |
| `behaviors`                        | behavior metrics derived from the turn stream (below); `null` when capture failed |
| `textPreview`                      | truncated agent stdout (debug)                                                    |

Run-level `totals` sum duration, turns, tools, and tokens across cells.

## Behavior metrics (`behaviors` block)

The runner installs a post-run lifecycle hook in each fixture workdir
(`.corbits/hooks/eval-run-capture.sh`) so the product path hands back the full
turn stream — tool calls with arguments plus assistant content. Derivation is
pure (`behaviors.ts`); command analysis is a quote-aware token scan, not a full
shell parser.

| Metric                       | Meaning                                                                     | Baseline direction |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------ |
| `shellCommandCount`          | `run_shell` calls                                                           | informational      |
| `envAssignmentCommandCount`  | commands with a `FOO=bar cmd` prefix or `export`                            | lower is better    |
| `chainSegmentCount`          | total chain segments (`&&`, `\|\|`, `;`, `\|`, newline)                     | informational      |
| `maxChainSegmentsPerCommand` | largest chain in one command                                                | lower is better    |
| `networkCommandCount`        | segments invoking curl/wget/nc/...                                          | lower is better    |
| `webFetchToolCallCount`      | `web_fetch` tool calls (0 when the tool is absent or unused)                | informational      |
| `spawnAgentToolCallCount`    | `spawn_agent` tool calls (0 when the tool is absent or unused)              | informational      |
| `editViaShellCount`          | sed/perl/awk `-i` edits or heredoc writes                                   | lower is better    |
| `repeatedSearchCount`        | tool calls repeating an earlier call's name with normalized-equal arguments | lower is better    |
| `longestToolOnlyStreak`      | longest run of assistant turns with tool calls and no text                  | lower is better    |
| `maxTurnDurationMs`          | slowest single turn (stall gap on slow commands)                            | lower is better    |
| `toolCallsByName`            | per-tool-name call counts                                                   | informational      |

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

# Faster live matrix (independent cells; default is serial)
bun run eval:capability -- --provider <name> --model <id> --concurrency 4

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

# Overlay a closed-fleet director on the product exec path (eval/CI override,
# not single-agent mode). Omit / skywalker keep the default Skywalker session.
bun run eval:capability -- --provider <name> --model <id> --director build
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

| Flag                                 | Meaning                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--case <id\|all>`                   | Case id or `all` (default)                                                                                                                                                                                                                                                          |
| `--provider <name>` / `--model <id>` | Required unless `--matrix`. Single-variant via `loadConfig`. Not inferred from local settings                                                                                                                                                                                       |
| `--matrix <cells>`                   | Alternative to `--provider`/`--model`. Multi-variant: `p:m,p2:m2` or `label=p:m` (comma-separated). Every cell must include both sides                                                                                                                                              |
| `--config <path>`                    | Settings file override (CI injection)                                                                                                                                                                                                                                               |
| `--out <path>`                       | Write machine-readable results JSON                                                                                                                                                                                                                                                 |
| `--baseline <path>`                  | Compare this run to a prior results file (improve/regress + metric deltas)                                                                                                                                                                                                          |
| `--ask-permissions`                  | Do **not** pass `--dangerously-skip-permissions`                                                                                                                                                                                                                                    |
| `--agent-timeout-ms <n>`             | Wall-clock limit for `runExec` (default `1200000`, env `CORBITS_EVAL_AGENT_TIMEOUT_MS`)                                                                                                                                                                                             |
| `--verify-timeout-ms <n>`            | Wall-clock limit for `verify.sh` (default `120000`, env `CORBITS_EVAL_VERIFY_TIMEOUT_MS`)                                                                                                                                                                                           |
| `--repeats <n>`                      | Runs per case×variant cell (default `1`; gate runs use `5`, baseline freezes `3`). Results record every repeat plus per-cell aggregates                                                                                                                                             |
| `--concurrency <n>`                  | Independent case×variant×repeat cells in parallel (default `1`, env `CORBITS_EVAL_CONCURRENCY`). Each cell still uses its own temp workdir. Use `--concurrency 4` (or similar) to run a live matrix faster                                                                          |
| `--dry-run`                          | Load cases × variants and print plan; no inference. Still requires `--provider`/`--model` or `--matrix`                                                                                                                                                                             |
| `--director <id>`                    | Exec overlay: run the product `corbits exec` path with this director's system prompt and initially-advertised tool set (default: skywalker). Eval/CI override, not single-agent mode. Directors that cannot spawn (for example `build`) do not mount `spawn_agent` / `wait_agents`. |

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
      "tokenUsage": {
        "input": 5000,
        "output": 800,
        "cacheRead": 0,
        "cacheWrite": 0,
        "thinking": 0
      },
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
        "spawnAgentToolCallCount": 0,
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
