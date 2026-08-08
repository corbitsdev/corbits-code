/**
 * Pure gate wiring: PermissionRequest / operator options → overlay list rows
 * and reverse mapping selection → ApprovalOutcome / OperatorResult.
 * Hosts open overlays with the returned items/itemIds and resolve via these helpers.
 */

import type { EventEmitter } from "node:events"
import type { OperatorResult } from "../agent/tools.js"
import { formatCommandForApproval, middleEllipsis } from "./command-display.js"
import { openOperatorOverlay, openPermissionsOverlay } from "./overlays.js"
import type {
  ApprovalOutcome,
  ApprovalScope,
  PermissionRequest,
} from "../permission/types.js"
import type { AppShell, OverlaySelection } from "./shell.js"
import {
  appendStreamRow,
  closeInsetOverlay,
  onOverlayClosed,
  setOverlayBody,
} from "./shell.js"
import { EXPAND_KEY } from "./stream.js"
import type {
  OperatorGateEvent,
  PermissionGateEvent,
} from "../tui/gate-events.js"
import {
  createPermissionRequestQueue,
  wirePermissionGrantReconciliation,
} from "../permission/queue.js"

/** Stable sentinel ids for the always-present deny / once rows. */
export const PERMISSION_DENY_ID = "__deny__" as const
export const PERMISSION_ONCE_ID = "__once__" as const

/**
 * Expand/collapse chord for collapsed payloads. Scoped to the open permission
 * overlay rather than registered in SHELL_SHORTCUTS: the overlay is modal, so
 * a bare letter is free there, and Ctrl+O (the Ink-era chord) is the command
 * palette in this shell. Shared with the transcript's collapsed rows so the
 * product has one expand idiom.
 */
export const PERMISSION_EXPAND_KEY = EXPAND_KEY

export type PermissionGateChoices = {
  readonly items: readonly string[]
  readonly itemIds: readonly string[]
  /** Parallel to items — index into this on accept. */
  readonly outcomes: readonly ApprovalOutcome[]
}

export type GateSelection = {
  readonly index: number
  /** When present, preferred over index for outcome lookup. */
  readonly id?: string
}

/**
 * Build permission overlay rows from a live PermissionRequest.
 * Order: Reject → Accept once → request.scopes (label + optional hint).
 */
export function permissionChoicesFromRequest(
  request: PermissionRequest,
): PermissionGateChoices {
  const items: string[] = []
  const itemIds: string[] = []
  const outcomes: ApprovalOutcome[] = []

  items.push("Reject")
  itemIds.push(PERMISSION_DENY_ID)
  outcomes.push({ allow: false })

  items.push("Accept once")
  itemIds.push(PERMISSION_ONCE_ID)
  outcomes.push({ allow: true })

  for (const scope of request.scopes) {
    const label = scope.hint
      ? `${scope.label} (${scope.hint})`
      : scope.label
    items.push(label)
    itemIds.push(scope.id)
    outcomes.push({
      allow: true,
      ...(scope.pattern !== null ? { persist: scope as ApprovalScope } : {}),
    })
  }

  return { items, itemIds, outcomes }
}

/**
 * Map overlay selection index/id → ApprovalOutcome.
 * Unknown / out-of-range defaults to deny (safe closed).
 */
export function approvalOutcomeFromSelection(
  choices: PermissionGateChoices,
  selection: GateSelection,
): ApprovalOutcome {
  if (selection.id !== undefined) {
    const byId = choices.itemIds.indexOf(selection.id)
    if (byId >= 0) {
      return choices.outcomes[byId] ?? { allow: false }
    }
  }
  return choices.outcomes[selection.index] ?? { allow: false }
}

export type PermissionBodyOpts = {
  /** Print collapsed payloads in full under their placeholder. */
  readonly expanded?: boolean
  /** Append the expand/collapse affordance line (overlay only). */
  readonly hint?: boolean
}

/**
 * Compact multi-line body for stream / overlay context (no paint).
 * The subject is rendered through the approval formatter so a chained command
 * shows one numbered line per segment and bulk payloads collapse to a
 * placeholder the operator can expand before approving.
 */
export function permissionBodyFromRequest(
  request: PermissionRequest,
  opts?: PermissionBodyOpts,
): string {
  const display = formatCommandForApproval(request.subject, {
    expanded: opts?.expanded === true,
  })
  const hint =
    opts?.hint === true && display.payloadCount > 0
      ? opts.expanded === true
        ? `${PERMISSION_EXPAND_KEY} collapse payloads`
        : `${PERMISSION_EXPAND_KEY} expand ${display.payloadCount} collapsed payload${display.payloadCount === 1 ? "" : "s"}`
      : ""
  return [
    request.tool,
    request.action,
    ...display.lines,
    request.agentLabel ? `agent: ${request.agentLabel}` : "",
    request.notice ?? "",
    hint,
  ]
    .filter((l) => l.length > 0)
    .join("\n")
}

export type OperatorGateChoices = {
  readonly items: readonly string[]
  readonly itemIds: readonly string[]
}

/**
 * Operator options → list rows. itemIds are decimal index strings ("0", "1", …)
 * so hosts can round-trip without a parallel outcomes array.
 */
export function operatorChoicesFromOptions(
  options: readonly string[],
): OperatorGateChoices {
  return {
    items: [...options],
    itemIds: options.map((_, i) => String(i)),
  }
}

/**
 * Map selection → OperatorResult.
 * Out-of-range or missing option → cancel (safe closed).
 */
export function operatorResultFromSelection(
  options: readonly string[],
  selection: GateSelection,
): OperatorResult {
  let index = selection.index
  if (selection.id !== undefined) {
    const parsed = Number.parseInt(selection.id, 10)
    if (
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed < options.length &&
      String(parsed) === selection.id
    ) {
      index = parsed
    }
  }
  if (index < 0 || index >= options.length) {
    return { kind: "cancel" }
  }
  return { kind: "option", index }
}

export function operatorCancelResult(): OperatorResult {
  return { kind: "cancel" }
}

export function operatorCustomResult(text: string): OperatorResult {
  return { kind: "custom", text }
}

/** Label of the choice a selection lands on, or null when it maps to nothing. */
function chosenLabel(
  choices: PermissionGateChoices,
  selection: GateSelection,
): string | null {
  if (selection.id !== undefined) {
    const byId = choices.itemIds.indexOf(selection.id)
    if (byId >= 0) return choices.items[byId] ?? null
  }
  return choices.items[selection.index] ?? null
}

/**
 * Write the ask and the answer to the transcript, once the operator has
 * decided. Deferred rather than emitted at gate time: while the overlay is up
 * it is already showing this text directly below the row, and printing it
 * twice reads as two separate requests. Scrollback still ends up complete.
 */
function recordDecision(
  shell: AppShell,
  request: PermissionRequest,
  choices: PermissionGateChoices,
  selection: GateSelection,
): void {
  // Collapsing runs first, so this cap rarely bites; when it does,
  // middleEllipsis keeps the tail of the chain visible instead of clipping the
  // last segments away entirely.
  const body = middleEllipsis(permissionBodyFromRequest(request), 500)
  const label = chosenLabel(choices, selection)
  const text = label === null ? body : `${body}\n→ ${label}`
  if (text.length === 0) return
  appendStreamRow(shell, { role: "system", text, meta: "permission" })
}

/**
 * Write a row for a request settled with no accept/cancel/autoDeny call site
 * of its own to hang a record onto: reconcile() (a newly-minted grant
 * covering this queued request) and drain() (session teardown denying
 * whatever is still queued) both settle the queue entry directly. Every
 * other terminal path (accept, Esc, timeout, abort) already writes its own
 * row at its own call site. Without this, the operator's only trace of the
 * highest-consequence event in the queue — a request that ran, or was
 * dropped, without ever being shown — is the transient grant-recorded flash
 * (nothing at all for teardown), gone once it scrolls off.
 */
function recordSilentSettle(
  shell: AppShell,
  request: PermissionRequest,
  outcome: ApprovalOutcome,
): void {
  const body = middleEllipsis(permissionBodyFromRequest(request), 500)
  const label = outcome.allow
    ? "Auto-approved (already granted)"
    : "Denied (session ended)"
  appendStreamRow(shell, {
    role: "system",
    text: `${body}\n→ ${label}`,
    meta: "permission",
  })
}

/**
 * Write the operator's question and answer to the transcript, once decided.
 * Mirrors recordDecision: the overlay already shows this text while it is
 * open, so an immediate echo would print every operator question twice.
 */
function recordOperatorDecision(
  shell: AppShell,
  question: string,
  label: string,
): void {
  const body = middleEllipsis(question, 500)
  const text = `${body}\n→ ${label}`
  appendStreamRow(shell, { role: "system", text, meta: "operator" })
}

/**
 * Blocked-ness is domain state, not a paint detail: the turn watchdog and the
 * painter both need to know a gate is outstanding, whether or not it has
 * reached the screen yet. This is the only place that sees a gate's full
 * lifecycle (raised, possibly queued, eventually resolved), so it is the one
 * that reports it — callers fold the pair into their own turn state.
 */
export type GateLifecycleHooks = {
  /** A gate was raised — queued or opened, whichever comes first. */
  readonly onGateOpened: () => void
  /** A previously raised gate resolved. */
  readonly onGateClosed: () => void
}

const NOOP_GATE_HOOKS: GateLifecycleHooks = {
  onGateOpened: () => {},
  onGateClosed: () => {},
}

/**
 * Wrap a gate's `resolve` so `onGateClosed` fires exactly once no matter
 * which of accept / cancel / auto-deny settles it first.
 */
function onceClosed<T>(
  onGateClosed: () => void,
  resolve: (value: T) => void,
): (value: T) => void {
  let closed = false
  return (value) => {
    if (!closed) {
      closed = true
      onGateClosed()
    }
    resolve(value)
  }
}

/**
 * Subscribe the permission/operator gate events to the shell's overlays.
 * Returns a dispose function that removes exactly the listeners this call added.
 */
export function wireGates(
  emitter: EventEmitter,
  shell: AppShell,
  hooks: GateLifecycleHooks = NOOP_GATE_HOOKS,
): () => void {
  // The shell has one overlay host, and opening onto a busy one is a no-op.
  // Gates cannot be dropped that way — a lost ask_operator blocks the run with
  // nothing on screen to answer — so a gate that arrives while another overlay
  // is up waits here and opens as soon as the host frees up.
  const pending: Array<() => void> = []
  // Owns queued-approval reconciliation (see src/permission/queue.ts): this
  // host only enqueues requests and renders whatever settle calls the queue
  // hands back — it never decides which grant covers which request.
  const permissionQueue = createPermissionRequestQueue()
  const disposeReconciliation = wirePermissionGrantReconciliation(
    emitter,
    permissionQueue,
  )
  // Operator gates have no queue module of their own (unlike permission
  // requests, which register with permissionQueue so dispose can drain
  // them) — each one registers its own teardown callback here for the
  // lifetime it is outstanding, so a gate still queued behind another
  // overlay at session teardown still settles instead of hanging its
  // awaited promise forever. Every settle path (onAccept, onTextAnswer,
  // onCancel, settleOnce) is responsible for deregistering its own entry
  // before resolving — a future settle path that forgets this leaks its
  // gate into dispose's teardown sweep after it has already resolved
  // (harmless, since `settled` guards the double-resolve, but wasted work).
  const operatorTeardowns = new Set<() => void>()
  // Bumped every time any gate (permission or operator) opens on the shared
  // host. A settle path that only knows "my overlay was opened" cannot tell
  // whether the host has since moved on to a newer one — the shell closes an
  // accepted/cancelled overlay and may open the next queued gate before that
  // gate's own settle callback runs — and closing blind would tear down that
  // newer overlay instead of its own. Comparing the generation captured at
  // open-time against the current one answers that directly, so correctness
  // never rests on remembering shell.ts's close-before-callback ordering at
  // each call site. openHost is the only place an overlay opens, so it is
  // the only place this counter needs to change.
  let overlayGeneration = 0

  function openHost(open: () => void): void {
    overlayGeneration++
    open()
  }

  function openOrQueue(open: () => void): void {
    if (shell.overlayList !== null) {
      pending.push(open)
      return
    }
    openHost(open)
  }

  function unqueue(open: () => void): void {
    const idx = pending.indexOf(open)
    if (idx >= 0) pending.splice(idx, 1)
  }

  const disposeClosed = onOverlayClosed(shell, () => {
    const next = pending.shift()
    if (next) openHost(next)
  })

  function onPermission(ev: PermissionGateEvent): void {
    hooks.onGateOpened()
    const resolve = onceClosed(hooks.onGateClosed, ev.resolve)
    const choices = permissionChoicesFromRequest(ev.request)
    const collapsedBody = permissionBodyFromRequest(ev.request, { hint: true })
    // Nothing was collapsed → no expand affordance, so the overlay leaves the
    // bare key unclaimed.
    const collapsedAnything =
      formatCommandForApproval(ev.request.subject).payloadCount > 0
    let expanded = false
    // Set only while this gate's own overlay is the one on screen — see
    // overlayGeneration above for why the settle path checks it against the
    // current generation instead of trusting this alone.
    let openedGeneration: number | undefined

    // The queue is the single settle guard: once an id is removed (accept,
    // cancel, timeout, abort, or a reconciled grant), a later call is a
    // no-op instead of double-resolving. Its resolve callback settles
    // through the onceClosed-wrapped `resolve` (not ev.resolve directly) so
    // hooks.onGateClosed still fires exactly once regardless of which path
    // drained this entry. Closing the overlay from inside this callback
    // re-invokes the overlay's own onCancel (see shell.ts's
    // closeInsetOverlay, which fires onCancel after notifying close
    // listeners) — settle's return value is how a call site tells that
    // reentrant call apart from the original one, so recordDecision below
    // fires exactly once per gate instead of once per reentry.
    const settle = (outcome: ApprovalOutcome): boolean =>
      permissionQueue.settle(id, outcome)
    // Set immediately before every call to settle() from a known call site
    // (accept, Esc, autoDeny), each of which writes its own row right after.
    // reconcile() and drain() (src/permission/queue.ts) both settle an entry
    // directly, with no call site of their own — the resolve callback below
    // falls back to recordSilentSettle whenever this is still false, so a
    // request that ran, or was dropped, without ever being shown still
    // leaves a trace.
    let recorded = false
    const id = permissionQueue.enqueue(ev.request, (outcome) => {
      clearTimers()
      // Captured before closeInsetOverlay below, which — when this entry is
      // the one on screen — reentrantly invokes this same overlay's onCancel
      // (see the comment on `settle` above) and would otherwise set
      // `recorded` out from under this check before it runs.
      const needsSilentSettleRecord = !recorded
      if (openedGeneration === undefined) {
        unqueue(open)
      } else if (openedGeneration === overlayGeneration) {
        closeInsetOverlay(shell)
      }
      if (needsSilentSettleRecord) recordSilentSettle(shell, ev.request, outcome)
      resolve(outcome)
    })

    const onToggleExpand = (): void => {
      expanded = !expanded
      setOverlayBody(
        shell,
        permissionBodyFromRequest(ev.request, { expanded, hint: true }),
      )
      if (!expanded) return
      // The overlay body is height-capped by geometry, so the authoritative
      // copy of an expanded payload goes to the scrollable transcript — whole,
      // untruncated. Collapsing must never hide text the operator cannot
      // otherwise reach before approving.
      appendStreamRow(shell, {
        role: "system",
        text: permissionBodyFromRequest(ev.request, { expanded: true }),
        meta: "permission",
      })
    }

    const open = (): void => {
      openedGeneration = overlayGeneration
      if (ev.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          autoDeny(ev.timeoutMessage ?? "approval timed out; request denied")
        }, ev.timeoutMs)
      }
      openPermissionsOverlay(shell, {
        items: choices.items,
        itemIds: choices.itemIds,
        body: collapsedBody,
        // recordDecision below is the authoritative transcript row for every
        // terminal path — the overlay's own accept/answer echo would
        // duplicate it.
        echoChoice: false,
        ...(collapsedAnything ? { onToggleExpand } : {}),
        onAccept: (sel: OverlaySelection) => {
          const gateSelection = {
            index: sel.index,
            ...(sel.id !== undefined ? { id: sel.id } : {}),
          }
          recorded = true
          if (settle(approvalOutcomeFromSelection(choices, gateSelection))) {
            recordDecision(shell, ev.request, choices, gateSelection)
          }
        },
        // Esc must settle the awaited promise (as a deny), not abandon it —
        // an unresolved gate hangs the run until the process is killed.
        onCancel: () => {
          const gateSelection = { index: 0, id: PERMISSION_DENY_ID }
          recorded = true
          if (settle(approvalOutcomeFromSelection(choices, gateSelection))) {
            recordDecision(shell, ev.request, choices, gateSelection)
          }
        },
      })
    }

    // Watchdog abort (tool budget expired / parent run cancelled) and the
    // goal-mode timeout both race an operator who may never answer — each
    // must resolve the gate itself rather than leave the overlay (or the
    // queued open) parked forever. Whichever fires first settles the queue
    // entry, which is itself the single-resolve guard, so the other side is
    // simply a no-op once it runs.
    //
    // The goal-mode timeout is display-dependent and arms inside `open`
    // (below), not here: a request sitting behind others in `pending` must
    // not burn its timeout while the operator has never seen it. Abort is not
    // display-dependent — it reflects the tool having already finished or
    // been cancelled, which is true whether or not this gate is on screen —
    // so its listener is registered immediately.
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      ev.signal?.removeEventListener("abort", onAbort)
    }
    const autoDeny = (message: string): void => {
      recorded = true
      if (settle({ allow: false, message })) {
        recordDecision(shell, ev.request, choices, {
          index: 0,
          id: PERMISSION_DENY_ID,
        })
      }
    }
    function onAbort(): void {
      autoDeny("tool no longer running; permission request denied")
    }
    if (ev.signal?.aborted === true) {
      autoDeny("tool no longer running; permission request denied")
      return
    }
    ev.signal?.addEventListener("abort", onAbort, { once: true })

    openOrQueue(open)
  }

  function onOperator(ev: OperatorGateEvent): void {
    hooks.onGateOpened()
    const resolve = onceClosed(hooks.onGateClosed, ev.resolve)
    const choices = operatorChoicesFromOptions(ev.options)
    // Guarded the same way as the permission gate: correctness must not rest
    // on callers of closeInsetOverlay remembering to null the cancel hook
    // before dispatching accept — a future accept-via-close path that forgets
    // would otherwise double-resolve this promise.
    let settled = false
    // Set only while this gate's own overlay is the one on screen — mirrors
    // openedGeneration on the permission path (see its comment above): a
    // settle path that only knows "my overlay was opened" cannot tell
    // whether the host has since moved on to a newer one.
    let openedGeneration: number | undefined

    // Mirrors the permission gate: watchdog abort and the goal-mode timeout
    // both race an operator who may never answer, and unlike the permission
    // path this gate previously had no safety net at all — a queued question
    // behind a stuck overlay hung the run forever. The timeout is
    // display-dependent and arms inside `open` (below); abort is not, so its
    // listener is registered immediately.
    let timer: ReturnType<typeof setTimeout> | undefined
    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      ev.signal?.removeEventListener("abort", onAbort)
    }

    const open = (): void => {
      openedGeneration = overlayGeneration
      if (ev.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          autoCancel(ev.timeoutMessage ?? "Cancelled (timed out)")
        }, ev.timeoutMs)
      }
      openOperatorOverlay(shell, {
        body: ev.question,
        choices: choices.items,
        itemIds: choices.itemIds,
        // recordOperatorDecision below is the authoritative transcript row
        // for every terminal path — the overlay's own accept/answer echo
        // would duplicate it.
        echoChoice: false,
        onAccept: (sel: OverlaySelection) => {
          if (settled) return
          settled = true
          clearTimers()
          operatorTeardowns.delete(teardown)
          recordOperatorDecision(shell, ev.question, sel.label)
          resolve(
            operatorResultFromSelection(ev.options, {
              index: sel.index,
              ...(sel.id !== undefined ? { id: sel.id } : {}),
            }),
          )
        },
        // The ask_operator contract offers a free-form answer, so the overlay
        // must be able to send one back rather than only an option index.
        onTextAnswer: (text: string) => {
          if (settled) return
          settled = true
          clearTimers()
          operatorTeardowns.delete(teardown)
          recordOperatorDecision(shell, ev.question, text)
          resolve(operatorCustomResult(text))
        },
        // Esc must settle the awaited promise (as a cancel), not abandon it —
        // an unresolved gate hangs the run until the process is killed.
        // Esc already closes this overlay through the shell's own key
        // handling, so — unlike autoCancel below — this does not re-invoke
        // closeInsetOverlay itself; doing so would reenter this same
        // onCancel (see the permission gate's identical note on `settle`).
        onCancel: () => {
          if (settled) return
          settled = true
          clearTimers()
          operatorTeardowns.delete(teardown)
          recordOperatorDecision(shell, ev.question, "Cancelled")
          resolve(operatorCancelResult())
        },
      })
    }

    const settleOnce = (label: string, result: OperatorResult): void => {
      if (settled) return
      settled = true
      clearTimers()
      operatorTeardowns.delete(teardown)
      if (openedGeneration === undefined) {
        unqueue(open)
      } else if (openedGeneration === overlayGeneration) {
        closeInsetOverlay(shell)
      }
      recordOperatorDecision(shell, ev.question, label)
      resolve(result)
    }
    const autoCancel = (label: string): void => {
      settleOnce(label, operatorCancelResult())
    }
    const teardown = (): void => {
      autoCancel("Cancelled (session ended)")
    }
    function onAbort(): void {
      autoCancel("Cancelled (tool no longer running)")
    }
    if (ev.signal?.aborted === true) {
      autoCancel("Cancelled (tool no longer running)")
      return
    }
    ev.signal?.addEventListener("abort", onAbort, { once: true })
    operatorTeardowns.add(teardown)

    openOrQueue(open)
  }

  emitter.on("permission.gate", onPermission)
  emitter.on("operator.gate", onOperator)

  return () => {
    emitter.off("permission.gate", onPermission)
    emitter.off("operator.gate", onOperator)
    disposeReconciliation()
    disposeClosed()
    pending.length = 0
    // Deny anything still queued so its awaited evaluate() call never hangs
    // past session teardown.
    permissionQueue.drain()
    // Cancel every outstanding operator gate (queued or displayed) so its
    // awaited resolve() never hangs past session teardown either — the
    // permission-side equivalent of the drain() call above.
    for (const teardown of [...operatorTeardowns]) teardown()
  }
}
