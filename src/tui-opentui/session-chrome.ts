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
}

/**
 * Single session-phase label accompanying the density ramp. Lowercase and
 * unpunctuated — the ramp's color and motion carry the state, so the word only
 * has to name it. Returns undefined when idle so the phase segment disappears.
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
  if (input.streamingType === "text") return "responding"
  return "working"
}

/** Which ramp the turn paints: frozen-orange, solid-green, or animating blue. */
export function resolveRampPhase(input: TurnLabelInput): RampPhase {
  if (input.status === "blocked") return "blocked"
  if (input.status === "done") return "done"
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
