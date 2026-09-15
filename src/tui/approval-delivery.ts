/**
 * Bounded deliver-and-await-acceptance for approval decisions.
 *
 * The reactor accepts a correlated decision asynchronously after deliver()
 * returns, so the sessionOps tail waits for the correlation-acceptance signal.
 * That wait was unbounded: any delivery that produces no observed stream event
 * (reactor deliver() silently drops when done, an approved hold with no
 * tool.start, a missed correlation event) wedged the serial tail forever, and
 * every later approval — send_input answers, interrupt_agent releases,
 * ask_operator escalations — queued behind it until the reactor approval
 * timeout. The vendored reactor surface ({ start, deliver, abort }) exposes no
 * liveness query, so absent acceptance is treated as delivery failure: bound
 * the wait with a deadline race that settles the waiter, logs, and lets the
 * tail advance.
 *
 * Retry safety: once deliver() has returned, the reactor may hold the decision
 * even though no acceptance was observed. A retry for the same correlationId
 * must not hand the decision over twice (a duplicate approved decision could
 * re-dispatch the parked call), so it re-awaits acceptance only. A retry after
 * a deliver() throw re-delivers, because nothing was handed over.
 */

import type { InboundMessage } from "@intx/types/runtime";

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "approval-delivery"]);

/**
 * Deadline for the reactor to observably accept a delivered approval decision.
 * Far above normal tick latency (acceptance usually lands within a reactor
 * tick, including the approved hold until tool.start) and far below the
 * vendored reactor approval timeout, so one stuck delivery fails fast instead
 * of wedging the tail.
 */
export const APPROVAL_ACCEPTANCE_TIMEOUT_MS = 30_000;

export type ApprovalDecisionOutcome = "approved" | "rejected" | "unknown";

export class ApprovalDeliveryTimeoutError extends Error {
  readonly correlationId: string;
  readonly stage = "reactor-acceptance";
  readonly timeoutMs: number;
  readonly outcome: ApprovalDecisionOutcome;
  /** deliver() returned, so the reactor may still act on the decision. */
  readonly mayStillApply = true;

  constructor(args: {
    correlationId: string;
    timeoutMs: number;
    outcome: ApprovalDecisionOutcome;
  }) {
    const action =
      args.outcome === "approved"
        ? "the approved action may still run"
        : args.outcome === "rejected"
          ? "the parked call may still be answered by this decision"
          : "the decision may still be applied";
    super(
      `approval delivery timed out waiting for reactor acceptance ` +
        `(correlationId=${args.correlationId}, stage=reactor-acceptance, ` +
        `timeoutMs=${args.timeoutMs}, outcome=${args.outcome}). ` +
        `The decision was handed to the reactor but no acceptance event was ` +
        `observed, so ${action}. Do not re-deliver: the delivery tail has ` +
        `advanced. Check run state, then use interrupt_agent to release the ` +
        `parked worker if it is still parked.`,
    );
    this.name = "ApprovalDeliveryTimeoutError";
    this.correlationId = args.correlationId;
    this.timeoutMs = args.timeoutMs;
    this.outcome = args.outcome;
  }
}

function decisionOutcome(message: InboundMessage): ApprovalDecisionOutcome {
  if (message.content === undefined) return "unknown";
  let raw: unknown;
  try {
    raw = JSON.parse(message.content);
  } catch {
    return "unknown";
  }
  if (raw === null || typeof raw !== "object") return "unknown";
  const outcome = (raw as { outcome?: unknown }).outcome;
  return outcome === "approved" || outcome === "rejected" ? outcome : "unknown";
}

export interface ApprovalAcceptance {
  wait(correlationId: string): Promise<void>;
  settle(correlationId: string): void;
  abandon(correlationId: string): void;
}

export interface ApprovalDelivererDeps {
  deliverToAgent: (message: InboundMessage) => void;
  acceptance: ApprovalAcceptance;
  timeoutMs?: number;
  onTimeout?: (err: ApprovalDeliveryTimeoutError) => void;
}

export interface ApprovalDeliverer {
  deliver: (message: InboundMessage) => Promise<void>;
}

export function createApprovalDeliverer(
  deps: ApprovalDelivererDeps,
): ApprovalDeliverer {
  const timeoutMs = deps.timeoutMs ?? APPROVAL_ACCEPTANCE_TIMEOUT_MS;
  const delivered = new Set<string>();

  const awaitAcceptance = async (
    correlationId: string,
    accepted: Promise<void>,
    outcome: ApprovalDecisionOutcome,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        accepted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            deps.acceptance.abandon(correlationId);
            const err = new ApprovalDeliveryTimeoutError({
              correlationId,
              timeoutMs,
              outcome,
            });
            logger.warn`approval acceptance timed out correlation=${correlationId} timeoutMs=${timeoutMs} outcome=${outcome}`;
            deps.onTimeout?.(err);
            reject(err);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    deliver: async (message) => {
      const correlationId = message.headers.interchangeCorrelationId;
      if (correlationId === undefined) {
        deps.deliverToAgent(message);
        return;
      }
      if (delivered.has(correlationId)) {
        await awaitAcceptance(
          correlationId,
          deps.acceptance.wait(correlationId),
          decisionOutcome(message),
        );
        return;
      }
      const accepted = deps.acceptance.wait(correlationId);
      try {
        deps.deliverToAgent(message);
      } catch (err) {
        deps.acceptance.settle(correlationId);
        throw err;
      }
      delivered.add(correlationId);
      await awaitAcceptance(correlationId, accepted, decisionOutcome(message));
    },
  };
}
