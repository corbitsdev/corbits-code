# Incident note: `send_input` cannot authorize a parked worker call

## Observed symptom

A parent can send “approved; retry” through `send_input` and the parked worker remains blocked. The text may answer the worker's question; it does not approve or retry the denied tool call.

## Root cause and safe behavior

**Source-verified:** a denied worker call is retained as an exact envelope. `send_input` is intentionally text-only, and message prose is never parsed as authority. See [`src/permission/worker-grant.ts`](../../src/permission/worker-grant.ts) and [`src/permission/worker-grant-flow.test.ts`](../../src/permission/worker-grant-flow.test.ts).

Use typed `approve_worker_call` with the live `target`, `question_id`, and `request_id`. It validates the exact pending envelope, evaluates the frozen call through the parent permission gate, and only then wakes the worker. See [`src/subagent/lifecycle-tools.ts`](../../src/subagent/lifecycle-tools.ts). Do not use `send_input` as a fallback authorization or retry mechanism. If typed approval is unavailable, report the worker as blocked.

## Safe reproduction: parked-call authorization boundary (harness/tooling behavior)

Use an isolated test harness/session and a deliberately harmless, permission-gated worker call. Do not use a shell mutation, production target, or a broad approval.

1. Dispatch a worker whose harmless call is denied and therefore parked; record the pending call's live `target`, `question_id`, and `request_id`.
2. Resolve the worker's question with structured `send_input` data that says the request is approved or that it should retry. Do not invoke an approval tool as part of this step.
3. Inspect the parked worker and pending-call state.

**Expected result:** `send_input` delivers the structured/textual resolution only. The denied call remains pending, is not retried, and no authority is granted from the message contents.

For comparison, the only authorization path is a typed `approve_worker_call` for that same live pending envelope: it supplies the recorded `target`, `question_id`, and `request_id`, then passes through the parent permission gate. A valid approval may wake the worker; a stale or mismatched envelope must not authorize a call. This comparison is descriptive of the harness boundary, not an instruction to grant broad authority or perform a mutation.

## Impact

This fail-closed behavior prevents a message from minting authority or replaying a different or stale call. A parked worker cannot proceed until its exact typed approval is available and succeeds.

## Runtime provenance

**Local-checkout evidence:** Git `HEAD` resolves to `8beff1180b461a7b3b7099b867ecadca1974c394` (`refs/heads/main`) for the checkout inspected while updating this note. This identifies local checkout state only; it does not establish the revision of an active deployment or session.

- **Active inference provider:** not captured. No accessible session or repository evidence identified the provider; no value is inferred from the checkout.
- **Active inference model:** not captured. No accessible session or repository evidence identified the model; no value is inferred from the checkout.
- **Capture time:** not captured.
- **Capture context:** documentation-worker inspection of the local checkout's Git metadata; no active deployment or inference-session metadata was available as evidence.

### Presumptive bug/incident report standard

All presumptive bug or incident reports must include the checkout Git revision, active inference provider, and active inference model, plus capture time and context when known. Each field must be evidence-scoped: label unavailable or not captured values explicitly, do not guess, and distinguish local checkout state from active deployment/session state.

## CL-10696 and registry-parity context

**Incident-context inference, not locally ticket-verified:** CL-10696 is reported to have kept `send_input` text-only while introducing typed approval. Local source corroborates that behavior, but not the external ticket history.

**Source-verified registry observation:** [`src/agent/directors/tool-sets.ts`](../../src/agent/directors/tool-sets.ts) lists `send_input`, but not `approve_worker_call`, in `ORCHESTRATOR_TOOLS`. The nested runtime mount list in [`src/subagent/run.ts`](../../src/subagent/run.ts) does include `approve_worker_call`. Active-session availability is therefore a deployment/session inference: the reported cleanup worker exposed `send_input` but not `approve_worker_call`, explaining why it remained blocked; that does not establish the same tool surface for every deployment.

## Separate dispatch preflight observation

The initial Shakespeare worker spawn failed preflight with `worker "shakespeare" requires unknown tool "apply_patch"`. Re-dispatching the task without that unsupported `requires_tools` constraint succeeded. This is a dispatch tool-requirements validation/configuration issue; it is not evidence about `send_input` authorization or Git permissions.

## Safe reproduction: documentation-worker preflight (harness/tooling behavior)

Use a disposable documentation-worker dispatch and do not run a worker task that changes files.

1. Submit a Shakespeare/documentation-worker dispatch whose worker declaration includes `requires_tools: ["apply_patch"]`.
2. Observe preflight validation before the worker starts.
3. Re-dispatch the same no-op or read-only task after removing the unsupported `requires_tools` declaration; do not substitute a broader requirement list.

**Expected result:** the first dispatch fails preflight with `worker "shakespeare" requires unknown tool "apply_patch"`, and no worker task is started. The re-dispatch is accepted by preflight once the unsupported constraint is removed. This recovery addresses only requirements validation; it neither grants a tool nor changes the `send_input` authorization behavior described above.
