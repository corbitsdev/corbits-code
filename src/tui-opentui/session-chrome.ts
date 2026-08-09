/**
 * Single-phase turn progress label plus agent-send failure classification.
 *
 * Pure: no renderer or session deps, so the shell can paint the phase without
 * duplicating the state machine that produces it.
 */

import type { Telemetry } from "../telemetry/index.js"
import type { FleetProgress } from "./agent-progress.js"
import type { RampPhase } from "./ramp.js"

/** Agent lifecycle status the progress label reads (mirrors the stream state). */
export type TurnStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "stopping"
  | "stopped"

export type TurnLabelInput = {
  readonly isProcessing: boolean
  readonly status: TurnStatus
  readonly currentToolName: string | null
  readonly streamingType: "text" | "thinking" | "tool" | null
}

/**
 * Closed set the status ticker is allowed to render. Every path through
 * `resolveTurnLabel` returns one of these — never a tool identifier, MCP
 * server name, or plugin name. This is what the leak-prevention test checks
 * membership against, so it must stay the single source of truth for "what
 * can appear in the ticker."
 */
export const ACTIVITY_STATES = [
  "thinking",
  "planning",
  "researching",
  "building",
  "working",
  "waiting",
  "orchestrating",
  "stalled",
  "stopping",
] as const

export type ActivityState = (typeof ACTIVITY_STATES)[number]

/**
 * Execution → activity-state mapping, kept in this one place with an
 * explicit fallback so a newly added tool (built-in, MCP, or plugin) renders
 * a generic "working" state instead of leaking its identifier — no ticker
 * change is required to add a tool correctly.
 */
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
  advance_workflow: "planning",
  tool_search: "researching",
  search_agents: "researching",
  ask_operator: "waiting",
  submit_output: "working",
}

function activityStateForTool(name: string | null): ActivityState {
  if (name === null) return "working"
  return TOOL_ACTIVITY_STATES[name] ?? "working"
}

/**
 * Single session-phase label accompanying the density ramp. Lowercase and
 * unpunctuated — the ramp's color and motion carry the state, so the word only
 * has to name it. Returns undefined when idle so the phase segment disappears.
 *
 * `isStalled` is the caller's own `isStalledForDisplay` result (see
 * stall-watchdog.ts) — this function does not re-derive staleness, it only
 * ranks "stalled" against the other phases so the ticker and the ramp never
 * disagree about which runs look stuck. Required, not defaulted: a caller
 * that forgets to pass it is exactly the bug this state exists to prevent —
 * a wedged run silently painted as ordinary work.
 */
export function resolveTurnLabel(
  input: TurnLabelInput,
  isStalled: boolean,
  fleet: FleetProgress | null,
): ActivityState | undefined {
  if (!input.isProcessing) return undefined
  if (input.status === "blocked") return "waiting"
  if (input.status === "stopping" || input.status === "stopped") {
    return "stopping"
  }
  // Live lanes outrank the parent's own stall clock: while sub-agents run the
  // parent is idle by design, so its silence says nothing about the session.
  // The fleet is the thing actually working, so it is the thing reported.
  if (fleet !== null && fleet.running > 0) {
    return fleet.stalled > 0 ? "stalled" : "orchestrating"
  }
  if (isStalled) return "stalled"
  if (input.currentToolName !== null) return activityStateForTool(input.currentToolName)
  if (input.streamingType === "thinking") return "thinking"
  return "working"
}

/**
 * Which ramp the turn paints: frozen-orange (blocked), solid-green (done),
 * blinking-orange (stalled), or animating bronze (working). `isStalled` is
 * the caller's own `shouldNoticeStall` result — this function does not
 * re-derive staleness, it only orders it against the other phases.
 */
export function resolveRampPhase(
  input: TurnLabelInput,
  isStalled: boolean,
  fleet: FleetProgress | null,
): RampPhase {
  if (input.status === "blocked") return "blocked"
  if (input.status === "done") return "done"
  if (fleet !== null && fleet.running > 0) {
    return fleet.stalled > 0 ? "stalled" : "working"
  }
  if (isStalled) return "stalled"
  return "working"
}

export type SendFailureKind = "abort" | "codex_auth" | "xai_auth" | "error"

/** Classify agent.send() rejection so the TUI can settle UI state consistently. */
export function classifyAgentSendFailure(
  err: unknown,
  aborted: boolean,
  isCodexAuth: (e: unknown) => boolean,
  isXaiAuth: (e: unknown) => boolean,
): SendFailureKind {
  if (aborted) return "abort"
  if (isCodexAuth(err)) return "codex_auth"
  if (isXaiAuth(err)) return "xai_auth"
  return "error"
}

export function shouldSettleUiAfterSendFailure(kind: SendFailureKind): boolean {
  return kind === "codex_auth" || kind === "xai_auth" || kind === "error"
}

// Send-failure kinds are first-party constants, so the provider each one names
// is a fixed mapping rather than a classification over author-chosen text.
const AUTH_FAILURE_PROVIDERS: Partial<Record<SendFailureKind, string>> = {
  codex_auth: "codex",
  xai_auth: "xai",
}

/** Report which provider rejected the stored credentials; silent otherwise. */
export function captureAuthFailure(telemetry: Telemetry, kind: SendFailureKind): void {
  const provider = AUTH_FAILURE_PROVIDERS[kind]
  if (provider === undefined) return
  telemetry.capture("auth_failure", { auth_provider: provider })
}

// The stream carries a failure as a bare message string, so the auth errors are
// recognised by the profile phrase their constructors always produce
// (`Codex profile "default" is not authorized. …`).
const CODEX_AUTH_MESSAGE = /\bcodex profile\b/i
const XAI_AUTH_MESSAGE = /\bxai profile\b/i

/** Same classification as `classifyAgentSendFailure`, from the message alone. */
export function classifySendFailureMessage(message: string): SendFailureKind {
  if (CODEX_AUTH_MESSAGE.test(message)) return "codex_auth"
  if (XAI_AUTH_MESSAGE.test(message)) return "xai_auth"
  return "error"
}

const AUTH_FAILURE_TEXT: Partial<Record<SendFailureKind, string>> = {
  codex_auth: "your chatgpt sign-in expired — /model to sign in again",
  xai_auth: "your x.ai sign-in expired — /model to sign in again",
}

/**
 * Transcript body for a failed send. A recognised failure says what happened
 * and what to press; anything else keeps the raw message rather than swallowing
 * the only detail the operator has.
 */
export function sendFailureText(message: string): string {
  return AUTH_FAILURE_TEXT[classifySendFailureMessage(message)] ?? message
}
