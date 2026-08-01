import type { AgentStatus } from "./use-stream.js";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  type InferenceAbortReason,
} from "../inference-abort.js";

// How long the run can be continuously awaiting a response with no new content
// before the watchdog fires and aborts the in-flight request.
export const STALL_TIMEOUT_MS = 900_000;

export type ShouldAbortForStallArgs = {
  status: AgentStatus;
  awaitingResponse: boolean;
  lastActivityAt: number;
  nowMs: number;
  stallTimeoutMs: number;
  isProcessing: boolean;
  streamingType: "text" | "thinking" | "tool" | null;
};

// Pure decision helper: returns true when the run is genuinely stuck and should
// be aborted. Extracted so the timeout logic is unit-testable without a React harness.
export function shouldAbortForStall({
  status,
  awaitingResponse,
  lastActivityAt,
  nowMs,
  stallTimeoutMs,
  isProcessing,
  streamingType,
}: ShouldAbortForStallArgs): boolean {
  if (status !== "running") return false;
  const stalled = nowMs - lastActivityAt >= stallTimeoutMs;
  if (!stalled) return false;
  if (awaitingResponse) return true;
  // Mid-stream hang: model stream stalled after first token. Long
  // in-flight tool runs do not emit parent stream events; do not abort those.
  if (
    isProcessing &&
    streamingType !== null &&
    streamingType !== "tool"
  ) {
    return true;
  }
  return false;
}

export type ApplyStallRecoveryDeps = {
  abortInFlight: (reason: InferenceAbortReason) => void;
  setCommandMessage: (message: string) => void;
};

/** Abort the in-flight send; ChatDirector continues via infer() on internal-recovery. */
export function applyStallRecovery(deps: ApplyStallRecoveryDeps): void {
  deps.abortInFlight(INFERENCE_ABORT_INTERNAL_RECOVERY);
  deps.setCommandMessage("Recovering after an internal stall...");
}
