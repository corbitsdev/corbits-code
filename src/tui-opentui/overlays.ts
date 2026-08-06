/**
 * Wave 5 primary overlays — permissions, operator question, model/provider.
 * Pure content builders + open helpers on the shared list/focus/geometry kit.
 */

import type {
  AppShell,
  ItemDescription,
  OverlaySelection,
  PrimaryOverlayKind,
} from "./shell.js"
import type { KeyEvent } from "@opentui/core"
import { wrapOverlayText } from "./overlay-body.js"
import { openListOverlay } from "./shell.js"

export type { OverlaySelection, PrimaryOverlayKind }

/** Fixture: 30 permission options (acceptance scenario 2). */
export function makePermissionItems(count = 30): readonly string[] {
  const n = Math.max(1, Math.floor(count))
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return "Allow once"
    if (i === 1) return "Allow session"
    if (i === 2) return "Always allow this tool"
    if (i === 3) return "Deny"
    return `Allow tool call #${i - 3}`
  })
}

/** Fixture: long operator question + many choices (acceptance scenario 3). */
export function makeOperatorQuestion(): {
  readonly body: string
  readonly choices: readonly string[]
} {
  const body = [
    "The agent wants to run a destructive command on the working tree.",
    "Review the plan carefully — this cannot be undone from the TUI.",
    "",
    "Proposed: git reset --hard origin/main && rm -rf node_modules",
    "Files at risk: 128 modified, 12 untracked.",
    "Continue only if you accept discarding local work.",
  ].join("\n")
  const choices = [
    "Cancel — keep working tree",
    "Allow this once",
    "Allow for this session",
    "Always allow git reset",
    "Open diff first",
    "Ask again later",
    "Switch to dry-run",
    "Abort agent run",
  ]
  return { body, choices }
}

/** Fixture: model/provider picker list. */
export function makeModelPickerItems(): readonly string[] {
  return [
    "anthropic / claude-sonnet-4",
    "anthropic / claude-opus-4",
    "openai / gpt-5",
    "openai / gpt-5-mini",
    "google / gemini-2.5-pro",
    "google / gemini-2.5-flash",
    "xai / grok-3",
    "local / ollama-llama3.3",
    "codex / o3",
    "codex / o4-mini",
  ]
}

/** Wrap overlay body text to terminal width on word boundaries (no paint). */
export function wrapOverlayBody(
  text: string,
  width: number,
  maxLines = 8,
): readonly string[] {
  return wrapOverlayText(text, width, maxLines)
}

export type OpenPermissionsOpts = {
  readonly items?: readonly string[]
  /** Stable ids aligned with `items` (e.g. ApprovalScope.id). */
  readonly itemIds?: readonly string[]
  readonly activeIndex?: number
  /** Formatted approval context painted above the choices. */
  readonly body?: string
  /** Per-open accept; host binds resolve(ApprovalOutcome). */
  readonly onAccept?: (selection: OverlaySelection) => void
  /** Per-open expand/collapse of collapsed command payloads. */
  readonly onToggleExpand?: () => void
}

export function openPermissionsOverlay(
  shell: AppShell,
  opts?: OpenPermissionsOpts,
): void {
  const items = opts?.items ?? makePermissionItems(30)
  openListOverlay(shell, {
    kind: "permissions",
    title: "permissions",
    items,
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-permissions",
    ...(opts?.body !== undefined ? { body: opts.body } : {}),
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onToggleExpand !== undefined
      ? { onToggleExpand: opts.onToggleExpand }
      : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
  })
}

export type OpenOperatorOpts = {
  readonly body?: string
  readonly choices?: readonly string[]
  readonly itemIds?: readonly string[]
  readonly activeIndex?: number
  /** Per-open accept; host binds OperatorResult mapping. */
  readonly onAccept?: (selection: OverlaySelection) => void
  /** Per-open free-text answer; host binds the custom OperatorResult. */
  readonly onTextAnswer?: (text: string) => void
}

/**
 * Line appended to the question when the operator can neither pick nor type.
 * The overlay must always say what its one available action is rather than
 * offering "Enter choose" against an empty list.
 */
const NO_WAY_TO_ANSWER =
  "No options were offered and this question takes no typed answer. Press Esc to dismiss it."

export function openOperatorOverlay(
  shell: AppShell,
  opts?: OpenOperatorOpts,
): void {
  const fixture = makeOperatorQuestion()
  const choices = opts?.choices ?? fixture.choices
  const body = opts?.body ?? fixture.body
  const stranded = choices.length === 0 && opts?.onTextAnswer === undefined
  openListOverlay(shell, {
    kind: "operator",
    title: "operator question",
    body: stranded ? `${body}\n\n${NO_WAY_TO_ANSWER}` : body,
    items: choices,
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-operator",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
    ...(opts?.onTextAnswer !== undefined
      ? { onTextAnswer: opts.onTextAnswer }
      : {}),
  })
}

export type OpenModelPickerOpts = {
  readonly items?: readonly string[]
  /** Stable model/provider ids aligned with `items`. */
  readonly itemIds?: readonly string[]
  readonly activeIndex?: number
  /** Per-open accept; host binds model switch. */
  readonly onAccept?: (selection: OverlaySelection) => void
  /** Description-zone source, keyed by the focused row's id. */
  readonly describe?: (itemId: string) => ItemDescription | null
  /** Bare-key claim on the focused row (e.g. `f` to toggle favorite). */
  readonly onAction?: (itemId: string, key: KeyEvent) => boolean
}

export function openModelPickerOverlay(
  shell: AppShell,
  opts?: OpenModelPickerOpts,
): void {
  openListOverlay(shell, {
    kind: "model_picker",
    title: "model / provider",
    items: opts?.items ?? makeModelPickerItems(),
    activeIndex: opts?.activeIndex ?? 0,
    frameId: "overlay-model",
    ...(opts?.itemIds !== undefined ? { itemIds: opts.itemIds } : {}),
    ...(opts?.onAccept !== undefined ? { onAccept: opts.onAccept } : {}),
    ...(opts?.describe !== undefined ? { describe: opts.describe } : {}),
    ...(opts?.onAction !== undefined ? { onAction: opts.onAction } : {}),
  })
}
