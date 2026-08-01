import { useEffect, type RefObject } from "react";
import type { AgentStreamView } from "../use-stream.js";
import { shouldAutoRetryQuota } from "../quota-retry.js";

export type UseQuotaRetryArgs = {
  state: AgentStreamView;
  stateRef: RefObject<AgentStreamView>;
  lastSentMessageRef: RefObject<string>;
  quotaAutoRetryFiredRef: RefObject<boolean>;
  sendMessageRef: RefObject<(message: { text: string; attachments: [] }) => void>;
};

// When a quota error is active, poll once per second and auto-resubmit the
// last prompt as soon as the provider's retry-after window expires.
export function useQuotaRetry({
  state,
  stateRef,
  lastSentMessageRef,
  quotaAutoRetryFiredRef,
  sendMessageRef,
}: UseQuotaRetryArgs): void {
  useEffect(() => {
    if (state.quotaError === null) return;
    const interval = setInterval(() => {
      if (
        !shouldAutoRetryQuota({
          quotaError: stateRef.current.quotaError,
          alreadyFired: quotaAutoRetryFiredRef.current,
          nowMs: Date.now(),
          lastSentMessage: lastSentMessageRef.current,
        })
      ) {
        return;
      }
      quotaAutoRetryFiredRef.current = true;
      sendMessageRef.current({ text: lastSentMessageRef.current, attachments: [] });
    }, 1000);
    return () => clearInterval(interval);
  // `state` is a stable mutable object — only `quotaError` drives re-subscription.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.quotaError]);
}
