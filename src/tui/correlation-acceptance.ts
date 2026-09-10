/**
 * Occupancy wait for a fire-and-forget Agent.deliver of a correlated
 * approval. The reactor accepts the resume asynchronously after deliver
 * returns; inFlight must not drop until that acceptance (or an uncorrelated
 * pass-through / identity bump) settles the waiter. An approved re-dispatch
 * is not idle at message.correlated — occupancy holds until tool.start.
 */

import { ApprovalDecision } from "@intx/types";
import { type } from "arktype";

export interface CorrelationStreamEvent {
  type: string;
  data?: unknown;
}

function isApprovedDecision(content: string | undefined): boolean {
  if (content === undefined) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return false;
  }
  const decision = ApprovalDecision(raw);
  if (decision instanceof type.errors) return false;
  return decision.outcome === "approved";
}

function correlatedMessage(data: unknown): {
  correlationId: string | undefined;
  content: string | undefined;
  receivedCorrelationId: string | undefined;
} {
  if (data === null || typeof data !== "object") {
    return { correlationId: undefined, content: undefined, receivedCorrelationId: undefined };
  }
  const record = data as {
    correlationId?: unknown;
    message?: {
      headers?: { interchangeCorrelationId?: unknown };
      content?: unknown;
    };
  };
  return {
    correlationId: typeof record.correlationId === "string" ? record.correlationId : undefined,
    content: typeof record.message?.content === "string" ? record.message.content : undefined,
    receivedCorrelationId:
      typeof record.message?.headers?.interchangeCorrelationId === "string"
        ? record.message.headers.interchangeCorrelationId
        : undefined,
  };
}

export function createCorrelationAcceptance() {
  const waiters = new Map<string, () => void>();
  const holdUntilToolStart = new Set<string>();

  const settle = (correlationId: string): void => {
    holdUntilToolStart.delete(correlationId);
    const resolve = waiters.get(correlationId);
    if (resolve === undefined) return;
    waiters.delete(correlationId);
    resolve();
  };

  const settleHeldForToolStart = (): void => {
    for (const correlationId of [...holdUntilToolStart]) settle(correlationId);
  };

  return {
    wait(correlationId: string): Promise<void> {
      const pending = waiters.get(correlationId);
      return new Promise<void>((resolve) => {
        waiters.set(correlationId, () => {
          pending?.();
          resolve();
        });
      });
    },
    settle,
    settleAll(): void {
      holdUntilToolStart.clear();
      for (const correlationId of [...waiters.keys()]) settle(correlationId);
    },
    observe(event: CorrelationStreamEvent): void {
      if (event.type === "tool.start") {
        settleHeldForToolStart();
        return;
      }
      const fields = correlatedMessage(event.data);
      if (event.type === "message.received") {
        if (fields.receivedCorrelationId !== undefined) settle(fields.receivedCorrelationId);
        return;
      }
      if (event.type === "message.correlated") {
        if (fields.correlationId === undefined) return;
        if (isApprovedDecision(fields.content)) {
          holdUntilToolStart.add(fields.correlationId);
          return;
        }
        settle(fields.correlationId);
      }
    },
  };
}
