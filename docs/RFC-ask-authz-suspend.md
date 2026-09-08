# RFC: Reconcile ask-authz suspend with unified message bus

**Status:** Draft
**Author:** Corbits Code
**Ticket:** [CL-5683](https://linear.app/abklabs/issue/CL-5683/rfc-reconcile-ask-authz-suspend-with-unified-message-bus)
**Blocks:** CL-5699 (adopt reactor approval-suspend primitive)

## Summary

The current permission gate parks tool calls on in-memory `resolve()`
closures (the `resolve` field of `PermissionGateEvent` in
`src/tui/gate-events.ts`) held open by the gate-wire
overlay. This RFC decides how Corbits Code adopts the upstream reactor's
approval-suspend primitive instead: a before-tool authz hook that returns
a `suspend` effect carrying an approval gate and a persisted
`PendingOperation`, with resumption driven by the reactor's signal
dispatch — not by any callback we invent.

This RFC resolves the four decisions CL-5683 requires:

- **(a)** The gate's pending-record bookkeeping maps onto the upstream
  `PendingOperation`/`correlationId` flow by adopting the upstream
  `correlationId` as the single identity for a parked call and reusing the
  existing `pendingOperations` persistence in
  `src/session/optimized-context-store.ts` — no parallel queue.
- **(b)** Director ask-handling consumes the reactor's suspend action and
  `gate.cleared` resume dispatch; the director stops owning approval
  queues. The wiring seam is the `requestApproval` field of
  `SessionGateArgs` and its pass into `createPermissionGate` in
  `assembleSessionGate` (`src/session/assemble-runtime.ts`),
  not the director.
- **(c)** `src/permission/classify.ts` allow/ask tiering stays a
  pre-filter above authz grants; it is not authz policy.
- **(d)** Headless denial and the stricter chained-command deny are
  re-homed as `block` effects in the authz extension's before-tool hook,
  where upstream already has a block channel.

No code changes in this cut — design decision only. It blocks only
CL-5699.

## Motivation

### Current architecture

- `PermissionGateEvent` (`src/tui/gate-events.ts`) carries a
  `PermissionRequest`, a `resolve(outcome)` callback, optional
  `timeoutMs`, and an `AbortSignal`.
- `OperatorGateEvent` (`src/tui/gate-events.ts`) is the question
  analogue.
- The gate-wire overlay (`src/tui/gate-wire.ts`) connects these events to
  the TUI and holds `resolve()` open until the operator interacts; it also
  owns the pending-display overlay that serializes what the operator sees
  (`wireGates` in `src/tui/gate-wire.ts`).
- `src/permission/queue.ts` is an in-memory `Map` of concurrent pending
  entries keyed by id (`createPermissionRequestQueue` in
  `src/permission/queue.ts`) used to reconcile
  grants through the approval store; `src/permission/store.ts` persists
  grants only, not pending requests.

### The gap

The "suspend" is implicit: the `resolve()` closure sits in memory, pinned
by the gate-wire's pending overlay. If the process dies, the suspend is
lost — the LLM's tool call returns a hung future with no recovery path.
Today there is **no durability for pending approvals**: the queue is an
in-memory Map and the store holds grants only. Nothing in this RFC claims
restart recovery for pending approvals until that changes (see the
durability decision under (a)).

Meanwhile the upstream reactor (vendored at `vendor/intx-inference`)
already carries the primitive:

- The before-tool authz hook returns, for an `ask` effect,
  `{ type: "suspend", gate: { type: "approval", gateId, correlationId,
timeoutAt }, pendingOp }` (`authz-extension.ts:263-267` upstream; the
  reactor persists `pendingOp`, minting `correlationId` at :223 and
  `gateId = pending-${correlationId}` at :226).
- `DEFAULT_APPROVAL_TIMEOUT_MS = 3_600_000` (:36) — one hour.
- Resume is signal-driven dispatch in the reactor: a suspended call parks
  on the reserved `signalName(correlationId)` channel (see the park-kind
  prose in `packages/types/src/signals.ts:67` and `runtime.ts:663`
  upstream), and a cleared gate enqueues a `reactor.gate.cleared` event
  the director decides on (`reactor.ts:8-10, 68-72` upstream).
- A re-dispatch of an already-approved call bypasses the gate via a
  delete-on-read in-memory `approvedOnce` token
  (`authz-extension.ts:211-218`).

Corbits Code does not use this yet because the closure-based approach
predates the vendoring.

## Decisions

### (a) Gate pending records map onto PendingOperation / correlationId

**Decision:** adopt the upstream `correlationId` as the single identity of
a parked permission request. The gate's current per-request ids and
resolve closures are replaced by the upstream flow: the authz hook mints
`correlationId`, wraps the request into a `pendingOp`
(`PendingOperation` from `@intx/types/runtime`, with `approvalSnapshot`
and `suspendedCall`), and returns the `suspend` effect. The reactor
persists the operation; resume is addressed by `correlationId` via the
signal channel, not by holding a callback.

Rationale: today `src/session/optimized-context-store.ts` already
persists `PendingOperation[]` from `@intx/types/runtime`
(the `pendingOperations` field of its `SessionMetadata`), and upstream
persists the operation
precisely so the id survives a restart (comment at
`authz-extension.ts:219-221`). Using that existing surface means the
gate's bookkeeping collapses into one identity and one store instead of a
parallel `Map<string, SuspendToken>` in the gate-wire.

**Durability, stated honestly:** as of this RFC, restart recovery for
pending approvals is **not delivered and remains out of CL-5699 scope**.
`src/permission/queue.ts` is an in-memory `Map` and
`src/permission/store.ts` persists grants only, so a crashed session
still loses the pending approval. The mapping above is what makes
recovery _possible later_ (the persisted `pendingOperations` plus
`correlationId`-addressed resume), but wiring snapshot-and-restore is
separate work and is not claimed by CL-5699.

### (b) Director consumes suspend actions; requestApproval is the seam

**Decision:** director ask-handling consumes the reactor's suspend action
and the `gate.cleared`-driven resume dispatch, and stops managing its own
approval queue. The `requestApproval` hook stays wired where it is today
— declared on `SessionGateArgs` and passed into `createPermissionGate`
by `assembleSessionGate` (both in `src/session/assemble-runtime.ts`) —
and its job
narrows to feeding the operator-facing surface. The director never sees
the gate itself; it sees outcomes only as tool-result text today
(`isOperatorDeclinedToolResult` in `src/agent/director.ts` matches
"Blocked by permission policy: Operator declined:") and, after adoption,
additionally sees the suspend
as a parked tool call and the clear as a `reactor.gate.cleared` event it
decides on.

Rationale: upstream deliberately separates "the call is parked" (reactor,
gate, persisted operation) from "the director decides what happens when
the gate clears" (resume dispatch reaches the director as a normal
event). Putting the queue in the director would duplicate the reactor's
park/bookkeeping role; putting it nowhere loses the operator surface.
The seam ownership follows the existing wiring: the session assembles the
gate dependencies, the reactor owns the suspend lifecycle, the director
only reacts to events.

### (c) classify.ts tiering stays a pre-filter above authz grants

**Decision:** `src/permission/classify.ts`'s allow/ask `Tier`
remains a pre-filter that decides _whether and how_
the authz path is consulted; it does not become authz policy. Read-only
tools classify `allow` and short-circuit; everything else classifies
`ask` and flows through the authz grant path, where grants, denies, and
the suspend effect live.

Rationale: the classifier encodes Corbits' tool-level defaults (which
tools are safe to auto-run) — knowledge that lives on our side of the
boundary and that upstream authz has no way to express. Authz grants
encode per-project operator intent (patterns, scopes, persistence).
Collapsing the two would either push Corbits tool defaults into
grant-matching (wrong layer, wrong persistence) or force the grant store
to re-implement tiering. Keeping the tier as a pre-filter preserves both
and gives the suspend primitive a clean trigger: `ask` tier is exactly
the condition under which the before-tool hook can return `suspend`.

### (d) Headless denial and stricter command-deny re-home as block effects

**Decision:** the two Corbits-only deny paths move into the authz
extension's before-tool hook as `block` effects, which upstream already
supports (`{ type: "block", reason }` is a first-class hook return in
`authz-extension.ts:205-208`):

- **Headless denial** — today in the two `!interactive` deny branches of
  `evaluate` in `src/permission/gate.ts`. When the run is non-interactive
  there is no operator to
  approve, so instead of reaching the `ask` effect the hook returns
  `block` with the existing denial reasons.
- **Stricter chained-command deny** — today the
  `runShellAuthzBlockReason` check in `evaluate`, owned by
  `preGrantGuardReason` (both in `src/permission/gate.ts`), which
  hard-denies chained shell commands whose
  segments target restricted or sensitive paths even when a grant
  exists. This stays a pre-grant guard but is expressed as a `block`
  effect in the hook rather than gate-internal bookkeeping.

Neither path has an upstream equivalent, so both are ours to carry; the
decision is only _where_ they live. Putting them in the hook means the
gate's `ask` path is the only path that can suspend, and denial never
needs a parked operation, a correlation id, or a resume.

Rationale: upstream's hook contract already distinguishes
allow / block / ask / suspend. Denial-without-interaction is exactly
`block`; approval-requiring is exactly `ask`→`suspend`. Re-homing keeps
`gate.ts`'s remaining job limited to interactive outcome routing while
the vendored reactor owns the lifecycle.

## Transport: what exists, not `Channel<T>`

`@intx/types` has no `Channel<T>`. An earlier draft of this RFC designed
a bus around one; that interface does not exist upstream or in our tree.
The real mechanisms are:

- **Upstream:** the reserved signal channel — a suspended step parks on
  `signalName(correlationId)` and resume is the reactor's signal-driven
  dispatch (`packages/types/src/signals.ts:67`,
  `packages/types/src/runtime.ts:663`, `reactor.ts:8-10, 68-72`).
  This is the transport the suspend primitive is designed against, so it
  is the one we adopt: gate clears are delivered by enqueueing a signal
  on the correlation-id channel, and the reactor's existing resume
  dispatch does the rest.
- **Ours:** the TUI gate wire (`src/tui/gate-wire.ts` and
  `src/tui/gate-events.ts`, exercised end to end by the harness modules
  under `tests/integration/`) is EventEmitter-based — a display-plane
  mechanism, suited to
  surfacing the pending operation to the operator, not to resuming a
  parked reactor step.

Decision: resume transport is the upstream signal channel (it is what
the reactor dispatches on); the EventEmitter gate-wire events stay on
the display plane and carry the approval snapshot to the overlay. No new
message type is introduced.

## Alternatives considered

1. **Keep closure-based suspend.** Zero migration cost but leaves the
   reactor's primitive unused, keeps `resolve()` pinned in memory, and
   forfeits the persisted-`pendingOp` identity that any future restart
   recovery needs.

2. **Invent a `SuspendToken` with `resume()`/`cancel()` handed to the
   reactor.** Rejected: corresponds to nothing upstream. The reactor's
   resume is signal-driven dispatch; a callback-based token would be a
   second resume mechanism racing the first.

3. **Serialize the full `PermissionRequest` into the store "because the
   queue can reconstruct it."** Rejected as stated: the queue is an
   in-memory `Map` (`createPermissionRequestQueue` in
   `src/permission/queue.ts`), so after process
   death there are no pending entries to reconstruct from, and
   `src/permission/store.ts` persists grants only. Snapshot/restore of
   pending operations is real future work, decided out of scope in (a).

4. **Skip adoption until a cross-process surface exists.** Rejected: the
   closure-based path already breaks down on single-process restart, and
   adoption is a prerequisite for CL-5699 regardless.

## Migration path

1. CL-5683 (this RFC) — design complete; decisions (a)-(d) above.
2. CL-5699 — implement: route `ask`-tier calls through the authz hook's
   suspend effect; persist `PendingOperation` via the existing
   `optimized-context-store` surface; deliver gate clears on the
   correlation-id signal channel; re-home the two deny paths as `block`
   effects; narrow `requestApproval` to the operator-facing seam.
   Gate-wire display behavior unchanged from the operator's perspective.
   Explicitly out of scope: snapshot-and-restore of pending approvals
   across restart.
3. Monitor adoption; revisit restart recovery as a separate ticket with
   its own scope.

## Open questions

- Should the approval `approvalSnapshot` → TUI payload mapping live in
  the gate-wire overlay or in a new adapter beside
  `src/session/optimized-context-store.ts`? Leaning gate-wire, since it
  already owns the pending-display overlay.
- Exact timeout policy: upstream defaults to one hour
  (`DEFAULT_APPROVAL_TIMEOUT_MS`, `authz-extension.ts:36`); whether
  unattended auto-continue runs should pass a shorter
  `approvalTimeoutMs` per run.
