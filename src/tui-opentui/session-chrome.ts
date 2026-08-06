/**
 * Single-phase turn progress label plus agent-send failure classification.
 *
 * Pure: no renderer or session deps, so the shell can paint the phase without
 * duplicating the state machine that produces it.
 */

/** Agent lifecycle status the progress label reads (mirrors the stream state). */
export type TurnStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "stopping"
  | "stopped"

export type SpinnerLabelInput = {
  readonly isProcessing: boolean
  readonly status: TurnStatus
  readonly awaitingResponse: boolean
  readonly currentToolName: string | null
  readonly streamingType: "text" | "thinking" | "tool" | null
}

/**
 * Single session-phase label for the status row (one indicator, not competing
 * spinners). Returns undefined when idle so the phase segment disappears.
 */
export function resolveSessionSpinnerLabel(
  input: SpinnerLabelInput,
): string | undefined {
  if (!input.isProcessing) return undefined
  if (input.status === "blocked") return "Waiting for approval…"
  if (input.status === "stopping" || input.status === "stopped") {
    return "Stopping…"
  }
  if (input.currentToolName !== null || input.streamingType === "tool") {
    return "Running tool…"
  }
  if (input.streamingType === "thinking") return "Thinking…"
  if (input.streamingType === "text") return "Responding…"
  return "Working…"
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
