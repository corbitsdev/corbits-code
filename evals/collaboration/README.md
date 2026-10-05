# Collaboration eval baseline (CL-9879)

Interactive-collaboration checks for the **product** agent path, scored from
outside: tool-call steps and reply text an observer can see — never model
internals. Measurement lane only: nothing here changes product prompts or
runtime.

## What this measures

Whether an agent, mid-run, handles the nine collaboration situations below
the way the scenario intends (verify instead of trusting, follow a steer,
re-read a changed file, yield to the operator, ...). Each scenario carries
frozen **paired controls**: a good transcript that must pass every expected
action, and a bad transcript that must fail (covering `badMisses`).

## The nine scenarios

| Scenario id                     | Kind                     | The behavior under test                                    |
| ------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `collab-misleading-summary`     | `misleading-summary`     | Read the source instead of trusting a teammate summary     |
| `collab-buried-required-action` | `buried-required-action` | Run the required step buried in a long report              |
| `collab-conflicting-reports`    | `conflicting-reports`    | Resolve disagreeing reports via the source file            |
| `collab-failed-checks`          | `failed-checks`          | Report failing checks honestly instead of claiming green   |
| `collab-report-overflow`        | `report-overflow`        | Answer from an over-long report without tool thrash        |
| `collab-midflight-steering`     | `midflight-steering`     | Follow an operator steer to a new file mid-run             |
| `collab-mailbox-yield`          | `mailbox-yield`          | Yield to an operator question instead of acting            |
| `collab-changed-file-reread`    | `changed-file-reread`    | Re-read (with narrowed bounds) a file that changed mid-run |
| `collab-direct-question`        | `direct-question`        | Answer a direct operator question without tools            |

Expected-action kinds: `toolCall`, `replyIncludes`, `replyExcludes`,
`noTools`, `maxRepeats`, `rereadAfterChange`, `narrowedReread`,
`readAfterOperator`. See `lib.ts` (`scoreTranscript`) for exact semantics.

## Deterministic lane (what runs in CI)

```sh
bun scripts/eval-collaboration.ts --repeats 2 --out evals/collaboration/baseline-<YYYY-MM-DD>.json
```

The runner replays the frozen good/bad transcripts through the scorer and
writes a `CollaborationReport` (see `lib.ts`). Repeats replay the same
exemplars, so they pin the scorer — not model variance. The runner refuses
to record a baseline whose paired controls mismatch (non-zero exit):
a scorer that cannot tell good from bad measures nothing.

`bun test ./evals/collaboration` asserts the same properties directly:
every good transcript passes, every bad transcript fails for its intended
reasons, single mutations flip good to fail, the empty transcript passes
nothing, and the deterministic report reaches sensitivity 1.0.

## Tracked report fields

Per trial: scenario, kind, repeat, arm (`good`/`bad`), pass/fail, whether
the control behaved as intended, and failing action ids with reasons.
Totals: trial count, controls ok/failed, and **sensitivity** (fraction of
paired trials behaving as intended).

Metrics with no deterministic value are reported **unknown, never zero**:
`tokenUsage`, `livePassRate`, `agentDurationMs`, `cost`, `turnsUsed`.
`live.status` is `not-run` until a live run records them.

## Live-model protocol (separate, authorized runs only)

Live trials need an authorized inference run and are recorded separately —
never by editing scripted transcripts into passing. A live run records the
same `CollabTrial` shape with the observed (not scripted) transcript verdict
plus the real provider, model, effort, and the unknown metrics above filled
in. `bun scripts/eval-collaboration.ts --live` refuses with this guidance
instead of laundering scripted results as live data.

## Conventions

The scenario set is frozen (`version: 1`, fixtures
`collab-fixtures-v1`). Re-measures reuse `scenarios.json` as-is so runs
stay comparable. Never edit `scenarios.json` or a recorded baseline to hit
a target number; a scenario-set change needs a version bump plus a new
baseline file. Passing scripted controls says the scorer discriminates —
it says nothing about live model quality, and must never be claimed as a
product improvement.
