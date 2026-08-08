/**
 * Single-phase turn progress label plus agent-send failure classification.
 *
 * Pure: no renderer or session deps, so the shell can paint the phase without
 * duplicating the state machine that produces it.
 */

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
  readonly awaitingResponse: boolean
  readonly currentToolName: string | null
  readonly streamingType: "text" | "thinking" | "tool" | null
  /** Text deltas seen so far this turn; read only while `streamingType` is `text`. */
  readonly streamTokenCount?: number
}

/**
 * Single session-phase label accompanying the density ramp. Lowercase and
 * unpunctuated — the ramp's color and motion carry the state, so the word only
 * has to name it. Returns undefined when idle so the phase segment disappears.
 *
 * Text streaming carries a live count (`streaming 7 tok`) rather than the
 * bare word: it is the one phase with something to count, and the count is
 * what tells the operator the slot is not stalled.
 */
export function resolveTurnLabel(input: TurnLabelInput): string | undefined {
  if (!input.isProcessing) return undefined
  if (input.status === "blocked") return "blocked"
  if (input.status === "stopping" || input.status === "stopped") {
    return "stopping"
  }
  if (input.currentToolName !== null) return input.currentToolName
  if (input.streamingType === "tool") return "tool"
  if (input.streamingType === "thinking") return "thinking"
  if (input.streamingType === "text") {
    return `streaming ${String(input.streamTokenCount ?? 0)} tok`
  }
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
): RampPhase {
  if (input.status === "blocked") return "blocked"
  if (input.status === "done") return "done"
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
