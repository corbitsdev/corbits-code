# Decision digest live gate (CL-9919) — predeclared, pending

Status: **pending**. Live-model comparison requires the CL-9879 evaluation
lane after merge (PR #1323 open, unmerged). No improvement is claimed from
scripted tests alone. This note records the decision rule in advance so the
later measurement cannot be re-cut to fit.

## What shipped now

- Optional versioned worker decision block (```decision:v1 JSON) with
  arktype boundary validation; prose is never inferred into a verdict.
- Digest carries `decision_verdict`/`decision_source` plus bounded
  `required_action`/`critical_findings`/`checks` (worker-reported/unverified),
  harness `status` kept separate (done != passed), `report_uri` or explicit
  `report_unavailable`, failure-first ordering, finite total cap
  (`MAILBOX_DIGEST_TOTAL_CHARS`) with visible `overflow` signals.
- Scripted compatibility side: `src/subagent/decision-digest.test.ts`
  (legacy, missing, invalid, conflicting, oversized, failed-check,
  unavailable-report, priority, total-cap cases).

## Predeclared live decision rule

Run after the CL-9879 lane merges, against that baseline, same scripted
matrix plus live-model workers with and without the decision block enabled:

1. Actionability: on a fixed set of mixed worker outcomes (pass/fail/blocked
   plus one legacy report), the parent's first turn names the correct
   required action and the failed worker(s) in >= 90% of runs, with no
   `done`-means-`passed` conflation in the sampled transcripts.
2. No-regression: legacy (block-less) reports still digest to
   `decision_verdict: unknown` and keep their summary path; scripted
   compatibility suite stays green.
3. Boundedness: digest batches over the total cap always carry an `overflow`
   signal and never exceed the cap in the measured runs.

Pass bar: meet all three on the post-merge lane. Otherwise the change ships
as compatibility-only (no live improvement claim).
