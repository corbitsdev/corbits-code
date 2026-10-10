# CL-10432 — Outcome-aware worker escalation policy

## Objective

Codify the pre-escalation policy as a typed application contract spanning a
worker's `ask_director` request, the parked-session record, parent CLI/TUI
surfaces, and terminal worker outcomes. Do **not** rely on worker prompt prose
to decide whether a question is worthy of escalation.

The implementation must make a worker first identify its concrete blocked
outcome/verification, record whether a permitted alternative exists, and only
park a question when a director or operator decision is materially necessary.
It must keep the current least-authority exact-call grant boundary intact:
neither a parent answer nor a wake may broaden a permission grant or replay a
tool automatically.

## Authoritative policy and acceptance contract

For every request to surface a worker issue, validate and retain these six
pre-escalation facts:

1. **Blocked outcome/verification** — the specific task result or verification
   result that cannot be produced.
2. **Unavailable director path** — why the director cannot resolve the issue
   with current authority and context.
3. **Permitted alternatives considered** — whether an already-permitted path
   provides comparable confidence without material added time, scope, cost, or
   risk. If one does, the worker must take it and must not park/escalate.
4. **Minimum addition** — the smallest extra decision, authority, or
   environment capability needed when no comparable alternative exists.
5. **Decline/proceed-without consequence** — the changed or reduced
   deliverable if the addition is declined or unavailable.
6. **Safe default/recommendation** — a recommended safe choice when one
   exists.

Use these structural classifications (not free-form labels):

| Classification               | Required runtime behavior                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routine`                    | Internal chatter or a comparable already-permitted alternative exists. Record the evaluation for audit, return a continue-with-alternative result to the worker, and never create a pending ask, parent wake, or operator escalation.                                                                                                             |
| `director_resolvable`        | A parent director can answer or select an already-authorized narrow path. Park the worker and wake the parent with the structured facts; the parent resolves via existing soft `send_input`. It is **not** an operator escalation.                                                                                                                |
| `operator_decision_required` | A material decision/authority addition remains after alternatives are exhausted. Park and proactively surface a concise, actionable request to the parent; the parent decides whether to obtain operator input. Include both the requested mechanism and the smaller `minimumAuthority` so a broad mechanism is never treated as the grant scope. |
| `outcome_blocked`            | No comparable director-side route exists and the worker must report a changed deliverable. Keep the structured blocker on the session; for verification, the terminal result is `verification_blocked`, not `verified` and not generic `failed`.                                                                                                  |
| `irreversible_or_sensitive`  | A material irreversible/sensitive act needs an explicit decision even if technically possible. Park and surface the same six facts, with a conservative default; do not perform it merely because the parent wake was delivered.                                                                                                                  |

Verification blockers use exactly the same decision process. Distinguish a
wrong invocation/configuration from a missing dependency, toolchain,
environment, credential, or capability. Try permitted narrow alternatives
(correct worktree, cached/existing dependencies, focused test, a narrower
formatter/install, or existing test authentication) before an authority
request. On decline/unavailability, durably record that implementation/review
completed but verification is blocked, including the root cause and reduced
confidence/deliverable. A subsequent minimum-grant decision may resume the
worker's verification turn, but it must not execute or retry the denied command
automatically.

## Existing architecture to preserve

- `src/subagent/ask-director.ts` currently validates only question size/count
  and parks through `AskDirectorPort`; it has no policy payload.
- `src/subagent/session-store.ts` owns exactly one in-memory pending ask per
  running session, exact-once settlement, and `peekAsk`; current pending state
  is only question/question id plus an optional exact denied-call envelope.
- `src/permission/worker-grant.ts` is the permission authority boundary. Its
  envelope contains the exact denied call and fingerprint; a grant has one
  exact retry path and a TTL. Ask text is explicitly non-authoritative.
- `src/subagent/agent-fleet.ts` owns the port registration, wait/list CLI
  projections, and the parked-ask surfaced stamp. `src/subagent/fleet-report.ts`
  creates the parent wake text.
- `src/tui/runner/wiring.ts` publishes snapshots. `src/tui/runtime-bridge.ts`
  keys wake deduplication by `sessionId` + `questionId`, defers delivery until
  the parent is idle and gates are closed, and safely re-surfaces an aborted
  wake. `src/tui/agent-ask-wake.test.ts` is the current end-to-end wake test
  harness.
- `SubAgentSession` has report/stop/lifecycle fields only. Current structured
  `submit_result` validates a payload but does not retain it, so it cannot by
  itself be the durable verification-outcome store.

## Implementation plan

### Phase 1 — Introduce the policy model and pure enforcement

1. **Create `src/subagent/escalation-policy.ts`.**
   - Define the closed `EscalationClassification` union above; do not accept
     arbitrary strings.
   - Define an immutable `EscalationAssessment` with a stable `policyVersion`,
     classification, six policy facts, permitted alternatives (including
     attempted/result/comparable-confidence), requested mechanism, minimum
     authority/decision, and optional verification detail
     (`verificationOutcome`, root cause, attempted narrow checks, and reduced
     confidence).
   - Represent the safe default as a structured optional value
     (`recommendation`/`safeDefault`), not a magic sentinel in a question.
     Validation must require it when the caller asserts one exists.
   - Define a small, explicit `EscalationResolution` union for parent action:
     normal director answer; `declined`; `unavailable`; and
     `minimum_grant_available`. It must carry a text answer for the worker but
     never a tool call or broad grant. Keep legacy text-only `send_input`
     compatible by treating it as a normal director answer.
   - Export pure functions to parse/validate raw tool input, decide
     `continue_internal` vs `park_parent`, derive a terminal
     `verification_blocked` outcome for declined/unavailable verification, and
     render a concise parent decision block. Validation rules must enforce all
     six facts for every parked/surfaced classification; `routine` must have a
     viable permitted alternative; `operator_decision_required` and
     `irreversible_or_sensitive` must declare a non-empty minimum addition;
     requested mechanism and minimum authority must be distinct fields.
   - The renderer must label all six facts, list alternatives and their
     results, separate **Requested mechanism** from **Minimum
     authority/decision**, name the target/session/question, and tell the
     parent to use `send_input` (or its structured resolution). It must be
     deterministic and bounded using the existing text caps.

2. **Create `src/subagent/escalation-policy.test.ts`.** Unit-test parsing,
   structural completeness, each classification, and renderer output. Include:
   - an ordinary/routine request with a comparable permitted alternative is
     returned as internal and cannot yield a parked directive;
   - a director-resolvable alternate records the alternate and produces a
     parent-only directive, not operator wording;
   - a true material blocker rejects incomplete facts and, when valid, renders
     all six labeled fields;
   - an example requesting a broad web mechanism while an authenticated
     read/snapshot is the minimum authority proves the two are not conflated;
   - verification invocation/configuration versus missing-capability examples,
     including the derived `verification_blocked` result on decline.

**Phase gate:** run
`bun test src/subagent/escalation-policy.test.ts`.

### Phase 2 — Thread assessments through parked worker state and outcome

3. **Modify `src/subagent/ask-director.ts`.**
   - Extend the raw `AskDirectorInput`/port contract to carry a validated
     `EscalationAssessment` and pass it to registration only after the pure
     policy evaluator selects `park_parent`.
   - For `continue_internal`, do not flip `state.pending`, consume a question
     slot, call `port.register`, or create a wake. Return a precise result that
     tells the worker to take the recorded permitted alternative and later
     report it. This is the app-level enforcement for routine chatter.
   - Retain all current size, one-pending, abort, and cap semantics. Never
     infer a grant from the assessment or from its recommendation.

4. **Modify `src/subagent/run.ts` and `src/subagent/types.ts`.**
   - Extend the `ask_director` tool JSON schema with one required structural
     `escalation` object (the policy model’s wire-safe fields), while preserving
     `question` and optional `grant_request_id` for the exact denied-call
     association. Update the tool description only to explain the typed fields
     and the no-widen/no-auto-retry guarantee; the runtime remains the source
     of truth.
   - Thread the parsed assessment through `handleAskDirector` and
     `RunSubAgentParams.askDirectorPort`. Do not modify the permission gate,
     worker-grant TTL, grant matching, or retry machinery.
   - Update existing run/grant test fixtures for the new required payload and
     preserve the assertion that `grant_request_id` alone only attaches the
     harness-owned envelope.

5. **Modify `src/subagent/session-store.ts`.**
   - Add a typed append-only/current `EscalationRecord` to `SubAgentSession`
     (or a named typed field with equivalent retention) and add the assessment
     to the private pending-ask record and `peekAsk` projection. It must be
     session-owned state, never reconstructed by parsing question/report text.
   - Expand `registerAsk` to accept the assessment and atomically record the
     alternative evaluation before it makes a question observable. Preserve
     one-pending-ask and exact denied-call attachment behavior.
   - Add a typed `terminalOutcome` to `SubAgentSession`; at minimum support
     `verification_blocked` with: implementation/review completion state,
     exact verification outcome, root cause, alternatives/results, declined or
     unavailable minimum addition, reduced-confidence/changed-deliverable
     statement, and recommendation. Do not overload `stopReason`, `error`, or
     Markdown report text.
   - Add a resolution method that atomically removes the pending ask, records
     a structured decline/unavailability outcome before resolving the worker
     promise, and notifies subscribers once. A normal answer or
     `minimum_grant_available` resumes only by delivering explicit text to the
     worker. It must not invoke a tool, consume a worker grant, or alter the
     exact envelope.
   - Retain `terminalOutcome` across `complete`, report attachment, list/wait
     projections, and retained session resumption. A follow-up may only replace
     `verification_blocked` after the worker explicitly reports a new successful
     verification outcome through the typed session contract; it must never
     silently become verified because a decision was granted. Cancellation,
     timeout, interruption, eviction, and teardown must retain/fail-close with
     the current exact-once invalidation semantics.

6. **Modify `src/subagent/agent-fleet.ts` and
   `src/subagent/lifecycle-tools.ts`.**
   - Thread assessment through `askDirectorPort.register`.
   - Add an optional, backward-compatible structured escalation resolution to
     `send_input`’s parent-only path. Plain `send_input` stays a text answer.
     Only the target parent may pass `declined`, `unavailable`, or
     `minimum_grant_available`; validate it against the current pending
     question/session and reject stale/mismatched question ids.
   - Expose a pending question’s assessment and a terminal outcome in
     `wait_agents` and `list_agents` JSON with stable field names. Update the
     anti-polling surfaced fingerprint to include immutable
     `sessionId/questionId/policyVersion` (or a canonical assessment id), so a
     duplicate snapshot is refused but a genuinely new question re-surfaces.
   - Render CLI errors/list rows from the policy renderer instead of raw
     question-only strings. The parent must see the outcome, unavailable
     director path, alternatives, minimum authority, decline consequence, and
     recommendation, plus the exact `send_input` target. Do not expose raw
     denied tool arguments; retain current envelope-only grant behavior.

7. **Extend tests in** `src/subagent/ask-director.test.ts`,
   `src/subagent/session-store.test.ts`,
   `src/subagent/agent-fleet.test.ts`,
   `src/subagent/lifecycle-tools.test.ts`,
   `src/subagent/run-ask-director-grant.test.ts`, and
   `src/permission/worker-grant-flow.test.ts`.
   - Routine permitted alternative: no port registration/pending ask/wake;
     assessment is recorded as internal.
   - Director-resolvable alternative: it is surfaced to the parent and can be
     answered with soft text, but the parent is never instructed to contact the
     operator and no grant is touched.
   - True material decision: parked CLI/wait projection contains all six
     structural items and specifically distinguishes broad requested mechanism
     from minimum authority.
   - Decline/unavailable verification: `send_input` structured resolution
     creates and preserves `terminalOutcome.kind === "verification_blocked"`;
     it records implementation/review complete and cannot display `verified`
     or collapse into generic failure.
   - Minimum-grant resumption: an explicit parent resolution unblocks the
     worker’s next turn safely, leaves the original denied-call envelope
     unconsumed, and proves neither a permission widening nor automatic tool
     retry occurred. Existing stale, abort, timeout, and question-cap behavior
     remains unchanged.

**Phase gate:** run
`bun test src/subagent/escalation-policy.test.ts src/subagent/ask-director.test.ts src/subagent/session-store.test.ts src/subagent/agent-fleet.test.ts src/subagent/lifecycle-tools.test.ts src/subagent/run-ask-director-grant.test.ts src/permission/worker-grant.test.ts src/permission/worker-grant-flow.test.ts`.

### Phase 3 — Parent wake, TUI visibility, and duplicate-safe rendering

8. **Modify `src/subagent/fleet-report.ts`.**
   - Extend `PendingAskWake` and `pendingAskSnapshot` with the immutable
     assessment/assessment id from `peekAsk`.
   - Replace the question-only body in `pendingAskWakeText` with the shared
     concise policy renderer. Keep existing session id, agent identity,
     question id, soft `send_input` route, and re-surface wording.
   - Preserve the invariant that only top-level running workers wake the root;
     nested worker questions remain owned by their parent orchestrator.

9. **Modify `src/tui/runtime-bridge.ts`, `src/tui/worker-wait.ts`, and, only
   if required by the current panel data shape, `src/tui/shell/internals.ts`.**
   - Carry the extended `PendingAskWake` through the `agent-ask` bridge event
     and show a concise actionable decision summary in the worker-wait panel:
     classification, blocked outcome, minimum authority/decision, consequence,
     recommendation, and target.
   - Keep the parent-turn wake delivery as the action path. The panel is a live
     view, not a second action queue or a bypass around `send_input`.
   - Preserve session/question dedup and re-surface handling. Immutable policy
     detail for a live question must not generate a new wake; a settled/replaced
     question clears its delivered identity; late duplicate snapshots and a
     wake turn aborted before delivery remain safe.

10. **Modify `src/tui/agent-ask-wake.test.ts`,
    `src/tui/runner/wiring.ask-wake.test.ts`,
    `src/subagent/fleet-report.ask-wake.test.ts`, and add/extend
    `src/tui/worker-wait.test.ts`.**
    - Preserve the existing idle-parent exact-once, mid-cycle defer,
      multi-worker coalescing, open-gate, mailbox-before-wake, reset, and
      resurface coverage with an assessed question.
    - Assert that an idle parent receives one actionable wake containing all
      six fields; repeated/late identical `agent-ask` snapshots do not produce
      another turn or panel duplicate.
    - Assert a routine/internal assessment is not present in a wake/panel.
    - Assert a true decision and a missing-capability verification blocker are
      visibly actionable and identify the minimum addition rather than a broad
      requested mechanism.
    - Assert decline leaves the terminal worker row visibly
      `verification_blocked`; a later `minimum_grant_available` answer allows
      an explicit worker continuation, without a synthetic command replay.

**Phase gate:** run
`bun test src/subagent/fleet-report.ask-wake.test.ts src/tui/worker-wait.test.ts src/tui/agent-ask-wake.test.ts src/tui/runner/wiring.ask-wake.test.ts`.

### Phase 4 — Compatibility and regression verification

11. Update affected snapshots/fixtures and public tool descriptions only where
    needed for the new optional output fields. Maintain compatibility for
    existing `send_input` callers that send plain text and for consumers that
    ignore additive JSON properties. Do not add a new external CLI command,
    approval queue, grant store, broad grant type, automatic retry, or
    permission bypass.

12. Run the complete quality sequence from the repository root:

```sh
bun run typecheck
bun run lint
bun test ./src/subagent ./src/permission ./src/tui --randomize --seed 424242
bun run check
```

If the broad test command is too slow or flaky, do not weaken the behavior or
add retries; report the failing command and run the Phase 2/3 targeted commands
above to localize it.

## Explicit non-goals and invariants

- No permission widening, wildcard grants, inferred scopes, or use of worker
  prose as grant authority. `WorkerDeniedCallEnvelope` remains the sole source
  for an exact denied call.
- No automatic command retry after a wake, an answer, a minimum-grant
  acknowledgement, or a TUI render. Only an explicit parent-controlled worker
  continuation and the existing exact grant/retry mechanism may run work.
- No automatic operator escalation for routine or director-resolvable issues.
  The parent director owns whether a true decision is relayed.
- No new durable-on-disk recovery promise. “Durable” in this ticket means a
  typed session/fleet terminal result retained through completion, wait/list,
  and explicit resumption—not Markdown inference and not process-restart
  persistence. If restart persistence is desired, schedule it separately with
  the existing pending-operation durability work.
- No removal of current ask deadline, cancellation, abort, mailbox ordering,
  or exact-once wake behavior.
- Do not treat blocked verification as fully verified or hide it behind a
  generic error merely because implementation/review work otherwise completed.

## Rollback/fallback

- Land the pure policy module and tests first. If wiring becomes contentious,
  retain it as the single source of validation/rendering and stop before
  changing the tool schema; do not substitute additional prompt instructions.
- Use additive optional JSON/session fields and preserve legacy text
  `send_input`. If a consumer cannot accept structured resolution, send the
  normal text answer and retain the assessment; do **not** silently mark a
  declined verification as verified.
- If a proposed terminal-outcome transition conflicts with retained-session
  lifecycle semantics, keep lifecycle status compatible (`completed`/existing
  projection) and store `terminalOutcome` separately. Do not add a new
  lifecycle enum that breaks `resume_agent`, `wait_agents`, or TUI consumers.
- If UI panel changes threaten wake ordering, keep the shared renderer in the
  existing parent wake and panel as display-only; preserve the current
  `sessionId + questionId` dedup, gate, mailbox, and re-surface logic.
