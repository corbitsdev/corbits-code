# CL-10189 — Persistent primary `ask_operator` input-required chrome

## Objective

Keep a one-line, composer-adjacent **INPUT REQUIRED** indicator visible for
every unresolved `ask_operator` request emitted by the **primary TUI session**.
The existing operator modal remains the sole interaction surface: this feature
is display state only and must not change focus, key routing, overlay FIFO
ordering, answers, cancellation, timeout, or watchdog behavior.

The strip is intentionally separate from the existing **WORKER WAITING**
chrome. That strip represents a root worker parked on `ask_director` and is
not an input source, routing mechanism, or lifecycle dependency for this
ticket.

## Acceptance criteria

1. A primary-session `ask_operator` event produces a persistent,
   composer-adjacent `INPUT REQUIRED` strip while that event is unresolved.
   The strip stays present behind the existing operator overlay and through
   transcript growth, input editing, status repaint, scroll, resize, and theme
   changes.
2. The strip's view model is keyed and deduplicated by
   `OperatorGateEvent.id`. Re-emitting an identical event ID cannot add a
   second item or force a paint when visible content is unchanged. Multiple
   distinct unresolved primary asks are represented deterministically, with an
   explicit `(+N more)` count when not all items fit in the one-row display.
3. Only the primary session's `ask_operator` emission is eligible. MCP trust
   prompts, unmarked/generic `operator.gate` events, permission gates,
   `ask_director` / worker pending asks, and OAuth/credential paths never
   activate this strip.
4. Every terminal path removes exactly the settled ID: option acceptance,
   free-text answer, Esc/cancel, gate timeout, watchdog/abort signal, and
   host teardown. Removal is idempotent and cannot close or clear a newer
   gate's indicator.
5. The existing operator overlay and routing contracts are unchanged: the
   modal still opens/queues/resumes normally, owns decision-gate keys, and
   resolves the original callback exactly once.
6. The row is theme-aware and width-safe, directly above the composer when
   geometry can afford it, takes a chrome/transcript row rather than reducing
   composer height, and disappears completely after the final tracked ask
   settles. At short heights it follows the documented optional-zone collapse
   policy without overlapping the composer.

## Lifecycle design and invariants

### Event provenance

* Extend `OperatorGateEvent` with an **optional, narrow source marker** whose
  only recognized value denotes `primary-session ask_operator` (for example,
  `source: "primary-ask-operator"`). Optional is deliberate: existing generic
  operator-gate consumers and tests remain valid, but the chrome fails closed
  unless the exact marker is present.
* In `src/tui/runner/session.ts`, set that marker only in the `onOperatorGate`
  callback passed to the primary session's `createAgentToolset` call. Do not
  set it in `requestMcpTrust`; it remains a normal operator modal but never
  an input-required item.
* Do not infer provenance from question text, options, session mode, a tool
  name, or event ordering. The explicit marker is the authorization boundary
  for this display-only feature.

### State ownership

* Add a small pure module, `src/tui/operator-input-required.ts`, analogous in
  shape to `worker-wait.ts` but independent of `PendingAskWake`. It owns:
  * an immutable state containing live primary-gate items keyed by event ID;
  * add/remove reducers that return the prior state object for a no-op;
  * a lookup/selection policy that keeps the currently displayed ID while it
    remains live, otherwise chooses the first live insertion-order item;
  * a bounded, ANSI/control-sequence-safe one-line formatter with a literal
    `INPUT REQUIRED` label, an answer-needed routing phrase, question preview,
    and optional `(+N more)` count; and
  * semantic text roles (mark/label/routing/question/more/separator) so paint
    code, not the model, assigns theme colors.
* Identity is exactly `event.id`. Admission rejects an empty/non-string ID and
  a source marker other than the recognized primary `ask_operator` value.
  A repeated ID updates no ordering and, if its rendered data is unchanged,
  returns the same state reference. `remove(id)` affects only that ID and is
  safe when called more than once or after another ID has become selected.
* Store this state on `AppShell` as a distinct field, initialized to a shared
  empty constant. It must never read or mutate `workerWait`, pending delivery
  state, the session bridge, or overlay state.

### Admission and settlement wiring

* Keep `wireGates` as the single owner of the `operator.gate` lifecycle. Add
  typed, event-aware lifecycle callbacks (or an equivalent narrowly scoped
  host callback) for **admission** and **settlement** of a recognized primary
  operator event; retain `onGateOpened`/`onGateClosed` unchanged for the
  generic bridge blocked-state accounting.
* In `onOperator`, validate the event ID first. For an admitted marked event,
  notify the product host/shell before `openOrQueue`, so an event queued behind
  another overlay is still visibly outstanding. Do not add permission events
  or unmarked/MCP operator events.
* Invoke the matching removal callback inside `settleOnce`, guarded by the
  existing `settled` flag, before/with the existing resolve-and-drain sequence.
  This ensures all current settlement routes use one removal path:
  `onAccept`, `onTextAnswer`, `onCancel`, timeout, `AbortSignal`, and the
  `operatorTeardowns` disposal sweep. Preserve the existing
  `overlayGeneration` checks, `operatorTeardowns` deletion, timer cleanup,
  `onceClosed` behavior, and FIFO/resume logic.
* In `mountProductHost`, pass the new lifecycle callbacks when it calls
  `wireGates`. The callbacks call shell chrome setters only; they neither
  resolve the event nor manipulate overlays. `disposeGates()` must run while
  the shell is still paintable, as it does today, so teardown removal is safe.
  Do not add a second `operator.gate` listener; the host's listener-count and
  disposal contract should remain one listener installed by `wireGates`.

### Chrome, layout, and invalidation

* Add `setOperatorInputRequiredGate`, `clearOperatorInputRequiredGate`, and a
  full-clear teardown helper to `src/tui/shell/chrome.ts`. Each reduces the
  dedicated state and calls `paintChrome` only if the state reference changes.
* Extend the chrome compose key, paint pass, and styled-chunk mapping with the
  formatted input-required line. The compose key must include the composed
  text at current `layout.contentWidth`; otherwise a same-state resize or
  settled item can leave stale text. Use the existing action emphasis for the
  mark/`INPUT REQUIRED` label, normal text for routing/question, dim text for
  count, and faint text for separators. The words themselves must carry the
  meaning without color.
* Add a dedicated one-row `input_required` geometry zone and matching
  `ZoneVisibility.inputRequired` switch. Register it in `ZONE_REGISTRY`,
  desired heights, `COLLAPSE_ORDER`, and `PAINT_ORDER` immediately before
  `prompt`; place it after `worker_wait` so it is directly composer-adjacent.
  Give the new primary-input row the latest optional-collapse priority before
  prompt growth is reclaimed, so it is retained whenever one optional strip
  can be retained. Do not repurpose `worker_wait` or change its collapse
  semantics.
* Extend shell construction and internals with a dedicated
  `inputRequiredRow`, state field, initial empty value, render-tree insertion,
  and layout application that sets height/visibility from
  `layout.heights.input_required`. Extend the chrome visibility synchronizer
  to toggle `inputRequired` only when the formatted line becomes non-empty or
  empty. As with worker wait, the row consumes transcript/chrome budget, not
  `prompt` height, and `relayout` force-repaints it after width changes.

## File-by-file implementation plan

### Phase 1 — provenance and pure state (no UI behavior changes yet)

1. **Modify `src/tui/gate-events.ts`**
   * Declare/export the narrow primary-`ask_operator` source marker/type and
     add the optional source field to `OperatorGateEvent` with documentation
     that it is minted by the primary session, not inferred by the TUI.
   * Add a small predicate if it removes repeated source comparisons from
     wiring/reducer code; it must fail closed for missing/unknown values.
2. **Modify `src/tui/runner/session.ts`**
   * Stamp only the primary `onOperatorGate` event with the marker.
   * Leave the MCP trust `OperatorGateEvent` unmarked and leave all approval
     budget, timeout, signal, random ID, and resolver code as-is.
3. **Create `src/tui/operator-input-required.ts`**
   * Implement the pure keyed state/reducer/formatter described above with no
     EventEmitter, shell, overlay, clock, or side effect imports.
4. **Create `src/tui/operator-input-required.test.ts`**
   * Cover empty state; one marked event; duplicate same-ID idempotence and
     same-reference result; two IDs and `+N`; ID-safe removal; removing unknown
     or already removed IDs; selection fallback; control/newline sanitization;
     and every width fitting the one-row budget.
   * Add negative admission cases for unmarked operator events, an MCP-trust
     shaped event, permission-like data, and empty IDs. These tests prove
     filtering occurs by source marker rather than by incidental copy.

**Phase verification (after implementation):**
`bun test src/tui/operator-input-required.test.ts`

### Phase 2 — gate lifecycle bridge

1. **Modify `src/tui/gate-wire.ts`**
   * Add the narrowly typed primary operator admission/settlement hook(s),
     preserve existing default hooks, and emit them only for valid marked
     primary `ask_operator` events.
   * Admit before queue/open so a blocked overlay cannot hide outstanding
     state; remove exactly once inside `settleOnce` so every settle route and
     disposal uses identical lifecycle accounting.
   * Do not modify permission-gate behavior, `permissionQueue`, approval
     reconciliation, or `ask_director` behavior.
2. **Modify `src/tui/gate-wire.test.ts`**
   * Assert a marked primary event emits one admission callback and one
     settlement callback for option, custom text, Esc, timeout, aborted signal,
     queued cancellation, and host-dispose teardown.
   * Assert duplicate settlement/callback attempts do not double-remove; a
     first ID settling cannot remove a second queued/live ID.
   * Assert generic/unmarked events and an MCP-trust-shaped event retain their
     current overlay behavior but never invoke input-required hooks. Re-run
     existing tests as regression proof for permissions and overlay FIFO.
3. **Modify `src/tui/product-host.ts` and `src/tui/product-host.test.ts`**
   * Bind the new `wireGates` hooks to the shell chrome setters at host mount.
   * Verify host disposal still removes all event listeners and that it drains
     a marked outstanding gate without painting after shell destruction. Do
     not install a second `operator.gate` subscription.

**Phase verification (after implementation):**
`bun test src/tui/gate-wire.test.ts src/tui/product-host.test.ts`

### Phase 3 — composer-adjacent chrome and geometry

1. **Modify `src/tui/geometry/zones.ts` and `src/tui/geometry/resolve.ts`**
   * Register/resolve the dedicated optional `input_required` row and public
     `inputRequired` visibility field; update type-complete height records,
     paint order, and collapse order.
2. **Modify `src/tui/shell/internals.ts`, `src/tui/shell/index.ts`, and
   `src/tui/shell/chrome.ts`**
   * Add shell state/renderable initialization and lifecycle-safe setters.
   * Compose, theme, seat, resize, hide, and relayout the new row as specified
     above, leaving `workerWait` untouched.
3. **Create `src/tui/operator-input-required-chrome.test.ts`**
   * Positive frame tests: one marked primary ask paints exactly one
     `INPUT REQUIRED` row directly above the prompt border; the question and
     count appear at useful widths; prompt height is unchanged; a modal may
     remain open while the row is visible; and two events deduplicate/count
     correctly.
   * Persistence tests: transcript appends, scroll, typing, flash/forced
     repaint, relayout/resizing, and live theme switching preserve the strip.
     For both dark and light themes, capture spans and assert action/text/dim
     roles use current `UI` palette values rather than hard-coded colors.
   * Settlement tests: settling one of two leaves the other; final option,
     custom answer, Esc, timeout, abort, and teardown restore normal geometry
     with no row or stale text.
   * Negative frame tests: MCP/unmarked operator gates, permission gate,
     worker `ask_director`/`PendingAskWake`, OAuth/credential UI, and ordinary
     session activity do not make an `INPUT REQUIRED` row. Existing
     `worker-wait-chrome.test.ts` remains the ownership regression for its
     separate `WORKER WAITING` row.
4. **Modify existing geometry/chrome repaint tests only if their exhaustive
   zone/height fixtures require the new zone** (`src/tui/geometry/*.test.ts`,
   `src/tui/chrome-repaint.test.ts`, or `src/tui/margins.test.ts`). Update
   expectations to include the explicit zero-height default and assert short
   layouts still sum to terminal height and collapse without overlap.

**Phase verification (after implementation):**
`bun test src/tui/operator-input-required-chrome.test.ts src/tui/worker-wait-chrome.test.ts src/tui/chrome-repaint.test.ts src/tui/margins.test.ts`

### Phase 4 — primary-session integration regression

1. **Add/update the closest TUI-session integration test seam** (prefer an
   existing runner/session test; create `src/tui/runner/session.operator-input-required.test.ts`
   only if no existing seam can invoke the primary toolset callback).
   * Capture the emitted primary `ask_operator` event and assert it carries the
     marker, unique ID, existing options/question/resolver/timeout/signal.
   * Capture MCP trust event creation and assert it remains unmarked.
   * Drive the event through the mounted host to prove primary ask admission,
     modal behavior, and final strip removal compose together without changing
     event routing.
2. **Run the focused combined suite, then static checks.**

**Phase verification (after implementation):**
```sh
bun test src/tui/operator-input-required.test.ts \
  src/tui/operator-input-required-chrome.test.ts \
  src/tui/gate-wire.test.ts \
  src/tui/product-host.test.ts \
  src/tui/worker-wait.test.ts \
  src/tui/worker-wait-chrome.test.ts
bun run typecheck
bun run lint
```

## Explicit non-goals / exclusions

* Do not change `ask_director`, `pendingAskWake`, fleet wake/resurface,
  `send_input`, or the existing **WORKER WAITING** reducer/ownership model.
* Do not change permission-gate queue/reconciliation, permission prompts,
  approval decisions, or MCP trust behavior beyond ensuring MCP events remain
  excluded from this display state.
* Do not change OAuth, credential recovery, provider connection, terminal
  routing, or authorization behavior.
* Do not add a clickable strip, an alternate answer form, keyboard shortcut,
  focus target, notification/toast, transcript echo, persistence across process
  restart, or new operator event channel.
* Do not alter overlay selection mapping, free-text semantics, Esc semantics,
  timeout duration, abort behavior, queue order, or session bridge
  `gateOpened`/`gateClosed` accounting.

## Risks and rollback

* **Risk: a marker is added too broadly.** Mitigate with a fail-closed marker
  predicate and explicit MCP/unmarked negative tests. Roll back by removing the
  marker emission/hook binding; ordinary modal behavior remains intact.
* **Risk: one settlement path leaks a row.** Keep all removal inside the
  existing `settleOnce`/teardown funnel and test every route. If a new path is
  discovered, route it through `settleOnce` rather than adding an independent
  shell cleanup.
* **Risk: an added row causes stale/overlapping chrome.** Use a registered
  geometry zone, visibility-triggered relayout, compose-key text, and forced
  resize repaint. If layout pressure becomes unacceptable, the feature can be
  disabled solely by never admitting the source marker; no overlay, resolver,
  or answer contract needs rollback.
* **Risk: coupling with worker waiting or permission gates.** Preserve separate
  state fields and event filters; focused existing suites are mandatory before
  merge.

