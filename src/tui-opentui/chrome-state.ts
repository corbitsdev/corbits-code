/**
 * Live chrome zone formatter for setChromeZones.
 *
 * Pure: structured session state → one-line task / agents strings.
 * Heights stay with geometry (zones max 1 row each); this module never
 * invents row budgets.
 *
 * ## Product host push contract
 *
 * The shell does not poll. The product host owns live state (task list,
 * subagent store) and pushes a full snapshot whenever any of those
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

import { agentProgress, DEFAULT_STALL_MS } from "./agent-progress.js"
import { AGENTS_PANEL_MAX_VISIBLE, TASKS_PANEL_MAX_VISIBLE } from "./geometry/zones.js"
import type { ChromeZoneContent } from "./shell.js"

/** Subagent row shape for the agents chrome panel (store-agnostic). */
export type ChromeAgentSession = {
  readonly agentId: string
  readonly description: string
  readonly status: "running" | "done" | "failed" | "cancelled"
  /** Current tool while running (optional detail). */
  readonly currentToolName?: string | null
  /** Clock the worker started; feeds the panel row's elapsed time. */
  readonly startedAt?: number
  /** Clock of the worker's last reported activity; feeds stalled detection. */
  readonly lastActivityAt?: number
}

/** Lightweight task row: title + status, as written by the task tool. */
export type ChromeTaskRow = {
  readonly title: string
  readonly status: "todo" | "doing" | "done" | "cancelled"
}

/**
 * One rendered task-panel row. `status` is null for a non-task row (the
 * "+N more" trailer, or a bare-string task input with no structured status)
 * so the renderer knows not to paint a status marker for it.
 */
export type TaskPanelRow = {
  readonly label: string
  readonly status: "todo" | "doing" | "done" | "cancelled" | null
}

/**
 * Full live chrome snapshot. Missing / null fields hide that zone.
 * Prefer pushing a complete snapshot on every update.
 */
export type ChromeLiveState = {
  /**
   * Task list: string shorthand (rendered as a single unstyled row) or the
   * structured rows the task tool writes. Distinct from `agents` — a task is
   * a unit of work with a status, not an executor.
   */
  readonly task?: readonly ChromeTaskRow[] | string | null
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

/**
 * One rendered agents-panel row. `stalled` is a fact the formatter already
 * knows from `agentProgress` — carried explicitly so the renderer never has
 * to recover it by sniffing `text` for a marker string. `label` (agentId +
 * description) is the part the renderer may ellipsize under width pressure;
 * `tail` (elapsed/tool/stalled) must never be trimmed away.
 */
export type AgentPanelRow = {
  readonly label: string
  readonly tail: string
  readonly stalled: boolean
}

/** Always-populated result for setChromeZones (null = hide zone). */
export type FormattedChromeZones = {
  /** One row per rendered task-panel line (null = hide zone, zero rows). */
  readonly task: readonly TaskPanelRow[] | null
  /** One row per rendered agents-panel line (null = hide zone, zero rows). */
  readonly agents: readonly AgentPanelRow[] | null
}

/**
 * Format structured live state into chrome zone rows for setChromeZones.
 *
 * Empty / partial / inactive inputs yield null for the corresponding zone
 * so geometry collapses that strip (idleDefault 0).
 */
export function formatChromeZones(
  state: ChromeLiveState,
  nowMs: number = Date.now(),
): FormattedChromeZones {
  return {
    task: formatTasksPanel(state.task),
    agents: formatAgentsPanel(state.agents, state.observe, nowMs),
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

/**
 * Format the live task-list panel: one row per task, bounded to `maxVisible`
 * with a trailing "+N more" row, mirroring `formatAgentsPanel`'s shape but
 * keyed on status (not liveness) since a task has no clock of its own.
 *
 * Terminal tasks (done/cancelled) still render — the panel is a live list of
 * work, not just what remains — so an operator watching it sees a task move
 * to "done" rather than silently vanish. A bare string input renders as one
 * row with no status marker: it is free-form summary text, not a task record.
 */
export function formatTasksPanel(
  task: readonly ChromeTaskRow[] | string | null | undefined,
  maxVisible: number = TASKS_PANEL_MAX_VISIBLE,
): readonly TaskPanelRow[] | null {
  if (task === null || task === undefined) return null

  if (typeof task === "string") {
    const t = task.trim()
    return t.length === 0 ? null : [{ label: t, status: null }]
  }

  const rows: TaskPanelRow[] = task
    .map((t) => ({ label: t.title.trim(), status: t.status }))
    .filter((r) => r.label.length > 0)
  if (rows.length === 0) return null

  const visible = rows.slice(0, maxVisible)
  const hidden = rows.length - visible.length
  if (hidden > 0) visible.push({ label: `+${hidden} more`, status: null })
  return visible
}

/**
 * Format the live agents panel: one row per running agent, bounded to
 * `maxVisible` with a trailing "+N more" row, sourced from the same
 * `agentProgress` clock/tool/stall computation the transcript trailer uses.
 * Terminal-only sessions (done/failed/cancelled) render no rows — the panel
 * shows live work, not a history; Ctrl+E / agents-nav covers inspection.
 */
export function formatAgentsPanel(
  agents: readonly ChromeAgentSession[] | null | undefined,
  observe: ChromeLiveState["observe"],
  nowMs: number,
  maxVisible: number = AGENTS_PANEL_MAX_VISIBLE,
  stallMs: number = DEFAULT_STALL_MS,
): readonly AgentPanelRow[] | null {
  const observeRow = formatObserveRow(observe)
  if (observeRow !== undefined) return observeRow === null ? null : [observeRow]

  if (agents === null || agents === undefined || agents.length === 0) return null

  const running = agents.filter((s) => s.status === "running")
  if (running.length === 0) return null

  // Two different sorts for two different jobs. Selection (which N survive
  // a fan-out past maxVisible) must key on staleness, or the stalest —
  // most likely stalled — agent is exactly the one that gets folded into
  // "+N more". Presentation must NOT key on staleness: lastActivityAt is
  // the most rapidly-changing field in the record, so sorting rows by it
  // reshuffles the panel on every tool event. startedAt never changes for
  // a live agent, so it gives stable row order; agentId breaks ties since
  // a simultaneous fan-out can share a startedAt and the input feed's own
  // order (newest-first, itself not stable under updates) must not leak
  // through as a tiebreak.
  const selected = [...running]
    .sort(
      (a, b) => (a.lastActivityAt ?? a.startedAt ?? 0) - (b.lastActivityAt ?? b.startedAt ?? 0),
    )
    .slice(0, maxVisible)
  const hidden = running.length - selected.length

  const presented = [...selected].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.agentId.localeCompare(b.agentId),
  )
  const rows = presented.map((s) => formatAgentRow(s, nowMs, stallMs))
  if (hidden > 0) rows.push({ label: `+${hidden} more`, tail: "", stalled: false })
  return rows
}

function formatObserveRow(observe: ChromeLiveState["observe"]): AgentPanelRow | null | undefined {
  if (observe === null || observe === undefined) return undefined
  const id = observe.agentId.trim()
  const desc = observe.description.trim()
  if (id.length === 0 && desc.length === 0) return null
  const label =
    id.length > 0 && desc.length > 0 ? `${id} — ${desc}` : id.length > 0 ? id : desc
  return { label: `observe: ${label}`, tail: "", stalled: false }
}

function formatAgentRow(session: ChromeAgentSession, nowMs: number, stallMs: number): AgentPanelRow {
  const label = `${session.agentId}: ${session.description}`.trim()
  const progress =
    session.startedAt !== undefined
      ? agentProgress(
          {
            status: "running",
            currentToolName: session.currentToolName ?? null,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt ?? session.startedAt,
          },
          nowMs,
          stallMs,
        )
      : null

  if (progress !== null) {
    const tail = progress.stalled ? ` · ${progress.stat} · stalled` : ` · ${progress.stat}`
    return { label, tail, stalled: progress.stalled }
  }

  // No startedAt to compute a clock from (host omitted it) — still surface
  // the tool name so the row is not silently missing detail it has.
  const tool = session.currentToolName
  const tail = tool !== undefined && tool !== null && tool.length > 0 ? ` · ${tool}` : ""
  return { label, tail, stalled: false }
}

/**
 * Overlay live per-agent tool names onto the agents zone.
 *
 * The subagent store records what a worker was asked to do, never what it is
 * doing right now — that arrives only as `subagent.progress`. Keying by
 * description is what the emitter gives us: progress carries the worker's
 * description and tool name, not its agent id.
 */
export function annotateAgentTools(
  state: ChromeLiveState,
  toolByDescription: ReadonlyMap<string, string>,
): ChromeLiveState {
  const agents = state.agents
  if (agents === null || agents === undefined || toolByDescription.size === 0) {
    return state
  }
  return {
    ...state,
    agents: agents.map((a) => {
      if (a.status !== "running") return a
      const tool = toolByDescription.get(a.description)
      return tool === undefined ? a : { ...a, currentToolName: tool }
    }),
  }
}

// ---------------------------------------------------------------------------
// Session-shaped → ChromeLiveState (loose mapping for product host push)
// ---------------------------------------------------------------------------

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
  readonly startedAt?: number
  readonly lastActivityAt?: number
}

/**
 * Live session bags the product host already holds. Missing fields omit zones.
 */
export type ChromeSessionInput = {
  readonly tasks?: readonly ChromeSessionTask[] | null
  readonly agents?: readonly ChromeSessionAgent[] | null
  readonly observe?: ChromeLiveState["observe"]
}

/**
 * Map real session shapes (tasks / subagent store) into ChromeLiveState for
 * `formatChromeZones` / `setChrome`.
 *
 * Pure and store-agnostic — pass whatever the host already has; loose fields
 * are ignored when absent.
 */
export function chromeFromSession(input: ChromeSessionInput): ChromeLiveState {
  const task = mapSessionTasks(input.tasks)
  const agents = mapSessionAgents(input.agents)
  const observe = input.observe ?? null

  return {
    ...(task !== undefined ? { task } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(observe !== null && observe !== undefined ? { observe } : {}),
  }
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
      ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
      ...(a.lastActivityAt !== undefined
        ? { lastActivityAt: a.lastActivityAt }
        : {}),
    }
  })
}

