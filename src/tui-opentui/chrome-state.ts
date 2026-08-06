/**
 * Live chrome zone formatter for setChromeZones.
 *
 * Pure: structured session state → one-line goal / task / agents strings.
 * Heights stay with geometry (zones max 1 row each); this module never
 * invents row budgets.
 *
 * ## Product host push contract
 *
 * The shell does not poll. The product host owns live state (goal governor,
 * task list, subagent store) and pushes a full snapshot whenever any of those
 * change:
 *
 *   setChromeZones(shell, formatChromeZones(snapshot))
 *
 * Preferred: subscribe to store/governor change events (or a single
 * session-tick emitter) and re-format on each notification. Polling is fine
 * only as a temporary bridge (e.g. 100–250 ms timer while wiring events).
 *
 * Always pass the full snapshot so absent zones clear (`null` hides the zone).
 * Partial object fields mean “no data” → that zone line is null, not left
 * stale. Observe mode can override the agents line via `state.observe`.
 */

import type { ChromeZoneContent } from "./shell.js"

/** Subagent row shape for the agents chrome line (store-agnostic). */
export type ChromeAgentSession = {
  readonly agentId: string
  readonly description: string
  readonly status: "running" | "done" | "failed" | "cancelled"
  /** Current tool while running (optional detail). */
  readonly currentToolName?: string | null
}

/**
 * Goal chrome input — title + optional lifecycle fields.
 * Inactive / cleared / empty title → zone hidden.
 */
export type ChromeGoalState = {
  /** Brief or condition text shown after the phase/status prefix. */
  readonly title: string
  /** Autonomy status: active, paused, achieved, blocked, … */
  readonly status?: string
  /** Lifecycle phase: planning | implementing | reviewing | completed */
  readonly phase?: string
  /** Acceptance progress when criteria exist. */
  readonly progress?: { readonly done: number; readonly total: number } | null
}

/**
 * Task / Work chrome input.
 * Empty title or all-terminal lists → zone hidden when formatting from tasks[].
 */
export type ChromeTaskState = {
  /** Current doing (or next todo) title. */
  readonly title: string
  readonly status?: "todo" | "doing" | "done" | "cancelled"
  /** Other active tasks beyond the current one. */
  readonly remaining?: number
}

/** Lightweight task row for list → compact line. */
export type ChromeTaskRow = {
  readonly title: string
  readonly status: "todo" | "doing" | "done" | "cancelled"
}

/**
 * Full live chrome snapshot. Missing / null fields hide that zone.
 * Prefer pushing a complete snapshot on every update.
 */
export type ChromeLiveState = {
  readonly goal?: ChromeGoalState | null
  /**
   * Compact task line: string shorthand, structured current task, or a list
   * of work rows (formatter picks the active item like Ink TaskView compact).
   */
  readonly task?: ChromeTaskState | ChromeTaskRow[] | string | null
  /** Subagent sessions for the strip summary (running preferred). */
  readonly agents?: readonly ChromeAgentSession[] | null
  /**
   * When set, agents line becomes observe chrome (matches enterSubagentObserve).
   * Pass null/omit when not observing.
   */
  readonly observe?: {
    readonly agentId: string
    readonly description: string
  } | null
}

/** Always-populated result for setChromeZones (null = hide zone). */
export type FormattedChromeZones = {
  readonly goal: string | null
  readonly task: string | null
  readonly agents: string | null
}

const PHASE_SHORT: Record<string, string> = {
  planning: "plan",
  implementing: "impl",
  reviewing: "review",
  completed: "done",
}

/**
 * Format structured live state into chrome zone lines for setChromeZones.
 *
 * Empty / partial / inactive inputs yield null for the corresponding zone
 * so geometry collapses that strip (idleDefault 0).
 */
export function formatChromeZones(state: ChromeLiveState): FormattedChromeZones {
  return {
    goal: formatGoalLine(state.goal),
    task: formatTaskLine(state.task),
    agents: formatAgentsLine(state.agents, state.observe),
  }
}

/**
 * Convenience: format then assign to shell. Equivalent to
 * `setChromeZones(shell, formatChromeZones(state))` when the host already
 * holds a setChromeZones reference.
 */
export function chromeZonesContent(state: ChromeLiveState): ChromeZoneContent {
  return formatChromeZones(state)
}

export function formatGoalLine(
  goal: ChromeGoalState | null | undefined,
): string | null {
  if (goal === null || goal === undefined) return null
  const title = goal.title.trim()
  if (title.length === 0) return null

  const status = goal.status?.trim().toLowerCase()
  if (status === "inactive" || status === "cleared") return null

  if (status === "achieved" || goal.phase === "completed") {
    return compactLine("goal", `completed · ${title}`)
  }

  const parts: string[] = []
  if (goal.phase !== undefined && goal.phase.length > 0) {
    parts.push(PHASE_SHORT[goal.phase] ?? goal.phase)
  }
  const progress = goal.progress
  if (
    progress !== undefined &&
    progress !== null &&
    progress.total > 0
  ) {
    parts.push(`${progress.done}/${progress.total}`)
  }
  if (
    status !== undefined &&
    status.length > 0 &&
    status !== "active"
  ) {
    parts.push(status)
  }
  parts.push(title)
  return compactLine("goal", parts.join(" · "))
}

export function formatTaskLine(
  task: ChromeTaskState | ChromeTaskRow[] | string | null | undefined,
): string | null {
  if (task === null || task === undefined) return null

  if (typeof task === "string") {
    const t = task.trim()
    return t.length === 0 ? null : compactLine("task", t)
  }

  if (Array.isArray(task)) {
    return formatTaskLineFromRows(task)
  }

  const title = task.title.trim()
  if (title.length === 0) return null
  if (task.status === "done" || task.status === "cancelled") return null

  const remaining =
    task.remaining !== undefined && task.remaining > 0
      ? ` (+${task.remaining})`
      : ""
  return compactLine("task", `${title}${remaining}`)
}

function formatTaskLineFromRows(rows: readonly ChromeTaskRow[]): string | null {
  const active = rows.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  )
  if (active.length === 0) return null
  const doing = active.find((t) => t.status === "doing")
  const current = doing ?? active[0]!
  const title = current.title.trim()
  if (title.length === 0) return null
  const remaining = active.length - 1
  const suffix = remaining > 0 ? ` (+${remaining})` : ""
  return compactLine("task", `${title}${suffix}`)
}

export function formatAgentsLine(
  agents: readonly ChromeAgentSession[] | null | undefined,
  observe?: ChromeLiveState["observe"],
): string | null {
  if (observe !== null && observe !== undefined) {
    const id = observe.agentId.trim()
    const desc = observe.description.trim()
    if (id.length === 0 && desc.length === 0) return null
    const label =
      id.length > 0 && desc.length > 0
        ? `${id} — ${desc}`
        : id.length > 0
          ? id
          : desc
    return `observe: ${label}`
  }

  if (agents === null || agents === undefined || agents.length === 0) {
    return null
  }

  const running = agents.filter((s) => s.status === "running")
  const done = agents.filter((s) => s.status === "done").length
  const failed = agents.filter((s) => s.status === "failed").length
  const cancelled = agents.filter((s) => s.status === "cancelled").length

  const parts: string[] = []
  if (running.length > 0) {
    parts.push(`${running.length} live`)
  }
  if (done > 0) parts.push(`${done} done`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (cancelled > 0) parts.push(`${cancelled} cancelled`)

  // Prefer a summary count line; when a single agent is live, add its label.
  if (running.length === 1) {
    const s = running[0]!
    const tool =
      s.currentToolName !== undefined &&
      s.currentToolName !== null &&
      s.currentToolName.length > 0
        ? ` · ${s.currentToolName}`
        : ""
    const label = `${s.agentId}: ${s.description}${tool}`.trim()
    if (label.length > 2) {
      // "agents: 1 live · explore: map callers"
      const summary = parts.length > 0 ? parts.join(" · ") : "1 live"
      return compactLine("agents", `${summary} · ${label}`)
    }
  }

  if (parts.length === 0) {
    // Only terminal sessions present — still show a count so inspect chrome
    // can surface "agents: 2 done" when host passes full listForStrip().
    return compactLine("agents", `${agents.length}`)
  }
  return compactLine("agents", parts.join(" · "))
}

function compactLine(prefix: string, body: string): string {
  const b = body.trim()
  if (b.length === 0) return `${prefix}:`
  // Avoid double-prefix if host already included it.
  if (b.toLowerCase().startsWith(`${prefix}:`)) return b
  return `${prefix}: ${b}`
}

// ---------------------------------------------------------------------------
// Session-shaped → ChromeLiveState (loose mapping for product host push)
// ---------------------------------------------------------------------------

/**
 * Loose goal governor snapshot fields. Accepts GoalSnapshot-like objects
 * without importing agent/goal (brief/condition/criteria/status/phase).
 */
export type ChromeSessionGoal = {
  readonly brief?: string
  readonly condition?: string
  readonly title?: string
  readonly status?: string
  readonly phase?: string
  readonly criteria?: readonly {
    readonly status: string
  }[]
}

/** manage_tasks / Task-shaped row (title + status). */
export type ChromeSessionTask = {
  readonly title: string
  readonly status: "todo" | "doing" | "done" | "cancelled"
}

/**
 * SubAgentSession-shaped strip row. `agentId` preferred; falls back to `id`
 * when the store only exposes a session id.
 */
export type ChromeSessionAgent = {
  readonly agentId?: string
  readonly id?: string
  readonly description: string
  readonly status: "running" | "done" | "failed" | "cancelled"
  readonly currentToolName?: string | null
}

/**
 * Live session bags the product host already holds. Missing fields omit zones.
 */
export type ChromeSessionInput = {
  readonly goal?: ChromeSessionGoal | null
  readonly tasks?: readonly ChromeSessionTask[] | null
  readonly agents?: readonly ChromeSessionAgent[] | null
  readonly observe?: ChromeLiveState["observe"]
}

/**
 * Map real session shapes (goal governor / tasks / subagent store) into
 * ChromeLiveState for `formatChromeZones` / `setChrome`.
 *
 * Pure and store-agnostic — pass whatever the host already has; loose fields
 * are ignored when absent.
 */
export function chromeFromSession(input: ChromeSessionInput): ChromeLiveState {
  const goal = mapSessionGoal(input.goal)
  const task = mapSessionTasks(input.tasks)
  const agents = mapSessionAgents(input.agents)
  const observe = input.observe ?? null

  return {
    ...(goal !== undefined ? { goal } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(observe !== null && observe !== undefined ? { observe } : {}),
  }
}

function mapSessionGoal(
  goal: ChromeSessionGoal | null | undefined,
): ChromeGoalState | null | undefined {
  if (goal === undefined) return undefined
  if (goal === null) return null

  const title = (
    goal.title ??
    goal.brief ??
    goal.condition ??
    ""
  ).trim()
  if (title.length === 0) return null

  const progress = progressFromCriteria(goal.criteria)
  return {
    title,
    ...(goal.status !== undefined ? { status: goal.status } : {}),
    ...(goal.phase !== undefined ? { phase: goal.phase } : {}),
    ...(progress !== undefined ? { progress } : {}),
  }
}

function progressFromCriteria(
  criteria: ChromeSessionGoal["criteria"],
): { done: number; total: number } | undefined {
  if (criteria === undefined || criteria.length === 0) return undefined
  const countable = criteria.filter((c) => c.status !== "cancelled")
  if (countable.length === 0) return undefined
  const done = countable.filter((c) => c.status === "done").length
  return { done, total: countable.length }
}

function mapSessionTasks(
  tasks: readonly ChromeSessionTask[] | null | undefined,
): ChromeTaskRow[] | null | undefined {
  if (tasks === undefined) return undefined
  if (tasks === null) return null
  if (tasks.length === 0) return null
  return tasks.map((t) => ({
    title: t.title,
    status: t.status,
  }))
}

function mapSessionAgents(
  agents: readonly ChromeSessionAgent[] | null | undefined,
): ChromeAgentSession[] | null | undefined {
  if (agents === undefined) return undefined
  if (agents === null) return null
  if (agents.length === 0) return null

  return agents.map((a) => {
    const agentId = (a.agentId ?? a.id ?? "").trim()
    return {
      agentId: agentId.length > 0 ? agentId : "agent",
      description: a.description,
      status: a.status,
      ...(a.currentToolName !== undefined
        ? { currentToolName: a.currentToolName }
        : {}),
    }
  })
}

