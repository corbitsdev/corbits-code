# Primary compaction mechanics baseline

This is the frozen, offline component baseline for the primary compaction
replacement. It is **not** a complete TUI/exec, permission-isolation, attachment
security, or live model-quality evaluation. The bounded integration-harness
scope has Greybeard approval; production `src/` remains unchanged.

## Reproduce

```bash
bun test ./evals/compaction/metrics.test.ts ./tests/integration/compaction-baseline.test.ts
```

The serial integration test uses the existing `openIntegrationSession`,
`runUntilDone`, and `closeIntegrationSession`. Optional test-only wiring registers
`createSessionPruningCompactor` with `createModelSummarizer`, and supplies the
normal `buildCompactionContinuationMessage()` delivery callback. The actual
primary director, governor, reactor, toolset, and optimized git-backed store run.
No test calls the compactor directly, rewrites history, or uses a substitute
compaction implementation. Existing harness callers remain unchanged.

The harness defaults to `permissiveAuthorize`; this fixture also bypasses tool
permission prompts in its temporary workspace. **It proves no authorization,
approval-resume, or permission-isolation property.** No production permission or
repeat guard is changed. There is no production hook, second host, network
server, or paid provider request.

## Frozen protocol

- Product revision: `6ea596945657f3a0d3af5bfb0277b94af19e1589`, package `0.3.18`.
- Research revision `b92dad53` is not the baseline. No version bump is included.
- Protocol/model script: `primary-component-mechanics-v1` in the integration test.
- External inference: `@intx/inference-testing` `0.3.0`, Anthropic wire format,
  source/model `anthropic:claude-integration` / `claude-integration`.
- Vendored Interchange base: `0205b07b64d03f0fec2e4be3593c764070a9ba8a`, with
  repository-local patches recorded in `docs/VENDORING.md` and the patch ledger.
- Runtime of the captured sample: Bun `1.3.14`, Darwin arm64.
- Production policy: six recent turns; production anchor and no-op rules;
  model summary limit 4,000 characters and deterministic factory limit 2,500.
- Trigger schedule: primary inference calls **19, 31, 43** report **synthetic**
  input 200,000; other explicitly scripted setup/growth calls report synthetic
  input 100 and output 1. Zero cache/thinking fields are synthetic wire fields,
  not measurements. Evidence-response wire frames use harness defaults, not
  measured provider usage. Production thresholds and hysteresis are unchanged.
- Each phase adds ten distinct user/assistant audit-item exchanges, then a
  distinct real `read_file` call. The governor intercepts the post-tool infer and
  resumes through the same agent's contentless inbound channel.
- Time bounds: 30 seconds per send; 120 seconds for the positive fixture.

Git blob identities freeze the uncommitted harness additions without inventing
a commit revision. Recompute with `git hash-object` on these paths:

- `evals/compaction/fixtures.ts`: `67f1fdfb45272464efc62111c1c7525ed067264b`
- `evals/compaction/metrics.ts`: `3cc4efadb5dad1f8078b6db412287b0ab5c25e8f`
- `tests/integration/compaction-baseline.test.ts`: `abed36b077cb16e30bc5015852144bb6bb7fb5b2`
- Original captured-run evaluator: `80a627549e0e009ca7c3079e26875baf3407e8e9`
- `tests/integration/harness.ts`: `4567ac03433b70f1eed4f3238e2a3b5e1f5b4557`

The fixture module deterministically generates the exact input bytes: an early
constraint, a later corrected decision, a failing `bun diagnose.ts` with decisive
output after 250 preamble lines, and an oversized diagnostic with the decisive
value after 1,500 lines. A full read and a targeted middle-line read exercise
real tools. Before growth, the test verifies that all four facts reached
persisted history. Generated workspace files contain no grader expectations.

## Evidence and scoring

The summarizer responder extracts only evidence markers in the **actual excerpt
received from the production summarizer**. It never reads the original fixture
or discarded turns. The primary response matcher selects an answer only when
its exact set of source/value/id triples is present in the actual wire request,
independent of their order. A real-agent reversed-order regression recovers all
four facts without weakening source/value matching.
All 16 subsets include an explicit all-missing response. A separate real-agent
negative test supplies no evidence and verifies that fixture answers do not
appear. These controlled responders measure transport/loss, not model judgment.

`metrics.ts` scores exact source and value, separately from artifact completion.
Its tests reject altered artifacts, wrong sources/answers, absent evidence,
repeated work, requested-only folds, no-ops, and missing continuation. Denominators
remain four required facts per observation; the failed recovery task is retained.

At complete `runUntilDone` boundaries the fixture reads and validates the small
`turns.jsonl` directly, without an in-flight `store.load()` or recovery read. A
qualifying fold requires changed persisted SHA-256 bytes, fewer persisted turns,
an additional production compacted-context marker, a new summarizer invocation,
and primary continuation inference. Requests alone cannot qualify. This proves
persisted replacement in a completed run, not crash atomicity or restart recovery.

The work counters derive from actual tool start/done events. Failed shell calls
include the production `exit code <nonzero>\n` content prefix, even without
`isError`. A regression executes `exit 7` twice through real tools and observes
two failures and one repeated failed attempt. The three fixed
phase-end reads are labelled verification by their frozen call IDs, not by a
model-provided excuse. Other repeated reads/searches, repeated failed attempts,
and duplicated edits are distinct metrics. No search or edit is prescribed here;
zero repetition is not evidence of capable live problem-solving.

## Captured outcome

`results/baseline.json` retains one successful mechanics run, including all three
observations, persisted hashes, phase latencies, and the failed recovery result.

- Mechanics task qualification: **1/1**; persisted folds **3/3**.
- Persisted turn counts: **36 → 8**, **28 → 10**, **30 → 12**.
- Continuation primary calls: **20, 32, 44**.
- Required-fact recovery after each fold: **1/4**; full-recovery tasks **0/1**.
- Only the initial constraint survives. The corrected decision, failed-command
  evidence, and decisive oversized-output fact are lost from the primary reply.
- Three actual summarizer calls; six tool calls; three verification reads;
  zero observed repeated reads/searches, repeated failed attempts, or duplicated edits.
- Captured phase latencies: approximately **757, 796, 801 ms**. They include the
  tool call, folding/persistence, continuation and reply, not compaction alone.
- Positive fixture duration: approximately **12.12 seconds**, including setup and growth.

Primary/summarizer token totals, real cache reads/writes, monetary cost,
compaction-only latency, and live completion quality are **unavailable**, not
zero. Persisted hashes include runtime timestamps and legitimately vary between
runs; the frozen source hashes identify the repeatable protocol.

The test characterizes the observed baseline loss; passing tests do not mean
factual recovery passes. Replacement comparison must reuse these fixture bytes,
trigger schedule, budgets, and exact-source grader. Keep this captured result
unchanged and report improved recovery separately rather than weakening the
grade or excluding the baseline failure.

## Remaining scope

Real TUI/exec host continuity, workflow/controller state, approvals, worker/task
ownership, attachments, concurrent incoming messages, recovery, and finalization
belong to Unit 6 and the Unit 8 cross-surface matrix. Archive exactness and
security belong to Units 2–4. Live quality and spend-approved token/cache/cost
comparison belong to Unit 8. These requirements moved; they were not removed.

## Verification

The focused command above passes (9 tests, 47 assertions with the evaluator
regressions; the original captured run has 7 tests and 44 assertions). Results
retain the original sample and record corrected-evaluator verification separately;
fixture bytes, trigger schedule, and the observed 1/4 baseline recovery are unchanged.
Required regression and repository gates:

```bash
bun test ./src/agent/compaction.test.ts ./src/context-compactor.test.ts ./src/session/runtime-assembly.test.ts ./src/session/optimized-context-store.test.ts ./tests/unit/compactor-pairing.test.ts
bun run typecheck
bun run build
bun run test
bun run check
```

No commit or release action is part of this fixture.
