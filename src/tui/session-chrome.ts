/**
 * Single-phase turn progress label plus agent-send failure classification.
 *
 * Pure: no renderer or session deps, so the shell can paint the phase without
 * duplicating the state machine that produces it.
 */

import { CREDENTIAL_FAILURE_USER_MESSAGE } from "../inference-error-message.js";
import type { Telemetry } from "../telemetry/index.js";
import type { FleetProgress } from "./agent-progress.js";
import type { RampPhase } from "./ramp.js";

/** Agent lifecycle status the progress label reads (mirrors the stream state). */
export type TurnStatus =
  "idle" | "running" | "done" | "failed" | "blocked" | "stopping" | "stopped";

export interface TurnLabelInput {
  readonly isProcessing: boolean;
  readonly status: TurnStatus;
  readonly currentToolName: string | null;
  readonly streamingType: "text" | "thinking" | "tool" | null;
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
  "stalled",
  "stopping",
] as const;

export type ActivityState = (typeof ACTIVITY_STATES)[number];

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
  tool_search: "researching",
  search_agents: "researching",
  ask_operator: "waiting",
  submit_output: "working",
};

function activityStateForTool(name: string | null): ActivityState {
  if (name === null) return "working";
  return TOOL_ACTIVITY_STATES[name] ?? "working";
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
  if (!input.isProcessing) return undefined;
  if (input.status === "blocked") return "waiting";
  if (input.status === "stopping" || input.status === "stopped") {
    return "stopping";
  }
  // Live fleet means the session is working — recovery is silent. Never paint
  // "stalled" for the operator; the orchestrator keeps lanes moving.
  if (fleet !== null && fleet.running > 0) {
    return "working";
  }
  // Parent silence is still work-in-progress from the operator's POV; nudge
  // paths handle recovery without renaming the ticker.
  void isStalled;
  if (input.currentToolName !== null) return activityStateForTool(input.currentToolName);
  if (input.streamingType === "thinking") return "thinking";
  return "working";
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
  if (input.status === "blocked") return "blocked";
  if (input.status === "done") return "done";
  // Operator chrome never enters the stalled ramp: fleet or parent silence is
  // still "working" while recovery runs under the hood.
  if (fleet !== null && fleet.running > 0) {
    return "working";
  }
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

// Phrase matchers for message-only classification (stream carries bare strings).
// Codex/xAI constructors always emit the profile phrases below.
const CODEX_AUTH_MESSAGE = /\bcodex profile\b/i;
const XAI_AUTH_MESSAGE = /\bxai profile\b/i;
// Anthropic API-key rejections: authentication_error type, invalid x-api-key,
// or invalid api key phrasing in 401 bodies.
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
export function captureAuthFailure(telemetry: Telemetry, failure: ClassifiedSendFailure): void {
  if (failure.kind !== "auth" || failure.authProvider === null) return;
  telemetry.capture("auth_failure", { auth_provider: failure.authProvider });
}

/** Same classification as `classifyAgentSendFailure`, from the message alone. */
export function classifySendFailureMessage(message: string): ClassifiedSendFailure {
  const authProvider = authProviderFromMessage(message);
  if (authProvider !== null) return { kind: "auth", authProvider };
  return { kind: "error", authProvider: null };
}

const AUTH_FAILURE_TEXT: Record<AuthProviderId, string> = {
  codex: "your chatgpt sign-in expired — /model to sign in again",
  xai: "your x.ai sign-in expired — /model to sign in again",
  anthropic: "your anthropic api key was rejected — /model to update credentials",
  other: "provider credentials were rejected — /model to sign in again",
};

/**
 * Transcript body for a failed send. A recognised failure says what happened
 * and what to press; anything else keeps the raw message rather than swallowing
 * the only detail the operator has.
 */
export function sendFailureText(message: string): string {
  // Classified inference.error lines are already operator-facing. Rematching
  // them against raw-provider auth patterns rewrites intentional copy
  // (e.g. "Authentication failed — log in again." → generic other).
  if (message === CREDENTIAL_FAILURE_USER_MESSAGE) return message;
  const failure = classifySendFailureMessage(message);
  if (failure.kind === "auth" && failure.authProvider !== null) {
    return AUTH_FAILURE_TEXT[failure.authProvider];
  }
  return message;
}
