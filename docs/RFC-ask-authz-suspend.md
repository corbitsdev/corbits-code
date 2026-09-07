# RFC: Reconcile ask-authz suspend with unified message bus

**Status:** Draft
**Author:** Corbits Code
**Ticket:** [CL-5683](https://linear.app/abklabs/issue/CL-5683/rfc-reconcile-ask-authz-suspend-with-unified-message-bus)
**Blocks:** CL-5699 (adopt reactor approval-suspend primitive)

## Summary

The current permission gate holds `resolve()` callbacks in memory for the
duration of operator interaction. This works in-process but has no durability,
no cross-process portability, and no integration with the `@intx/types`
`Channel<T>` message bus that underlies the reactor. This RFC proposes a
migration path toward an explicit suspend/resume primitive that survives
process restarts and plugs into the unified message bus, aligning with the
reactor's approval-suspend primitive that CL-5699 will adopt.

## Motivation

### Current architecture

The permission system is already unified in-process — both shell/file-tool
permissions and operator questions flow through typed gate events:

- `PermissionGateEvent` (`src/tui/gate-events.ts:23-39`) — carries a
  `PermissionRequest`, a `resolve(outcome)` callback, optional `timeoutMs`,
  and an `AbortSignal`.
- `OperatorGateEvent` (`src/tui/gate-events.ts:4-21`) — carries a question,
  options, a `resolve(result)` callback, optional `timeoutMs`, and an
  `AbortSignal`.

The overlay host (`src/tui/gate-wire.ts`) connects these events to the TUI,
holding the `resolve()` callback open until the operator interacts. A
reconciliation queue (`src/permission/queue.ts`) serializes concurrent requests
and routes grants through the approval store.

### The gap

The "suspend" is implicit: the `resolve()` closure sits in memory, pinned by
the gate-wire's pending queue. If the process dies, the suspend is lost — the
LLM's tool call returns a hung future with no recovery path. This is fine for
an interactive terminal session but blocks:

1. **Process restart recovery.** A crashed session cannot resume a pending
   operator approval.
2. **Cross-process portability.** The `@intx/types` `Channel<T>` pattern lets
   messages flow between the reactor and external surfaces (TUI, web, CI).
   Permission requests cannot currently ride this bus because they are
   closure-based, not message-based.
3. **Reactor approval-suspend primitive.** The upstream reactor now supports an
   explicit `suspend()` / `resume()` cycle for gate interactions. Corbits Code
   does not yet use it because the current closure-based approach predates it.

## Design

### Phase 1: Explicit suspend token (CL-5699 scope)

Replace the bare `resolve()` closure with a `SuspendToken` that carries:

```typescript
interface SuspendToken {
  /** Unique ID for this permission interaction. */
  id: string;
  /** Resume with the operator's decision. */
  resume(outcome: ApprovalOutcome | OperatorResult): void;
  /** Cancel the interaction (auto-deny / auto-cancel). */
  cancel(reason: string): void;
  /** Whether the interaction is still pending. */
  readonly pending: boolean;
}
```

The gate-wire creates a `SuspendToken` for each gate event, stores it in a
`Map<string, SuspendToken>`, and passes the token to the reactor's suspend
mechanism. The reactor calls `token.resume()` when the operator answers, and
`token.cancel()` on timeout or abort.

This keeps the in-process behavior identical to today but gives the reactor an
explicit handle it can persist, serialize, or pass across process boundaries.

### Phase 2: Message-bus integration (future, out of scope for v0.3.19)

Once Phase 1 lands, permission requests can be serialized as `Channel<T>`
messages. The reactor suspends with a token, the TUI overlay resumes it.
A future web or CI surface could do the same without in-process coupling.

The serialized form would be:

```typescript
interface SuspendMessage {
  kind: "permission-suspend";
  token: string; // SuspendToken.id
  request: PermissionRequest;
}
```

### Interaction with CL-7333 umbrella

This RFC informs CL-5699 (adopt reactor's approval-suspend primitive) and
indirectly CL-5697 (vendor `@intx/inference` at HEAD, which ships the suspend
primitive in the reactor). No code changes in this RFC — it is a design doc.

## Alternatives considered

1. **Keep closure-based suspend, add try/catch wrapping.** Low effort but does
   not solve durability or cross-process portability. The reactor's primitive
   would go unused.

2. **Serialize the full `PermissionRequest` into the context store.** Heavier
   than needed — the token ID is sufficient to re-derive state from the queue.
   The full request can be reconstructed from the queue's pending entries.

3. **Skip Phase 1, jump straight to message-bus integration.** Risks a larger
   blast radius; the Phase 1 token gives a clean seam for testing and
   incremental migration.

## Migration path

1. CL-5683 (this RFC) — design complete.
2. CL-5699 — implement `SuspendToken`, wire gate-wire to use it, pass tokens
   to reactor. Gate-wire behavior unchanged from the operator's perspective.
3. Monitor adoption; Phase 2 only when a cross-process surface requests it.

## Open questions

- Should `SuspendToken` be in `src/permission/` or `src/agent/`? The token is
  created by the permission gate but consumed by the reactor. Leaning toward
  `src/permission/suspend.ts` with a re-export from `src/agent/`.
- Should the token carry an optional serialized snapshot for process restart
  recovery? Adds complexity; defer to Phase 2 unless a concrete use case
  appears.
