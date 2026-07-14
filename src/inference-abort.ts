/** AbortSignal.reason values used by the TUI send path and harness classification. */
export const INFERENCE_ABORT_USER_STOP = "user-stop" as const;
export const INFERENCE_ABORT_INTERNAL_RECOVERY = "internal-recovery" as const;

export type InferenceAbortReason =
  | typeof INFERENCE_ABORT_USER_STOP
  | typeof INFERENCE_ABORT_INTERNAL_RECOVERY
  | string;

export type ClassifiedAbortRaw = { origin: InferenceAbortReason };

export function isInternalRecoveryAbortRaw(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "origin" in raw &&
    (raw as ClassifiedAbortRaw).origin === INFERENCE_ABORT_INTERNAL_RECOVERY
  );
}