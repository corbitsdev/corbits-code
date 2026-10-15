// Provenance authentication for typed approval messages on the inbound rail.
//
// A correlation ID is a bearer capability: the vendored reactor resolves any
// inbound message whose interchangeCorrelationId matches a registered pending
// operation, with no sender check (vendor/intx-inference/src/reactor.ts
// tryCorrelate; upstream deleted `expectedFrom`). A learned ID plus a forged
// approval.granted would grant one-shot bypass and re-dispatch the parked
// call; a forged approval.denied injects denials into history. Upstream's
// injection point is the `CorrelationValidator` interface it consumes inside
// tryCorrelate, but the vendored `@intx/agent` layer forwards no such
// validator to `createReactorAssembly` and its env contract exposes none, so
// the app enforces the same policy at its inbound-delivery seam: only the
// local approval-delivery path (src/session/approval-resume.ts
// decisionMessage) produces typed approvals, and every other ingress is
// foreign.
//
// The gateId half of the decision binding stays in the vendored reactor:
// tryCorrelate's isLiveApproval requires the gate named by the pending
// operation to still hold the correlation id and be unexpired, and an
// app-side gate cannot see that gate table.

import type { CorrelationValidator } from "@intx/inference";
import type { InboundMessage } from "@intx/types/runtime";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { redactedCorrelationId } from "./redacted-correlation.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "approval-provenance"]);

/** Sender identity the local approval-delivery path stamps on decisions. */
export const LOCAL_APPROVAL_FROM = "approval@local";
/** Mailbox the local approval-delivery path ships decisions from. */
export const LOCAL_APPROVAL_MAILBOX = "approval";

export function typedApprovalType(
  interchangeType: string | undefined,
): "approval.granted" | "approval.denied" | undefined {
  return interchangeType === "approval.granted" ||
    interchangeType === "approval.denied"
    ? interchangeType
    : undefined;
}

/**
 * True for a typed approval that did not originate on the local
 * approval-delivery path. Fails closed: a message whose ref names no mailbox
 * (or a wrong sender) never matches, so mailbox and system ingress are
 * foreign by default.
 */
export function isForeignApprovalIngress(message: InboundMessage): boolean {
  if (typedApprovalType(message.headers.interchangeType) === undefined)
    return false;
  return (
    message.headers.from !== LOCAL_APPROVAL_FROM ||
    message.ref?.mailbox !== LOCAL_APPROVAL_MAILBOX
  );
}

/**
 * The app's correlation validator, expressed on the vendored
 * `CorrelationValidator` interface the reactor consumes inside tryCorrelate.
 * Only provenance is checked here: gate id, liveness and deadline binding
 * belong to the reactor, which re-checks them around the validator. A false
 * return discards a typed approval without receipts or history, leaving the
 * pending operation live for the real operator's decision.
 */
export function createApprovalCorrelationValidator(): CorrelationValidator {
  return {
    validate: (_pending, message) =>
      Promise.resolve(!isForeignApprovalIngress(message)),
  };
}

/**
 * Wrap an agent-shaped inbound-delivery surface so typed approvals outside
 * the local approval-delivery path are dropped before the reactor can
 * correlate them. Dropped forgeries get a warn receipt; nonapproval traffic
 * (operator input, completions, continuations) is untouched.
 */
export function createApprovalProvenanceGate<
  T extends { deliver: (message: InboundMessage) => void },
>(inner: T): T {
  return {
    ...inner,
    deliver(message: InboundMessage): void {
      if (isForeignApprovalIngress(message)) {
        // The log sink (src/logging/sink.ts) records debug level too, so the
        // receipt trail must not carry the full bearer capability at any
        // level — warn and debug both use the redacted form here, and the
        // full ID stays only on the in-memory transport that consumes it.
        logger.warn`forged approval discarded, foreign ingress correlationId=${redactedCorrelationId(message.headers.interchangeCorrelationId ?? "?")} from=${message.headers.from} mailbox=${message.ref?.mailbox ?? "<none>"} type=${message.headers.interchangeType}`;
        return;
      }
      inner.deliver(message);
    },
  };
}
