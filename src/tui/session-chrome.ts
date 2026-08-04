import type { AgentStatus } from "./use-stream.js";

export type SpinnerLabelInput = {
  isProcessing: boolean;
  status: AgentStatus;
  awaitingResponse: boolean;
  currentToolName: string | null;
  streamingType: "text" | "thinking" | "tool" | null;
};

/**
 * Single session-phase label for the footer progress row (Amp-quiet: one
 * indicator, not competing spinners). Returns undefined when idle so the
 * progress zone can collapse entirely.
 */
export function resolveSessionSpinnerLabel(input: SpinnerLabelInput): string | undefined {
  if (!input.isProcessing) return undefined;
  if (input.status === "blocked") return "Waiting for approval…";
  if (input.status === "stopping" || input.status === "stopped") return "Stopping…";
  if (input.currentToolName !== null || input.streamingType === "tool") return "Running tool…";
  if (input.streamingType === "thinking") return "Thinking…";
  if (input.streamingType === "text") return "Responding…";
  if (input.awaitingResponse) return "Working…";
  return "Working…";
}

export type SendFailureKind = "abort" | "codex_auth" | "xai_auth" | "error";

/** Classify agent.send() rejection so the TUI can settle UI state consistently. */
export function classifyAgentSendFailure(
  err: unknown,
  aborted: boolean,
  isCodexAuth: (e: unknown) => boolean,
  isXaiAuth: (e: unknown) => boolean,
): SendFailureKind {
  if (aborted) return "abort";
  if (isCodexAuth(err)) return "codex_auth";
  if (isXaiAuth(err)) return "xai_auth";
  return "error";
}

export function shouldSettleUiAfterSendFailure(kind: SendFailureKind): boolean {
  return kind === "codex_auth" || kind === "xai_auth" || kind === "error";
}