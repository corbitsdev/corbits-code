import { createDefaultRetryPolicy } from "@intx/inference";
import type {
  InferenceError,
  RetryDecision,
  RetryPolicy,
  RetrySituation,
} from "@intx/types/runtime";
import {
  normalizeInferenceErrorForRetry,
  type InferenceErrorWithGoContext,
} from "../inference-gateway-error.js";
import {
  getProcessAdmissionQueue,
  type AdmissionQueue,
} from "../subagent/admission.js";
import { refreshSourceCredentialByProvenance } from "../auth/refresh-source-credential.js";
import {
  readSourceCredentialRecord,
  type SourceCredentialProvenance,
} from "../config/source-credentials.js";
import type { InferenceSource } from "@intx/types/runtime";

// Providers that enforce long-window quotas (e.g. monthly limits) set
// Retry-After to days or weeks. The default policy trusts that value and
// parks the session for the full duration; abort instead and surface the
// error so the user can switch providers or decide when to retry.
export const MAX_BLIND_WAIT_MS = 30_000;
const DEFAULT_PRESSURE_PAUSE_MS = 1_000;
const RATE_LIMIT_HANG_MS = 86_400_000;

export interface CorbitsRetryPolicyOptions {
  /**
   * Fallback catalog provider id for callers that do not supply a source in
   * RetrySituation. Harness calls use the frozen call-start source instead.
   */
  providerId?: string | (() => string | undefined);
  /** Process admission controller. Tests inject a stub; production omits. */
  admission?: AdmissionQueue;
  now?: () => number;
  refreshCredential?: (
    source: Readonly<InferenceSource>,
    provenance: Extract<SourceCredentialProvenance, { kind: "oauth" }>,
  ) => Promise<void>;
}

/**
 * Corbits retry policy. When `providerId` is set, merges it onto the error
 * before `normalizeInferenceErrorForRetry` so known-provider remappers (xAI
 * short 429 → retryable, Go, Codex) can gate on context the harness does not
 * attach to InferenceError today.
 */
export function createCorbitsRetryPolicy(
  options?: CorbitsRetryPolicyOptions,
): RetryPolicy {
  const defaultPolicy = createDefaultRetryPolicy();
  const admission = options?.admission ?? getProcessAdmissionQueue();
  const now = options?.now ?? Date.now;
  const normalizeError = (
    incoming: InferenceError,
    source?: Readonly<InferenceSource>,
  ): InferenceError => {
    const configuredProvider = options?.providerId;
    const stampedProviderId =
      source?.id ??
      (typeof configuredProvider === "function"
        ? configuredProvider()
        : configuredProvider);
    const contextual = incoming as InferenceErrorWithGoContext;
    const withProvider: InferenceErrorWithGoContext =
      stampedProviderId !== undefined && contextual.providerId === undefined
        ? { ...contextual, providerId: stampedProviderId }
        : contextual;
    return normalizeInferenceErrorForRetry(withProvider);
  };
  const policy = (
    situation: RetrySituation,
  ): RetryDecision | Promise<RetryDecision> => {
    const error = normalizeError(situation.error, situation.source);
    if (
      error.category === "credential_failure" &&
      situation.credentialFailureOrdinal === 1 &&
      situation.source !== undefined
    ) {
      let provenance: SourceCredentialProvenance;
      try {
        provenance = readSourceCredentialRecord(
          situation.source.credentialId,
        ).provenance;
      } catch {
        return { kind: "abort" };
      }
      if (provenance.kind === "oauth") {
        const refresh = options?.refreshCredential;
        const pending =
          refresh !== undefined
            ? refresh(situation.source, provenance)
            : refreshSourceCredentialByProvenance(
                situation.source.credentialId,
              ).then(() => undefined);
        return pending.then(
          () => ({ kind: "retry", delayMs: 0 }),
          (cause: unknown) => ({
            kind: "abort",
            error: {
              category: "credential_failure",
              providerId: situation.source?.id,
              message: `${provenance.provider} profile "${provenance.profile}" could not be refreshed${cause instanceof Error ? `: ${cause.message}` : ""}. Run /connect, choose ${provenance.provider}, and reconnect profile "${provenance.profile}".`,
            },
          }),
        );
      }
    }
    if (error.category === "retryable" && error.statusCode === 429) {
      const pauseMs = Math.min(
        error.retryAfterMs ?? DEFAULT_PRESSURE_PAUSE_MS,
        MAX_BLIND_WAIT_MS,
      );
      const configuredProvider = options?.providerId;
      const provider =
        (situation.error as InferenceErrorWithGoContext).providerId ??
        situation.source?.id ??
        (typeof configuredProvider === "function"
          ? configuredProvider()
          : configuredProvider) ??
        "unknown";
      admission.notePressure(provider, now() + pauseMs);
      // The vendored default retries `retryable` on a fixed 500/1000ms
      // schedule and ignores Retry-After. A 429 carries the server's pacing
      // instruction: honor the full window. Retrying early burns the attempt
      // budget while the server is still closed; days-long Retry-After is a
      // hang — abort rather than park the session. Attempt abort comes from
      // defaultPolicy so this path cannot drift from MAX_ATTEMPTS.
      if (error.retryAfterMs !== undefined) {
        if (error.retryAfterMs >= RATE_LIMIT_HANG_MS) return { kind: "abort" };
        const retryAfterMs = error.retryAfterMs;
        const honorRetryAfter = (decision: RetryDecision): RetryDecision =>
          decision.kind === "retry"
            ? { kind: "retry", delayMs: retryAfterMs }
            : decision;
        const decision = defaultPolicy({ ...situation, error });
        if (decision instanceof Promise) return decision.then(honorRetryAfter);
        return honorRetryAfter(decision);
      }
    }
    if (
      error.category === "quota_exhausted" &&
      error.retryAfterMs !== undefined &&
      error.retryAfterMs > MAX_BLIND_WAIT_MS
    ) {
      return { kind: "abort" };
    }
    return defaultPolicy({ ...situation, error });
  };
  return Object.assign(policy, { normalizeError });
}
