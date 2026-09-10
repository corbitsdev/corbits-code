/**
 * The operator-facing message for a rejected send (the inference-failure
 * contract the submit path reports through). Lives in its own leaf so the
 * submit and commands siblings never import each other.
 */
import type { InferenceErrorLike } from "../../inference-gateway-error.js";
import {
  CREDENTIAL_FAILURE_USER_MESSAGE,
  isResolvedProviderFailureError,
  terminalProviderFailureMessage,
} from "../../inference-error-message.js";
import type { InferenceAttemptIdentity } from "./state.js";

export function tuiSendFailureMessage(
  error: unknown,
  failureKind: "auth" | "error",
  providerFailureObserved: boolean,
  attempt: InferenceAttemptIdentity,
  providerError?: InferenceErrorLike,
): string {
  if (failureKind === "auth") {
    return CREDENTIAL_FAILURE_USER_MESSAGE;
  }
  if (!providerFailureObserved && !isResolvedProviderFailureError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const providerId =
    providerError?.providerId ??
    (isResolvedProviderFailureError(error)
      ? error.providerId
      : attempt.providerId);
  const displayLabel =
    providerId === attempt.providerId ? attempt.displayLabel : undefined;
  if (providerError === undefined && isResolvedProviderFailureError(error))
    return error.message;
  const diagnostic = providerError ?? {
    category: "fatal",
    message: error instanceof Error ? error.message : String(error),
  };
  return terminalProviderFailureMessage(providerId, diagnostic, displayLabel);
}
