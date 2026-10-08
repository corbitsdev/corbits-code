/**
 * Pure chrome zone formatter for setChromeZones: session state → task/agents
 * zone rows; row heights stay with geometry. The shell does not poll — the
 * product host pushes a full snapshot on every change, so absent zones clear
 * (`null` hides). The agents strip is live; the task checklist stays parked
 * (`task: null`) until a later rebuild; live progress clocks belong to chrome
 * only (product-host gates `syncAgentProgress` while the strip needs a tick).
 */

import {
  agentLaneIsLive,
  agentProgress,
  laneState,
  DEFAULT_STALL_MS,
  type AgentProgressSession,
  type FleetProgress,
  type LaneState,
} from "../subagent/agent-progress.js";
import {
  AGENTS_PANEL_MAX_VISIBLE,
  TASKS_PANEL_MAX_VISIBLE,
} from "./geometry/zones.js";
import { CREDENTIAL_FAILURE_USER_MESSAGE } from "../inference-error-message.js";
import type { Telemetry } from "../telemetry/index.js";
import type { RampPhase } from "./ramp.js";

/**
 * Linger window for a finished agent row after `finishedAt`; mid of the
 * 3–5s hold so every terminal state shares one glanceable drop.
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
  /** Bounded subject of the outstanding call (command/path/pattern);
   * painted instead of the bare tool name. */
  readonly currentToolPreview?: string | null;
  /** Clock the worker started; feeds the panel row's elapsed time. */
  readonly startedAt?: number;
  /** Clock of the worker's last reported activity; feeds stalled detection. */
  readonly lastActivityAt?: number;
  /** Clock the oldest outstanding tool call began; separates a long tool from silence. */
  readonly currentToolStartedAt: number | null;
  /** When the live turn ended; drives the linger window
   * (`AGENTS_PANEL_LINGER_MS`); absent → no linger. Set on interrupt even
   * though TUI `status` may still read `"running"` — the turn is over while
   * leftover tools keep running. */
  readonly finishedAt?: number;
  /** False while admission-queued. Missing means unknown. */
  readonly runInFlight?: boolean;
}

/** Lightweight task row: title + status, as written by manage_tasks. */
export interface ChromeTaskRow {
  readonly title: string;
  readonly status: "todo" | "doing" | "done" | "cancelled";
}

/** One rendered task-panel row; `status` is null for non-task rows ("+N
 * more" trailer, bare-string input) so the renderer skips the marker. */
export interface TaskPanelRow {
  readonly label: string;
  readonly status: "todo" | "doing" | "done" | "cancelled" | null;
}

/** Full live chrome snapshot. Missing / null fields hide that zone; push a
 * complete snapshot on every update. */
export interface ChromeLiveState {
  /** Structured rows manage_tasks writes; a task is a checklist item with a
   * status, not an executor (distinct from `agents`). */
  readonly task?: readonly ChromeTaskRow[] | null;
  /** Subagent sessions for the strip summary (running preferred). */
  readonly agents?: readonly ChromeAgentSession[] | null;
  /** When set, the agents line becomes observe chrome; pass null/omit when
   * not observing. */
  readonly observe?: {
    readonly agentId: string;
    readonly description: string;
  } | null;
}

/**
 * One rendered agents-panel row. `stalled` comes precomputed from
 * `agentProgress` so the renderer never sniffs `label`; `label` may be
 * ellipsized under width pressure, `tail` (clock/tool) never trimmed.
 */
export interface AgentPanelRow {
  readonly label: string;
  readonly tail: string;
  readonly stalled: boolean;
  /** Row kind, so the renderer can colour and align without parsing `label`;
   * absent means a lane row (the default). */
  readonly kind?: "header" | "lane" | "more";
  /** Lane lifecycle for paint tone: live running uses primary `UI.text`;
   * terminal linger done/error/dim; interrupted linger dim, not live.
   * Absent ⇒ treat as running. */
  readonly status?: "running" | "done" | "failed" | "cancelled" | "interrupted";
}

/** Board paint order — trouble first so problems read at a glance. Display
 * order only; stall/`in_tool` semantics live in `agent-progress`. */
const BOARD_LANE_ORDER: readonly LaneState[] = [
  "stalled",
  "in_tool",
  "working",
  "queued",
];

/** Always-populated result for setChromeZones (null = hide zone). */
export interface FormattedChromeZones {
  /** One row per rendered task-panel line (null = hide zone, zero rows). */
  readonly task: readonly TaskPanelRow[] | null;
  /** One row per rendered agents-panel line (null = hide zone, zero rows). */
  readonly agents: readonly AgentPanelRow[] | null;
}

/** Partial chrome snapshot for `setChromeZones`. Omitted fields leave the
 * current zone; `null`/empty hides. Distinct from `FormattedChromeZones`,
 * which always names both zones. */
export interface ChromeZoneContent {
  /** One row per task-panel line. Null/empty = hide the zone. */
  readonly task?: readonly TaskPanelRow[] | null;
  /** One row per agents-panel line. Null/empty = hide the zone. */
  readonly agents?: readonly AgentPanelRow[] | null;
}

/** Format structured live state into chrome zone rows for setChromeZones.
 * Agents strip is live (`formatAgentsPanel`); the task checklist stays
 * parked until a later rebuild; manual `setChromeZones` / Alt+T can still
 * feed preformatted task rows. */
export function formatChromeZones(
  state: ChromeLiveState,
  nowMs: number = Date.now(),
  lingerMs: number = AGENTS_PANEL_LINGER_MS,
): FormattedChromeZones {
  return {
    task: null,
    agents: formatAgentsPanel(
      state.agents,
      state.observe,
      nowMs,
      AGENTS_PANEL_MAX_VISIBLE,
      DEFAULT_STALL_MS,
      lingerMs,
    ),
  };
}

/** True while the strip still needs wall-clock ticks: any live worker or a
 * finished row inside the linger window. Product-host sticky poll uses it to
 * keep clocks fresh and freeze transcript `syncAgentProgress` rewrites while
 * chrome owns live status. */
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

/** Format the live task-list panel: one row per task, bounded to `maxVisible`
 * with a trailing "+N more" row, mirroring `formatAgentsPanel` but keyed on
 * status (a task has no clock). Terminal-only lists collapse to null — a
 * wall of `[x]` rows is not live work. */
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

  // Open work first; keep done items visible only while open work remains,
  // so items flip without a permanent [x] wall.
  const openFirst = [
    ...live,
    ...rows.filter((r) => r.status === "done" || r.status === "cancelled"),
  ];
  const visible = openFirst.slice(0, maxVisible);
  const hidden = openFirst.length - visible.length;
  if (hidden > 0) visible.push({ label: `+${hidden} more`, status: null });
  return visible;
}

/** Format the live agents strip: a flat list (label / status / tool), bounded
 * to `maxVisible` with a trailing "+N more" row.
 *
 * No FLEET header — a roll-up board fought the lane list the strip is meant
 * to be. Live lanes sort trouble-first via `laneState`; finished sessions
 * linger `AGENTS_PANEL_LINGER_MS` after `finishedAt`, then drop. Observe mode
 * replaces the strip with a single observe row. */
export function formatAgentsPanel(
  agents: readonly ChromeAgentSession[] | null | undefined,
  observe: ChromeLiveState["observe"],
  nowMs: number,
  maxVisible: number = AGENTS_PANEL_MAX_VISIBLE,
  stallMs: number = DEFAULT_STALL_MS,
  lingerMs: number = AGENTS_PANEL_LINGER_MS,
): readonly AgentPanelRow[] | null {
  const observeRow = formatObserveRow(observe);
  if (observeRow !== undefined)
    return observeRow === null ? null : [observeRow];

  if (agents === null || agents === undefined || agents.length === 0)
    return null;

  const running = agents.filter((s) => agentLaneIsLive(s));
  const lingering = agents.filter((s) => agentIsLingering(s, nowMs, lingerMs));
  if (running.length === 0 && lingering.length === 0) return null;

  // One sort for live lanes: trouble first; startedAt never churns, so the
  // board does not reshuffle on tool events. Lingering terminals trail,
  // newest first.
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
    (a, b) =>
      (b.finishedAt ?? 0) - (a.finishedAt ?? 0) ||
      a.agentId.localeCompare(b.agentId),
  );

  const ranked: AgentPanelRow[] = [
    ...rankedRunning.map(({ session, state }) =>
      formatAgentRow(session, state, nowMs, stallMs),
    ),
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
    // (geometry agents.max), like formatTasksPanel: do not steal a lane slot.
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

/** Map a chrome session into the shape `laneState` / `agentProgress` require;
 * missing clocks mean the helpers cannot run, so callers fall back to a safe
 * display default. */
function toProgressSession(
  session: ChromeAgentSession,
): AgentProgressSession | null {
  if (session.startedAt === undefined) return null;
  return {
    status: session.status,
    ...(session.lifecycleStatus !== undefined
      ? { lifecycleStatus: session.lifecycleStatus }
      : {}),
    currentToolName: session.currentToolName ?? null,
    currentToolPreview: session.currentToolPreview ?? null,
    currentToolStartedAt: session.currentToolStartedAt,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt ?? session.startedAt,
    ...(session.runInFlight !== undefined
      ? { runInFlight: session.runInFlight }
      : {}),
  };
}

/** Board lane word: `laneState` when clocks exist, else `working` — without
 * clocks we cannot claim stalled. */
function boardLaneState(
  session: ChromeAgentSession,
  nowMs: number,
  stallMs: number,
): LaneState {
  const progress = toProgressSession(session);
  if (progress === null) return "working";
  return laneState(progress, nowMs, stallMs);
}

/** Fit the strip into the rows geometry actually granted. The formatter sizes
 * to content, but collapse can grant fewer rows under pressure; painting the
 * full set would overflow the zone's box. The granted height wins; lost lanes
 * are disclosed via `+N more`, and prior counts carry into the re-clamp
 * total. */
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
  return [
    ...shown,
    { label: `+${hidden} more`, tail: "", stalled: false, kind: "more" },
  ];
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

function formatObserveRow(
  observe: ChromeLiveState["observe"],
): AgentPanelRow | null | undefined {
  if (observe === null || observe === undefined) return undefined;
  const id = observe.agentId.trim();
  const desc = observe.description.trim();
  if (id.length === 0 && desc.length === 0) return null;
  const label =
    id.length > 0 && desc.length > 0
      ? `${id} — ${desc}`
      : id.length > 0
        ? id
        : desc;
  return {
    label: `observe: ${label}`,
    tail: "",
    stalled: false,
    kind: "lane",
    status: "running",
  };
}

function formatAgentRow(
  session: ChromeAgentSession,
  state: LaneState,
  nowMs: number,
  stallMs: number,
): AgentPanelRow {
  const stalled = state === "stalled";
  // Rail grammar: ● live, ! quiet. The marker names the state so the tail
  // stays clock/tool only.
  const marker = stalled ? "!" : "●";
  const label = `${marker} ${session.agentId}  ${session.description}`.trim();
  // Prefer the argument subject (command / path) over the bare tool name so a
  // strip of shell calls is distinguishable at a glance.
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
  const progress =
    progressSession !== null
      ? agentProgress(progressSession, nowMs, stallMs)
      : null;
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
    session.status === "done"
      ? "done"
      : session.status === "failed"
        ? "failed"
        : "cancelled";
  return {
    label,
    tail: ` · ${word}`,
    stalled: failed,
    kind: "lane",
    status: session.status,
  };
}

/**
 * Overlay live per-agent tool names onto the agents zone. The subagent store
 * is the sole source of truth for what a worker is doing (`currentToolName`
 * + `currentToolStartedAt` clock). The `subagent.progress` ping carries only
 * a name with no clock, so painting it could announce a dead tool (the false
 * "quiet · read_file" stall) or a stale one — pings also fire on completion.
 *
 * Signature kept so call sites and tests migrate in their own diffs.
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

/** SubAgentSession-shaped strip row; `agentId` preferred, falling back to
 * `id` when the store only exposes a session id. */
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

/** Map real session shapes (tasks / subagent store) into ChromeLiveState for
 * `formatChromeZones` / `setChrome`. Pure and store-agnostic — pass whatever
 * the host already has; absent fields stay omitted. */
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
      ...(a.lifecycleStatus !== undefined
        ? { lifecycleStatus: a.lifecycleStatus }
        : {}),
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
      ...(a.finishedAt !== undefined ? { finishedAt: a.finishedAt } : {}),
      ...(a.runInFlight !== undefined ? { runInFlight: a.runInFlight } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Turn progress label + agent-send failure classification (pure; no renderer
// or session deps, so the shell paints the phase without duplicating the
// state machine that produces it)
// ---------------------------------------------------------------------------

/** Agent lifecycle status the progress label reads (mirrors the stream state). */
export type TurnStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "stopping"
  | "stopped";

export interface TurnLabelInput {
  readonly isProcessing: boolean;
  readonly status: TurnStatus;
  readonly currentToolName: string | null;
  readonly streamingType: "text" | "thinking" | "tool" | null;
  /** Clock for cycling live-activity words. Missing means the first word. */
  readonly nowMs?: number;
  /** Session is still occupied even if this parent turn has settled — live
   * fleet occupancy or a pending dry-fleet continuation. */
  readonly sessionActive?: boolean;
}

/** Closed set the status ticker may render — never a tool identifier, MCP
 * server name, or plugin name. The leak-prevention test checks membership
 * against this, so it stays the ticker vocabulary's single source of truth. */
export const ACTIVITY_STATES = [
  "working",
  "warping",
  "buzzing",
  "grinding",
  "thinking",
  "doing",
  "cooking",
  "creating",
  "imagining",
  "inventing",
  "planning",
  "researching",
  "building",
  "waiting",
  "stalled",
  "stopping",
] as const;

export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Words the lockup cycles while the session is live and not gated. */
export const LIVE_ACTIVITY_WORDS = [
  "working",
  "warping",
  "buzzing",
  "grinding",
  "thinking",
  "doing",
  "cooking",
  "creating",
  "imagining",
  "inventing",
] as const;

/** Execution → activity-state mapping with an explicit fallback: an unknown
 * tool (built-in, MCP, or plugin) renders generic "working" instead of
 * leaking its identifier — no ticker change needed to add a tool. */
const TOOL_ACTIVITY_STATES: Readonly<Record<string, ActivityState>> = {
  read_file: "researching",
  search_files: "researching",
  grep: "researching",
  list_dir: "researching",
  web_search: "researching",
  web_fetch: "researching",
  write_file: "building",
  edit_file: "building",
  run_shell: "building",
  delete_file: "building",
  manage_tasks: "planning",
  task: "planning",
  tool_search: "researching",
  search_agents: "researching",
  ask_operator: "waiting",
  submit_output: "working",
};

function activityStateForTool(name: string | null): ActivityState {
  if (name === null) return "working";
  return TOOL_ACTIVITY_STATES[name] ?? "working";
}

/** How long each live-activity word holds before the next. */
export const LIVE_WORD_MS = 4_000;

function liveActivityWord(nowMs: number): ActivityState {
  const index = Math.floor(nowMs / LIVE_WORD_MS) % LIVE_ACTIVITY_WORDS.length;
  return LIVE_ACTIVITY_WORDS[index] ?? "working";
}

function sessionIsLive(
  input: TurnLabelInput,
  fleet: FleetProgress | null,
): boolean {
  if (input.isProcessing) return true;
  if (input.sessionActive === true) return true;
  return fleet !== null && fleet.running > 0;
}

/**
 * Single session-phase label for the density ramp. Lowercase and
 * unpunctuated — the ramp's color and motion carry the state, so the word
 * only names it. Returns undefined when idle so the phase segment disappears.
 *
 * `isStalled` is the caller's own `isStalledForDisplay` result (see
 * stall-watchdog.ts); this function only ranks "stalled" against the other
 * phases. Required, not defaulted — a caller that forgets it paints a wedged
 * run as ordinary work.
 */
export function resolveTurnLabel(
  input: TurnLabelInput,
  isStalled: boolean,
  fleet: FleetProgress | null,
): ActivityState | undefined {
  const occupied = sessionIsLive(input, fleet);
  if (input.status === "blocked" && (input.isProcessing || occupied)) {
    return "waiting";
  }
  // Stopping is this parent turn aborting; a settled parent with live lanes
  // is still occupied — don't let a leftover stopping status blank the
  // lockup or freeze it on "stopping".
  if (
    input.isProcessing &&
    (input.status === "stopping" || input.status === "stopped")
  ) {
    return "stopping";
  }
  if (!occupied) return undefined;
  void isStalled;
  void activityStateForTool(input.currentToolName);
  return liveActivityWord(input.nowMs ?? 0);
}

/** Which ramp the turn paints: frozen-orange (blocked), solid-green (done),
 * blinking-orange (stalled), animating bronze (working). `isStalled` is the
 * caller's own `shouldNoticeStall` result — this function only orders it
 * against the other phases. */
export function resolveRampPhase(
  input: TurnLabelInput,
  isStalled: boolean,
  fleet: FleetProgress | null,
): RampPhase {
  if (input.status === "blocked") return "blocked";
  // Occupied session (live lanes or a pending continuation) keeps the working
  // ramp even if this parent turn settled as done.
  if (
    sessionIsLive(input, fleet) &&
    (input.sessionActive === true || (fleet !== null && fleet.running > 0))
  ) {
    void isStalled;
    return "working";
  }
  if (input.status === "done") return "done";
  void isStalled;
  return "working";
}

export type SendFailureKind = "abort" | "auth" | "error";

/** First-party auth_provider values only — never free-text provider labels. */
export type AuthProviderId = "codex" | "xai" | "anthropic" | "other";

export interface ClassifiedSendFailure {
  readonly kind: SendFailureKind;
  readonly authProvider: AuthProviderId | null;
}

// Message-only classification phrase matchers (stream carries bare strings);
// Codex/xAI constructors always emit the profile phrases below.
const CODEX_AUTH_MESSAGE = /\bcodex profile\b/i;
const XAI_AUTH_MESSAGE = /\bxai profile\b/i;
// Anthropic API-key rejections: authentication_error type, invalid x-api-key,
// or api key phrasing in 401 bodies.
const ANTHROPIC_AUTH_MESSAGE =
  /\b(?:anthropic|claude)\b.*\b(?:auth|unauthorized|api[\s_-]?key|x-api-key)\b|\bauthentication_error\b|\binvalid[\s_-]?x?-?api[\s_-]?key\b/i;
// Generic credential rejection when the provider cannot be named safely.
const GENERIC_AUTH_MESSAGE =
  /\b(?:401|403)\b|\bunauthorized\b|\binvalid[\s_-]?api[\s_-]?key\b|\bauthentication\b.*\bfail/i;

function authProviderFromMessage(message: string): AuthProviderId | null {
  if (CODEX_AUTH_MESSAGE.test(message)) return "codex";
  if (XAI_AUTH_MESSAGE.test(message)) return "xai";
  if (ANTHROPIC_AUTH_MESSAGE.test(message)) return "anthropic";
  if (GENERIC_AUTH_MESSAGE.test(message)) return "other";
  return null;
}

/** Classify agent.send() rejection so the TUI can settle UI state consistently. */
export function classifyAgentSendFailure(
  err: unknown,
  aborted: boolean,
  isCodexAuth: (e: unknown) => boolean,
  isXaiAuth: (e: unknown) => boolean,
): ClassifiedSendFailure {
  if (aborted) return { kind: "abort", authProvider: null };
  if (isCodexAuth(err)) return { kind: "auth", authProvider: "codex" };
  if (isXaiAuth(err)) return { kind: "auth", authProvider: "xai" };
  const message = err instanceof Error ? err.message : String(err);
  const authProvider = authProviderFromMessage(message);
  if (authProvider !== null) return { kind: "auth", authProvider };
  return { kind: "error", authProvider: null };
}

export function shouldSettleUiAfterSendFailure(kind: SendFailureKind): boolean {
  return kind === "auth" || kind === "error";
}

/** Report which provider rejected the stored credentials; silent otherwise. */
export function captureAuthFailure(
  telemetry: Telemetry,
  failure: ClassifiedSendFailure,
): void {
  if (failure.kind !== "auth" || failure.authProvider === null) return;
  telemetry.capture("auth_failure", { auth_provider: failure.authProvider });
}

/** Same classification as `classifyAgentSendFailure`, from the message alone. */
export function classifySendFailureMessage(
  message: string,
): ClassifiedSendFailure {
  const authProvider = authProviderFromMessage(message);
  if (authProvider !== null) return { kind: "auth", authProvider };
  return { kind: "error", authProvider: null };
}

const AUTH_FAILURE_TEXT: Record<AuthProviderId, string> = {
  codex: "your chatgpt sign-in expired — /model to sign in again",
  xai: "your x.ai sign-in expired — /model to sign in again",
  anthropic:
    "your anthropic api key was rejected — /model to update credentials",
  other: "provider credentials were rejected — /model to sign in again",
};

/** Transcript body for a failed send. A recognised failure says what happened
 * and what to press; anything else keeps the raw message rather than
 * swallowing the only detail the operator has. */
export function sendFailureText(message: string): string {
  // Classified inference.error lines are already operator-facing; rematching
  // rewrites intentional copy ("Authentication failed — log in again."
  // → generic other).
  if (message === CREDENTIAL_FAILURE_USER_MESSAGE) return message;
  const failure = classifySendFailureMessage(message);
  if (failure.kind === "auth" && failure.authProvider !== null) {
    return AUTH_FAILURE_TEXT[failure.authProvider];
  }
  return message;
}
