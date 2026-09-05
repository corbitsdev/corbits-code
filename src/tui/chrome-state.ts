/**
 * Live chrome zone formatter for setChromeZones.
 *
 * Pure: structured session state → task / agents zone rows.
 * Heights stay with geometry; this module never invents row budgets.
 *
 * ## Agents strip (live) / task checklist (parked)
 *
 * `formatChromeZones` paints the agents zone from `formatAgentsPanel` and keeps
 * the task checklist parked (`task: null`). Live fleet status is a flat strip
 * above the prompt (label / status / current tool) — same shape as transcript
 * `spawn_agent` anchors, without a FLEET header board. Transcript spawn_agent
 * rows remain as spawn/final/fail anchors; live progress clocks belong to chrome only
 * (product-host gates `syncAgentProgress` while this strip needs a tick).
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
 * Sticky poll continues while any agent is live or still inside the
 * post-finish linger window (`finishedAt` + `AGENTS_PANEL_LINGER_MS`).
 */

import {
  agentLaneIsLive,
  agentProgress,
  laneState,
  DEFAULT_STALL_MS,
  type AgentProgressSession,
  type LaneState,
} from "./agent-progress.js";
import { AGENTS_PANEL_MAX_VISIBLE, TASKS_PANEL_MAX_VISIBLE } from "./geometry/zones.js";

/**
 * How long a finished agent row (done / failed / cancelled / interrupted) stays
 * on the strip after `finishedAt` before dropping. Mid of the 3–5s hold window
 * so success, failure, and interrupt share the same glanceable linger.
 */
export const AGENTS_PANEL_LINGER_MS = 4_000;

/** Subagent row shape for the agents chrome panel (store-agnostic). */
export interface ChromeAgentSession {
  readonly agentId: string;
  readonly description: string;
  readonly status: "running" | "done" | "failed" | "cancelled";
  readonly lifecycleStatus?: AgentProgressSession["lifecycleStatus"];
  /** Current tool while running (optional detail). */
  readonly currentToolName?: string | null;
  /**
   * Bounded subject of the outstanding call (command / path / pattern). When
   * set, the agents panel paints this instead of the bare tool name (CL-5765).
   */
  readonly currentToolPreview?: string | null;
  /** Clock the worker started; feeds the panel row's elapsed time. */
  readonly startedAt?: number;
  /** Clock of the worker's last reported activity; feeds stalled detection. */
  readonly lastActivityAt?: number;
  /** Clock the oldest outstanding tool call began; separates a long tool from silence. */
  readonly currentToolStartedAt: number | null;
  /**
   * When the live turn ended. Drives the post-finish linger window on the strip
   * (`AGENTS_PANEL_LINGER_MS`); absent → no linger paint. Set on interrupt while
   * TUI `status` may still be `"running"` — the live turn is over even if leftover
   * tools keep running.
   */
  readonly finishedAt?: number;
  /** False while admission-queued. Missing means unknown. */
  readonly runInFlight?: boolean;
}

/** Lightweight task row: title + status, as written by manage_tasks. */
export interface ChromeTaskRow {
  readonly title: string;
  readonly status: "todo" | "doing" | "done" | "cancelled";
}

/**
 * One rendered task-panel row. `status` is null for a non-task row (the
 * "+N more" trailer, or a bare-string task input with no structured status)
 * so the renderer knows not to paint a status marker for it.
 */
export interface TaskPanelRow {
  readonly label: string;
  readonly status: "todo" | "doing" | "done" | "cancelled" | null;
}

/**
 * Full live chrome snapshot. Missing / null fields hide that zone.
 * Prefer pushing a complete snapshot on every update.
 */
export interface ChromeLiveState {
  /**
   * Task list: the structured rows manage_tasks writes. Distinct from
   * `agents` — a task is a checklist item with a status, not an executor.
   */
  readonly task?: readonly ChromeTaskRow[] | null;
  /** Subagent sessions for the strip summary (running preferred). */
  readonly agents?: readonly ChromeAgentSession[] | null;
  /**
   * When set, agents line becomes observe chrome (matches enterSubagentObserve).
   * Pass null/omit when not observing.
   */
  readonly observe?: {
    readonly agentId: string;
    readonly description: string;
  } | null;
}

/**
 * One rendered agents-panel row. `stalled` is a fact the formatter already
 * knows from `agentProgress` — carried explicitly so the renderer never has
 * to recover it by sniffing `label` for a marker string. `label` (the ●/!
 * marker, agentId + description) is the part the renderer may ellipsize under
 * width pressure; `tail` (clock/tool) must never be trimmed away.
 */
export interface AgentPanelRow {
  readonly label: string;
  readonly tail: string;
  readonly stalled: boolean;
  /**
   * What the row is, so the renderer can colour and align it without parsing
   * `label`. Absent means a lane row (the default).
   */
  readonly kind?: "header" | "lane" | "more";
  /**
   * Lane lifecycle for paint tone. Live running uses primary `UI.text`;
   * terminal linger uses done/error/dim. Interrupted linger is dim, not cream
   * live. Absent ⇒ treat as live running.
   */
  readonly status?: "running" | "done" | "failed" | "cancelled" | "interrupted";
}

/**
 * Board paint order for main's `LaneState` vocabulary — trouble first so an
 * operator answers "is everything fine" without reading a word. This is a
 * display order only; stall/`in_tool` semantics live in `agent-progress`.
 */
const BOARD_LANE_ORDER: readonly LaneState[] = ["stalled", "in_tool", "working", "queued"];

/** Always-populated result for setChromeZones (null = hide zone). */
export interface FormattedChromeZones {
  /** One row per rendered task-panel line (null = hide zone, zero rows). */
  readonly task: readonly TaskPanelRow[] | null;
  /** One row per rendered agents-panel line (null = hide zone, zero rows). */
  readonly agents: readonly AgentPanelRow[] | null;
}

/**
 * Partial chrome snapshot for `setChromeZones`. Omitted fields mean don't-touch
 * (leave the current zone); `null`/empty means hide. Distinct from
 * `FormattedChromeZones`, which always names both zones.
 */
export interface ChromeZoneContent {
  /** One row per task-panel line. Null/empty = hide the zone. */
  readonly task?: readonly TaskPanelRow[] | null;
  /** One row per agents-panel line. Null/empty = hide the zone. */
  readonly agents?: readonly AgentPanelRow[] | null;
}

/**
 * Format structured live state into chrome zone rows for setChromeZones.
 *
 * Agents strip is live (`formatAgentsPanel`); the task checklist stays parked
 * (`task: null`) until a later rebuild. Manual `setChromeZones` / Alt+T can
 * still feed preformatted task rows into the shell.
 */
export function formatChromeZones(
  state: ChromeLiveState,
  nowMs: number = Date.now(),
): FormattedChromeZones {
  return {
    task: null,
    agents: formatAgentsPanel(state.agents, state.observe, nowMs),
  };
}

/**
 * Convenience: format then assign to shell. Equivalent to
 * `setChromeZones(shell, formatChromeZones(state))` when the host already
 * holds a setChromeZones reference.
 */
export function chromeZonesContent(state: ChromeLiveState): ChromeZoneContent {
  return formatChromeZones(state);
}

/**
 * True while the agents strip still needs wall-clock ticks: any live worker,
 * or any finished row still inside the post-finish linger window. Product-host
 * sticky poll uses this both to keep clocks/linger fresh and to freeze
 * transcript `syncAgentProgress` rewrites while chrome owns live status.
 */
export function agentsChromeNeedsSticky(
  agents: readonly ChromeAgentSession[] | null | undefined,
  nowMs: number,
  lingerMs: number = AGENTS_PANEL_LINGER_MS,
): boolean {
  if (agents === null || agents === undefined) return false;
  for (const session of agents) {
    if (agentLaneIsLive(session)) return true;
    if (agentIsLingering(session, nowMs, lingerMs)) return true;
  }
  return false;
}

/** Finished session still inside the glanceable linger window. */
export function agentIsLingering(
  session: ChromeAgentSession,
  nowMs: number,
  lingerMs: number = AGENTS_PANEL_LINGER_MS,
): boolean {
  if (agentLaneIsLive(session)) return false;
  if (session.finishedAt === undefined) return false;
  return nowMs - session.finishedAt < lingerMs;
}

/**
 * Format the live task-list panel: one row per task, bounded to `maxVisible`
 * with a trailing "+N more" row, mirroring `formatAgentsPanel`'s shape but
 * keyed on status (not liveness) since a task has no clock of its own.
 *
 * Terminal-only lists (every task done/cancelled) collapse to null — a wall of
 * `[x]` rows is not live work, and once the fleet board or parent prose has
 * moved on, painting them is noise (CL-5846).
 */
export function formatTasksPanel(
  task: readonly ChromeTaskRow[] | null | undefined,
  maxVisible: number = TASKS_PANEL_MAX_VISIBLE,
): readonly TaskPanelRow[] | null {
  if (task === null || task === undefined) return null;

  const rows: TaskPanelRow[] = task
    .map((t) => ({ label: t.title.trim(), status: t.status }))
    .filter((r) => r.label.length > 0);
  if (rows.length === 0) return null;

  const live = rows.filter((r) => r.status === "todo" || r.status === "doing");
  if (live.length === 0) return null;

  // Prefer open work; keep recently-done visible only while open work remains
  // so the operator sees items flip to done without a permanent [x] wall.
  const openFirst = [
    ...live,
    ...rows.filter((r) => r.status === "done" || r.status === "cancelled"),
  ];
  const visible = openFirst.slice(0, maxVisible);
  const hidden = openFirst.length - visible.length;
  if (hidden > 0) visible.push({ label: `+${hidden} more`, status: null });
  return visible;
}

/**
 * Format the live agents strip: a flat growing list (label / status / tool),
 * bounded to `maxVisible` with a trailing "+N more" row.
 *
 * No FLEET header — a roll-up board fought the Amp/Codex-style lane list the
 * strip is meant to be. Live lanes sort trouble-first via `laneState`;
 * finished sessions linger for `AGENTS_PANEL_LINGER_MS` after `finishedAt`
 * (success / fail / cancel / interrupt share the same window) then drop. Observe
 * mode still replaces the whole strip with a single observe row.
 */
export function formatAgentsPanel(
  agents: readonly ChromeAgentSession[] | null | undefined,
  observe: ChromeLiveState["observe"],
  nowMs: number,
  maxVisible: number = AGENTS_PANEL_MAX_VISIBLE,
  stallMs: number = DEFAULT_STALL_MS,
  lingerMs: number = AGENTS_PANEL_LINGER_MS,
): readonly AgentPanelRow[] | null {
  const observeRow = formatObserveRow(observe);
  if (observeRow !== undefined) return observeRow === null ? null : [observeRow];

  if (agents === null || agents === undefined || agents.length === 0) return null;

  const running = agents.filter((s) => agentLaneIsLive(s));
  const lingering = agents.filter((s) => agentIsLingering(s, nowMs, lingerMs));
  if (running.length === 0 && lingering.length === 0) return null;

  // One sort for live lanes. Trouble first; startedAt never churns so the board
  // does not reshuffle on every tool event. Lingering terminals trail, newest
  // finish first, so a just-completed lane stays glanceable at the bottom edge.
  const rankedRunning = [...running]
    .map((session) => ({
      session,
      state: boardLaneState(session, nowMs, stallMs),
    }))
    .sort(
      (a, b) =>
        BOARD_LANE_ORDER.indexOf(a.state) - BOARD_LANE_ORDER.indexOf(b.state) ||
        (a.session.startedAt ?? 0) - (b.session.startedAt ?? 0) ||
        a.session.agentId.localeCompare(b.session.agentId),
    );

  const rankedLingering = [...lingering].sort(
    (a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0) || a.agentId.localeCompare(b.agentId),
  );

  const ranked: AgentPanelRow[] = [
    ...rankedRunning.map(({ session, state }) => formatAgentRow(session, state, nowMs, stallMs)),
    ...rankedLingering.map((session) =>
      session.status === "running" && session.lifecycleStatus === "interrupted"
        ? formatInterruptedLingerRow(session, nowMs, stallMs)
        : formatTerminalRow(session),
    ),
  ];

  const shown = ranked.slice(0, maxVisible);
  const hidden = ranked.length - shown.length;
  if (hidden > 0) {
    // maxVisible lanes + trailing fold → AGENTS_PANEL_MAX_VISIBLE + 1
    // (geometry agents.max). Mirror formatTasksPanel: do not steal a lane slot.
    return [
      ...shown,
      {
        label: `+${hidden} more`,
        tail: "",
        stalled: false,
        kind: "more",
      },
    ];
  }
  return shown;
}

/**
 * Map a chrome session into the shape `laneState` / `agentProgress` require.
 * Missing clocks mean we cannot ask those helpers — callers fall back to a
 * safe display default rather than inventing timestamps.
 */
function toProgressSession(session: ChromeAgentSession): AgentProgressSession | null {
  if (session.startedAt === undefined) return null;
  return {
    status: session.status,
    ...(session.lifecycleStatus !== undefined ? { lifecycleStatus: session.lifecycleStatus } : {}),
    currentToolName: session.currentToolName ?? null,
    currentToolPreview: session.currentToolPreview ?? null,
    currentToolStartedAt: session.currentToolStartedAt,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt ?? session.startedAt,
    ...(session.runInFlight !== undefined ? { runInFlight: session.runInFlight } : {}),
  };
}

/**
 * Board-facing lane word: main's `laneState` when clocks exist, else `working`
 * (no second stall path — without clocks we simply cannot claim stalled).
 */
function boardLaneState(session: ChromeAgentSession, nowMs: number, stallMs: number): LaneState {
  const progress = toProgressSession(session);
  if (progress === null) return "working";
  return laneState(progress, nowMs, stallMs);
}

/**
 * Fit the strip into the rows geometry actually granted it.
 *
 * The formatter sizes to content, but collapse can grant fewer rows under
 * pressure. Painting the full set anyway overflows the zone's box. The granted
 * height is the last word; lanes it costs are disclosed rather than dropped
 * silently. Prior `+N more` counts are carried into the re-clamp total.
 */
export function clampBoardRows(
  rows: readonly AgentPanelRow[],
  height: number,
): readonly AgentPanelRow[] {
  if (height <= 0) return [];
  if (rows.length <= height) return rows;

  const lanes = rows.filter((r) => r.kind !== "more" && r.kind !== "header");
  const priorHidden = priorHiddenCount(rows);

  if (height < 2) {
    return lanes.slice(0, height);
  }

  const shown = lanes.slice(0, Math.max(0, height - 1));
  const hidden = priorHidden + (lanes.length - shown.length);
  return [...shown, { label: `+${hidden} more`, tail: "", stalled: false, kind: "more" }];
}

/** Lanes already disclosed by a prior format/clamp fold on these rows. */
function priorHiddenCount(rows: readonly AgentPanelRow[]): number {
  let hidden = 0;
  for (const row of rows) {
    if (row.kind === "more") {
      const match = /^\+(\d+) more(?: lanes)?$/.exec(row.label);
      if (match?.[1] !== undefined) hidden += Number(match[1]);
    }
  }
  return hidden;
}

function formatObserveRow(observe: ChromeLiveState["observe"]): AgentPanelRow | null | undefined {
  if (observe === null || observe === undefined) return undefined;
  const id = observe.agentId.trim();
  const desc = observe.description.trim();
  if (id.length === 0 && desc.length === 0) return null;
  const label = id.length > 0 && desc.length > 0 ? `${id} — ${desc}` : id.length > 0 ? id : desc;
  return { label: `observe: ${label}`, tail: "", stalled: false, kind: "lane", status: "running" };
}

function formatAgentRow(
  session: ChromeAgentSession,
  state: LaneState,
  nowMs: number,
  stallMs: number,
): AgentPanelRow {
  const stalled = state === "stalled";
  // Rail grammar: ● for live work, ! when quiet. The marker names the state so
  // the tail stays clock/tool only.
  const marker = stalled ? "!" : "●";
  const label = `${marker} ${session.agentId}  ${session.description}`.trim();
  // Prefer the argument subject (command / path) over the bare tool name so a
  // strip of shell calls is distinguishable at a glance (CL-5765).
  const preview = session.currentToolPreview;
  const tool = session.currentToolName;
  const doing =
    preview !== undefined && preview !== null && preview.length > 0
      ? preview
      : tool !== undefined && tool !== null && tool.length > 0
        ? tool
        : null;

  const progressSession = toProgressSession(session);
  if (progressSession === null) {
    return {
      label,
      tail: doing !== null ? ` · ${doing}` : "",
      stalled,
      kind: "lane",
      status: "running",
    };
  }

  const progress = agentProgress(progressSession, nowMs, stallMs);
  if (progress !== null) {
    return {
      label,
      tail: ` · ${progress.stat}`,
      stalled,
      kind: "lane",
      status: "running",
    };
  }

  return {
    label,
    tail: doing !== null ? ` · ${doing}` : "",
    stalled,
    kind: "lane",
    status: "running",
  };
}

function formatInterruptedLingerRow(
  session: ChromeAgentSession,
  nowMs: number,
  stallMs: number,
): AgentPanelRow {
  const label = `● ${session.agentId}  ${session.description}`.trim();
  const progressSession = toProgressSession(session);
  const progress = progressSession !== null ? agentProgress(progressSession, nowMs, stallMs) : null;
  return {
    label,
    tail: progress !== null ? ` · ${progress.stat}` : " · interrupted",
    stalled: false,
    kind: "lane",
    status: "interrupted",
  };
}

function formatTerminalRow(session: ChromeAgentSession): AgentPanelRow {
  const failed = session.status === "failed";
  const marker = failed ? "!" : "●";
  const label = `${marker} ${session.agentId}  ${session.description}`.trim();
  const word =
    session.status === "done" ? "done" : session.status === "failed" ? "failed" : "cancelled";
  return {
    label,
    tail: ` · ${word}`,
    stalled: failed,
    kind: "lane",
    status: session.status,
  };
}

/**
 * Overlay live per-agent tool names onto the agents zone.
 *
 * This is now an identity: the subagent store is the sole source of truth for
 * what a worker is doing, via `currentToolName` paired with the matching
 * `currentToolStartedAt` clock. The `subagent.progress` ping carries only a
 * tool name with no clock of its own, so painting it onto a lane with no
 * outstanding call would announce a dead tool — exactly the false "quiet ·
 * read_file" stall this surface exists to expose. Progress pings are also
 * emitted on tool completion, so any name they hand us may already be stale.
 *
 * The signature is kept so call sites and tests can be updated in their own
 * diffs; passing a map here no longer changes any row.
 */
export function annotateAgentTools(
  state: ChromeLiveState,
  _toolByDescription?: ReadonlyMap<string, string>,
): ChromeLiveState {
  return state;
}

// ---------------------------------------------------------------------------
// Session-shaped → ChromeLiveState (loose mapping for product host push)
// ---------------------------------------------------------------------------

/** manage_tasks / Task-shaped row (title + status). */
export interface ChromeSessionTask {
  readonly title: string;
  readonly status: "todo" | "doing" | "done" | "cancelled";
}

/**
 * SubAgentSession-shaped strip row. `agentId` preferred; falls back to `id`
 * when the store only exposes a session id.
 */
export interface ChromeSessionAgent {
  readonly agentId?: string;
  readonly id?: string;
  readonly description: string;
  readonly status: "running" | "done" | "failed" | "cancelled";
  readonly lifecycleStatus?: AgentProgressSession["lifecycleStatus"];
  readonly currentToolName?: string | null;
  readonly currentToolPreview?: string | null;
  readonly currentToolStartedAt: number | null;
  readonly startedAt?: number;
  readonly lastActivityAt?: number;
  readonly finishedAt?: number;
  readonly runInFlight?: boolean;
}

/**
 * Live session bags the product host already holds. Missing fields omit zones.
 */
export interface ChromeSessionInput {
  readonly tasks?: readonly ChromeSessionTask[] | null;
  readonly agents?: readonly ChromeSessionAgent[] | null;
  readonly observe?: ChromeLiveState["observe"];
}

/**
 * Map real session shapes (tasks / subagent store) into ChromeLiveState for
 * `formatChromeZones` / `setChrome`.
 *
 * Pure and store-agnostic — pass whatever the host already has; loose fields
 * are ignored when absent.
 */
export function chromeFromSession(input: ChromeSessionInput): ChromeLiveState {
  const task = mapSessionTasks(input.tasks);
  const agents = mapSessionAgents(input.agents);
  const observe = input.observe ?? null;

  return {
    ...(task !== undefined ? { task } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(observe !== null && observe !== undefined ? { observe } : {}),
  };
}

function mapSessionTasks(
  tasks: readonly ChromeSessionTask[] | null | undefined,
): ChromeTaskRow[] | null | undefined {
  if (tasks === undefined) return undefined;
  if (tasks === null) return null;
  if (tasks.length === 0) return null;
  return tasks.map((t) => ({
    title: t.title,
    status: t.status,
  }));
}

function mapSessionAgents(
  agents: readonly ChromeSessionAgent[] | null | undefined,
): ChromeAgentSession[] | null | undefined {
  if (agents === undefined) return undefined;
  if (agents === null) return null;
  if (agents.length === 0) return null;

  return agents.map((a) => {
    const agentId = (a.agentId ?? a.id ?? "").trim();
    return {
      agentId: agentId.length > 0 ? agentId : "agent",
      description: a.description,
      status: a.status,
      ...(a.lifecycleStatus !== undefined ? { lifecycleStatus: a.lifecycleStatus } : {}),
      ...(a.currentToolName !== undefined ? { currentToolName: a.currentToolName } : {}),
      ...(a.currentToolPreview !== undefined ? { currentToolPreview: a.currentToolPreview } : {}),
      currentToolStartedAt: a.currentToolStartedAt,
      ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
      ...(a.lastActivityAt !== undefined ? { lastActivityAt: a.lastActivityAt } : {}),
      ...(a.finishedAt !== undefined ? { finishedAt: a.finishedAt } : {}),
      ...(a.runInFlight !== undefined ? { runInFlight: a.runInFlight } : {}),
    };
  });
}
