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

import {
  agentProgress,
  fleetProgress,
  laneState,
  DEFAULT_STALL_MS,
  type AgentProgressSession,
  type FleetProgress,
  type LaneState,
} from "./agent-progress.js"
import { AGENTS_PANEL_MAX_VISIBLE, TASKS_PANEL_MAX_VISIBLE } from "./geometry/zones.js"
import type { ChromeZoneContent } from "./shell.js"

/** Subagent row shape for the agents chrome panel (store-agnostic). */
export type ChromeAgentSession = {
  readonly agentId: string
  readonly description: string
  readonly status: "running" | "done" | "failed" | "cancelled"
  /** Current tool while running (optional detail). */
  readonly currentToolName?: string | null
  /**
   * Bounded subject of the outstanding call (command / path / pattern). When
   * set, the agents panel paints this instead of the bare tool name (CL-5765).
   */
  readonly currentToolPreview?: string | null
  /** Clock the worker started; feeds the panel row's elapsed time. */
  readonly startedAt?: number
  /** Clock of the worker's last reported activity; feeds stalled detection. */
  readonly lastActivityAt?: number
  /** Clock the oldest outstanding tool call began; separates a long tool from silence. */
  readonly currentToolStartedAt: number | null
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
   * Task list: the structured rows the task tool writes. Distinct from
   * `agents` — a task is a unit of work with a status, not an executor.
   */
  readonly task?: readonly ChromeTaskRow[] | null
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
  /**
   * What the row is, so the renderer can colour and align it without parsing
   * `label`. Absent means a lane row (the default, and every row before the
   * board grew a header).
   */
  readonly kind?: "header" | "lane" | "more"
}

/**
 * Board paint order for main's `LaneState` vocabulary — trouble first so an
 * operator answers "is everything fine" without reading a word. This is a
 * display order only; stall/`in_tool` semantics live in `agent-progress`.
 */
const BOARD_LANE_ORDER: readonly LaneState[] = ["stalled", "in_tool", "working"]

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
 * to "done" rather than silently vanish.
 */
export function formatTasksPanel(
  task: readonly ChromeTaskRow[] | null | undefined,
  maxVisible: number = TASKS_PANEL_MAX_VISIBLE,
): readonly TaskPanelRow[] | null {
  if (task === null || task === undefined) return null

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
 * `agentProgress` / `laneState` clock/tool/stall computation the transcript
 * trailer uses. Terminal-only sessions (done/failed/cancelled) render no
 * rows — the panel shows live work, not a history; Ctrl+E / agents-nav covers
 * inspection.
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

  // One sort, not two. Both jobs the old pair of sorts did — which lanes
  // survive a fan-out, and what order the survivors paint in — want trouble
  // first, and neither key here churns: a lane's state changes only when
  // something real happens to it, and startedAt never changes at all. Sorting
  // by staleness would have reshuffled the board on every tool event.
  const ranked = [...running]
    .map((session) => ({
      session,
      state: boardLaneState(session, nowMs, stallMs),
    }))
    .sort(
      (a, b) =>
        BOARD_LANE_ORDER.indexOf(a.state) - BOARD_LANE_ORDER.indexOf(b.state) ||
        (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0) ||
        a.session.agentId.localeCompare(b.session.agentId),
    )

  // The header always costs a row, so it is part of the budget it summarises.
  const bodyBudget = Math.max(1, maxVisible - 1)
  const hidden = Math.max(0, ranked.length - bodyBudget)
  // Below a few body rows, a whole row spent on the hidden count carries less
  // than the lane it displaces; the header states it instead.
  const countInHeader = hidden > 0 && bodyBudget < 4
  const shown = ranked.slice(0, countInHeader ? bodyBudget : bodyBudget - (hidden > 0 ? 1 : 0))
  const stillHidden = ranked.length - shown.length

  // Fleet roll-up from the same `laneState` path the rows use — never a second
  // stall opinion grown in this file.
  const fleet = fleetProgress(
    running.flatMap((s) => {
      const progress = toProgressSession(s)
      return progress === null ? [] : [progress]
    }),
    nowMs,
    stallMs,
  )

  const rows: AgentPanelRow[] = [fleetHeaderRow(fleet, countInHeader ? stillHidden : 0)]
  for (const { session, state } of shown) {
    rows.push(formatAgentRow(session, state, nowMs, stallMs))
  }
  if (stillHidden > 0 && !countInHeader) {
    rows.push({
      label: `+${stillHidden} more lanes`,
      tail: "",
      stalled: false,
      kind: "more",
    })
  }
  return rows
}

/**
 * Map a chrome session into the shape `laneState` / `agentProgress` require.
 * Missing clocks mean we cannot ask those helpers — callers fall back to a
 * safe display default rather than inventing timestamps.
 */
function toProgressSession(session: ChromeAgentSession): AgentProgressSession | null {
  if (session.startedAt === undefined) return null
  return {
    status: session.status,
    currentToolName: session.currentToolName ?? null,
    currentToolPreview: session.currentToolPreview ?? null,
    currentToolStartedAt: session.currentToolStartedAt,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt ?? session.startedAt,
  }
}

/**
 * Board-facing lane word: main's `laneState` when clocks exist, else `working`
 * (no second stall path — without clocks we simply cannot claim stalled).
 */
function boardLaneState(
  session: ChromeAgentSession,
  nowMs: number,
  stallMs: number,
): LaneState {
  const progress = toProgressSession(session)
  if (progress === null) return "working"
  return laneState(progress, nowMs, stallMs)
}

/**
 * Fit the board into the rows geometry actually granted it.
 *
 * The formatter sizes the board to its content, but collapse can grant fewer
 * rows than that under pressure. Painting the full set anyway overflows the
 * zone's box — rows land on top of each other and on whatever is below. So the
 * granted height is the last word, and the lanes it costs are disclosed rather
 * than dropped in silence.
 *
 * When the formatter already folded a fan-out (`+N more lanes` or header
 * `+N hidden`), that prior count is carried into the re-clamp total so the
 * operator still sees every running lane accounted for — not only the ones
 * still present as row objects after the first fold.
 */
export function clampBoardRows(
  rows: readonly AgentPanelRow[],
  height: number,
): readonly AgentPanelRow[] {
  if (height <= 0) return []
  if (rows.length <= height) return rows

  const header = rows[0]
  if (header === undefined) return []
  const lanes = rows.filter((r) => r.kind === "lane")
  const priorHidden = priorHiddenCount(rows)
  // Drop any prior disclosure on the header; we restate the total below.
  const cleanHeader = stripHiddenTail(header)

  // Below a few rows the disclosure line costs more than the lane it displaces,
  // so the header carries the count instead — the same trade the formatter makes.
  if (height < 4) {
    const shown = lanes.slice(0, Math.max(0, height - 1))
    const hidden = priorHidden + (lanes.length - shown.length)
    return [withHiddenCount(cleanHeader, hidden), ...shown]
  }

  const shown = lanes.slice(0, Math.max(0, height - 2))
  const hidden = priorHidden + (lanes.length - shown.length)
  return [
    cleanHeader,
    ...shown,
    { label: `+${hidden} more lanes`, tail: "", stalled: false, kind: "more" },
  ]
}

/** Lanes already disclosed by a prior format/clamp fold on these rows. */
function priorHiddenCount(rows: readonly AgentPanelRow[]): number {
  let hidden = 0
  for (const row of rows) {
    if (row.kind === "more") {
      const match = /^\+(\d+) more lanes$/.exec(row.label)
      if (match?.[1] !== undefined) hidden += Number(match[1])
      continue
    }
    if (row.kind === "header") {
      const match = / · \+(\d+) hidden$/.exec(row.tail)
      if (match?.[1] !== undefined) hidden += Number(match[1])
    }
  }
  return hidden
}

function stripHiddenTail(header: AgentPanelRow): AgentPanelRow {
  const tail = header.tail.replace(/ · \+\d+ hidden$/, "")
  return tail === header.tail ? header : { ...header, tail }
}

function withHiddenCount(header: AgentPanelRow, hidden: number): AgentPanelRow {
  return hidden > 0 ? { ...header, tail: ` · +${hidden} hidden` } : header
}

/**
 * Operator-facing state word. Machine `LaneState` stays snake_case for code;
 * the board never paints that vocabulary into the terminal.
 */
function laneStateWord(state: LaneState): string {
  switch (state) {
    case "in_tool":
      return "in tool"
    case "stalled":
      return "stalled"
    case "working":
      return "working"
  }
}

/**
 * The one-line answer to "is everything fine". Counts run worst-first so that
 * a narrow terminal ellipsizes away the routine tail rather than the trouble.
 * Counts come from main's `fleetProgress`; the FLEET chrome layout is the board.
 */
function fleetHeaderRow(fleet: FleetProgress, hidden: number): AgentPanelRow {
  const parts = [`${fleet.running} ${fleet.running === 1 ? "lane" : "lanes"}`]
  // Trouble first (matches BOARD_LANE_ORDER); skip zero counts; working last.
  if (fleet.stalled > 0) parts.push(`${fleet.stalled} stalled`)
  if (fleet.inTool > 0) parts.push(`${fleet.inTool} in tool`)
  if (fleet.working > 0) parts.push(`${fleet.working} working`)
  return {
    label: `FLEET  ${parts.join(" · ")}`,
    tail: hidden > 0 ? ` · +${hidden} hidden` : "",
    stalled: fleet.stalled > 0,
    kind: "header",
  }
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

function formatAgentRow(
  session: ChromeAgentSession,
  state: LaneState,
  nowMs: number,
  stallMs: number,
): AgentPanelRow {
  const label = `${session.agentId}: ${session.description}`.trim()
  const stalled = state === "stalled"
  // Prefer the argument subject (command / path) over the bare tool name so a
  // fleet of shell calls is distinguishable at a glance (CL-5765).
  const preview = session.currentToolPreview
  const tool = session.currentToolName
  const doing =
    preview !== undefined && preview !== null && preview.length > 0
      ? preview
      : tool !== undefined && tool !== null && tool.length > 0
        ? tool
        : null

  const progressSession = toProgressSession(session)
  if (progressSession === null) {
    // No clock to report (the host omitted startedAt) — still surface what the
    // lane is doing rather than dropping detail the row already has.
    return { label, tail: doing !== null ? ` · ${doing}` : "", stalled, kind: "lane" }
  }

  // Prefer main's agentProgress for tool-clock / in_tool / quiet clocks so the
  // board never invents a second stall path. Board presentation still prefixes
  // the operator-facing state word (and kind: lane) the way the fleet board reads.
  const progress = agentProgress(progressSession, nowMs, stallMs)
  if (progress !== null) {
    return {
      label,
      tail: ` · ${laneStateWord(state)} · ${progress.stat}`,
      stalled,
      kind: "lane",
    }
  }

  return { label, tail: doing !== null ? ` · ${doing}` : "", stalled, kind: "lane" }
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
      if (tool === undefined) return a
      // Gap-fill only. When the store has a call outstanding it owns both the
      // name and the clock, and overriding just the name would paint one
      // tool's identifier beside another tool's elapsed time. A progress ping
      // also cannot supply a clock of its own — only the store observes a call
      // ending, so a ping-sourced clock would keep a finished lane reading
      // busy forever, hiding exactly the stalls this surface exists to show.
      if (a.currentToolStartedAt !== null) return a
      return { ...a, currentToolName: tool }
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
  readonly currentToolPreview?: string | null
  readonly currentToolStartedAt: number | null
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
      ...(a.currentToolPreview !== undefined
        ? { currentToolPreview: a.currentToolPreview }
        : {}),
      currentToolStartedAt: a.currentToolStartedAt,
      ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
      ...(a.lastActivityAt !== undefined
        ? { lastActivityAt: a.lastActivityAt }
        : {}),
    }
  })
}
