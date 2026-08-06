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
import { appendStreamRow, setOverlayBody } from "./shell.js"
import { EXPAND_KEY } from "./stream.js"

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

type PermissionGateEvent = {
  request: PermissionRequest
  resolve: (outcome: ApprovalOutcome) => void
}

type OperatorGateEvent = {
  question: string
  options: string[]
  resolve: (result: OperatorResult) => void
}

/**
 * Subscribe the permission/operator gate events to the shell's overlays.
 * Returns a dispose function that removes exactly the listeners this call added.
 */
export function wireGates(
  emitter: EventEmitter,
  shell: AppShell,
): () => void {
  function onPermission(ev: PermissionGateEvent): void {
    const choices = permissionChoicesFromRequest(ev.request)
    const collapsedBody = permissionBodyFromRequest(ev.request, { hint: true })
    // Nothing was collapsed → no expand affordance, so the overlay leaves the
    // bare key unclaimed.
    const collapsedAnything =
      formatCommandForApproval(ev.request.subject).payloadCount > 0
    let expanded = false

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

    openPermissionsOverlay(shell, {
      items: choices.items,
      itemIds: choices.itemIds,
      body: collapsedBody,
      ...(collapsedAnything ? { onToggleExpand } : {}),
      onAccept: (sel: OverlaySelection) => {
        const gateSelection = {
          index: sel.index,
          ...(sel.id !== undefined ? { id: sel.id } : {}),
        }
        recordDecision(shell, ev.request, choices, gateSelection)
        ev.resolve(approvalOutcomeFromSelection(choices, gateSelection))
      },
    })
  }

  function onOperator(ev: OperatorGateEvent): void {
    const choices = operatorChoicesFromOptions(ev.options)
    openOperatorOverlay(shell, {
      body: ev.question,
      choices: choices.items,
      itemIds: choices.itemIds,
      onAccept: (sel: OverlaySelection) => {
        ev.resolve(
          operatorResultFromSelection(ev.options, {
            index: sel.index,
            ...(sel.id !== undefined ? { id: sel.id } : {}),
          }),
        )
      },
    })
  }

  emitter.on("permission.gate", onPermission)
  emitter.on("operator.gate", onOperator)

  return () => {
    emitter.off("permission.gate", onPermission)
    emitter.off("operator.gate", onOperator)
  }
}
