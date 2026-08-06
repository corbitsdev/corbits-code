/**
 * The prompt box's border, and the metadata it carries.
 *
 * The box has no bars above or below it: the model name rides the top rule and
 * the workspace (directory + git branch) rides the bottom one, so both cost
 * zero rows. The rule breaks around each label and resumes on the far side,
 * which is what makes the label read as part of the frame rather than as text
 * that happens to sit on it.
 *
 * Pure: text in, ordered parts out. The shell colours the parts and swaps the
 * `brand` part for the animated lockup cells, which is why a placeholder of the
 * lockup's exact width is passed in rather than the cells themselves.
 */

import { stringWidth } from "../tui/view/height.js"

/** Rounded box drawing, all single-cell. */
export const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const

/**
 * `rule` is frame, `label` is metadata, `brand` is the lockup's reserved run.
 * The shell paints each role differently; nothing else distinguishes them.
 */
export type RuleRole = "rule" | "label" | "brand"

export type RulePart = {
  readonly text: string
  readonly role: RuleRole
}

export type RuleInput = {
  readonly width: number
  readonly corners: readonly [string, string]
  /** Left-hand run (the lockup). Dropped first when the rule cannot seat both. */
  readonly brand?: string
  /** Right-aligned label. Dropped last: it is information, the mark is not. */
  readonly label?: string
}

/** Rule cells held between a corner and the nearest label. */
const RULE_MARGIN = 1

/** Rule cells held between the brand run and the label. */
const RULE_GAP = 1

function widthOf(parts: readonly RulePart[]): number {
  let total = 0
  for (const part of parts) total += stringWidth(part.text)
  return total
}

function dashes(count: number): string {
  return BORDER.horizontal.repeat(Math.max(0, count))
}

/**
 * Compose one border rule. Labels are dropped, never truncated mid-glyph: a
 * half-written label corrupts the frame, a missing one just reads as a plain
 * rule. The brand goes before the label because the label carries information.
 */
export function composeRule(input: RuleInput): readonly RulePart[] {
  const width = Math.max(0, Math.floor(input.width))
  const [open, close] = input.corners
  if (width <= 0) return []
  if (width <= 2) {
    return [{ text: (open + close).slice(0, width), role: "rule" }]
  }

  const label = input.label?.trim() ?? ""
  const brand = input.brand ?? ""
  const inner = width - 2

  const labelCell = label.length > 0 ? ` ${label} ` : ""
  const brandCell = brand.length > 0 ? ` ${brand} ` : ""
  const labelCost = stringWidth(labelCell)
  const brandCost = stringWidth(brandCell)

  const withBoth =
    brandCost > 0 &&
    labelCost > 0 &&
    inner >= RULE_MARGIN * 2 + RULE_GAP + brandCost + labelCost
  if (withBoth) {
    const fill = inner - RULE_MARGIN * 2 - brandCost - labelCost
    return [
      { text: open, role: "rule" },
      { text: dashes(RULE_MARGIN), role: "rule" },
      { text: brandCell, role: "brand" },
      { text: dashes(fill), role: "rule" },
      { text: labelCell, role: "label" },
      { text: dashes(RULE_MARGIN), role: "rule" },
      { text: close, role: "rule" },
    ]
  }

  const only = labelCost > 0 ? labelCell : brandCell
  const onlyRole: RuleRole = labelCost > 0 ? "label" : "brand"
  const onlyCost = stringWidth(only)
  if (onlyCost > 0 && inner >= RULE_MARGIN * 2 + onlyCost) {
    return [
      { text: open, role: "rule" },
      { text: dashes(inner - RULE_MARGIN - onlyCost), role: "rule" },
      { text: only, role: onlyRole },
      { text: dashes(RULE_MARGIN), role: "rule" },
      { text: close, role: "rule" },
    ]
  }

  return [
    { text: open, role: "rule" },
    { text: dashes(inner), role: "rule" },
    { text: close, role: "rule" },
  ]
}

/** Flatten a rule to plain text — what the shape tests read. */
export function ruleText(parts: readonly RulePart[]): string {
  return parts.map((part) => part.text).join("")
}

/** True when the composed rule is an unbroken run of frame characters. */
export function isPlainRule(parts: readonly RulePart[]): boolean {
  return parts.every((part) => part.role === "rule")
}

/** Total columns a composed rule occupies. */
export function ruleWidth(parts: readonly RulePart[]): number {
  return widthOf(parts)
}

/** Replace the operator's home directory with `~`. */
export function abbreviateHome(path: string, home: string): string {
  if (home.length === 0) return path
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export type WorkspaceLabelInput = {
  readonly cwd: string
  readonly branch?: string | null
  readonly home?: string
  /** Columns the label may occupy. */
  readonly maxWidth: number
}

/**
 * `~/abklabs/corbits-code (main)`, shortened from the left so the branch — the
 * part that changes and the part a mistake is expensive in — always survives.
 */
export function composeWorkspaceLabel(input: WorkspaceLabelInput): string {
  const max = Math.max(0, Math.floor(input.maxWidth))
  const branch = input.branch?.trim() ?? ""
  const suffix = branch.length > 0 ? ` (${branch})` : ""
  const path = abbreviateHome(input.cwd.trim(), input.home ?? "")
  if (path.length === 0) return branch.length > 0 ? `(${branch})` : ""

  const full = `${path}${suffix}`
  if (stringWidth(full) <= max) return full

  const room = max - stringWidth(suffix)
  const truncated = truncateFromLeft(path, room)
  if (truncated.length > 0) return `${truncated}${suffix}`
  // The path no longer earns its columns; the branch alone still does.
  const bare = branch.length > 0 ? `(${branch})` : ""
  return stringWidth(bare) <= max ? bare : ""
}

/** Keep the tail of a path, marking the elision with a leading ellipsis. */
function truncateFromLeft(path: string, maxWidth: number): string {
  if (maxWidth <= 1) return ""
  if (stringWidth(path) <= maxWidth) return path
  const segments = path.split("/")
  for (let start = 1; start < segments.length; start++) {
    const candidate = `…/${segments.slice(start).join("/")}`
    if (stringWidth(candidate) <= maxWidth) return candidate
  }
  const tail = segments[segments.length - 1] ?? ""
  const candidate = `…${tail.slice(Math.max(0, tail.length - (maxWidth - 1)))}`
  return stringWidth(candidate) <= maxWidth ? candidate : ""
}
