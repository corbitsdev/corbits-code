/**
 * Pure gate wiring: PermissionRequest / operator options → overlay list rows
 * and reverse mapping selection → ApprovalOutcome / OperatorResult.
 * Hosts open overlays with the returned items/itemIds and resolve via these helpers.
 */

import type { EventEmitter } from "node:events"
import type { OperatorResult } from "../agent/tools.js"
import { openOperatorOverlay, openPermissionsOverlay } from "./overlays.js"
import type {
  ApprovalOutcome,
  ApprovalScope,
  PermissionRequest,
} from "../permission/types.js"
import type { AppShell, OverlaySelection } from "./shell.js"
import { appendStreamRow } from "./shell.js"

/** Stable sentinel ids for the always-present deny / once rows. */
export const PERMISSION_DENY_ID = "__deny__" as const
export const PERMISSION_ONCE_ID = "__once__" as const

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

/** Compact multi-line body for stream / overlay context (no paint). */
export function permissionBodyFromRequest(
  request: PermissionRequest,
): string {
  return [
    request.tool,
    request.action,
    request.subject,
    request.agentLabel ? `agent: ${request.agentLabel}` : "",
    request.notice ?? "",
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
    const body = permissionBodyFromRequest(ev.request)

    openPermissionsOverlay(shell, {
      items: choices.items,
      itemIds: choices.itemIds,
      onAccept: (sel: OverlaySelection) => {
        ev.resolve(
          approvalOutcomeFromSelection(choices, {
            index: sel.index,
            ...(sel.id !== undefined ? { id: sel.id } : {}),
          }),
        )
      },
    })
    if (body.length > 0) {
      appendStreamRow(shell, {
        role: "system",
        text: body.slice(0, 500),
        meta: "permission",
      })
    }
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
