/**
 * Headless queued-approval reconciliation. When a grant widens mid-run, the
 * permission layer decides which already-queued requests it now covers and
 * settles them without a prompt (see isRequestCoveredByGrant in gate.ts,
 * which supplies the `covers` predicate this module drains against). A
 * rendering surface only enqueues its pending requests and dispatches
 * whatever settle calls come back — it never decides coverage itself.
 */

import type { EventEmitter } from "node:events";
import type { ApprovalOutcome, PermissionRequest } from "./types.js";

export interface QueuedApprovalSummary {
  readonly id: number;
  readonly tool: string;
  readonly agentLabel?: string;
}

export interface PermissionRequestQueue {
  /** Register a live request; the returned id is what settle/reconcile key on. */
  enqueue: (request: PermissionRequest, resolve: (outcome: ApprovalOutcome) => void) => number;
  /** Settle one entry (accept, deny, timeout, or abort). False once already settled. */
  settle: (id: number, outcome: ApprovalOutcome) => boolean;
  /** One line per still-queued request, for a queue-depth indicator. */
  list: () => readonly QueuedApprovalSummary[];
  /**
   * Auto-settle every queued request a newly-minted grant now covers, without
   * a prompt. Runs against a snapshot so settling mid-loop never skips or
   * double-visits an entry. Returns the ids settled.
   */
  reconcile: (covers: (request: PermissionRequest) => boolean) => readonly number[];
  /** Deny and remove everything still queued (session teardown) so no awaited resolve is left hanging. */
  drain: () => void;
  size: () => number;
}

export function createPermissionRequestQueue(): PermissionRequestQueue {
  const entries = new Map<
    number,
    { request: PermissionRequest; resolve: (outcome: ApprovalOutcome) => void }
  >();
  let nextId = 1;

  const settle = (id: number, outcome: ApprovalOutcome): boolean => {
    const entry = entries.get(id);
    if (entry === undefined) return false;
    entries.delete(id);
    entry.resolve(outcome);
    return true;
  };

  return {
    enqueue: (request, resolve) => {
      const id = nextId++;
      entries.set(id, { request, resolve });
      return id;
    },
    settle,
    list: () =>
      [...entries.entries()].map(([id, entry]) => ({
        id,
        tool: entry.request.tool,
        ...(entry.request.agentLabel !== undefined ? { agentLabel: entry.request.agentLabel } : {}),
      })),
    reconcile: (covers) => {
      const coveredIds = [...entries.entries()]
        .filter(([, entry]) => covers(entry.request))
        .map(([id]) => id);
      return coveredIds.filter((id) => settle(id, { allow: true }));
    },
    drain: () => {
      for (const id of [...entries.keys()]) settle(id, { allow: false });
    },
    size: () => entries.size,
  };
}

export interface PermissionGrantEvent {
  readonly approval: { readonly tool: string; readonly pattern: string };
  readonly covers: (request: PermissionRequest) => boolean;
}

// `covers` is a function, which arktype cannot express in a schema, so this
// stays a plain runtime guard rather than the usual declarative boundary
// validator — the shape is still checked field by field.
function isPermissionGrantEvent(raw: unknown): raw is PermissionGrantEvent {
  if (raw === null || typeof raw !== "object") return false;
  const approval = (raw as Record<string, unknown>).approval;
  const covers = (raw as Record<string, unknown>).covers;
  if (approval === null || typeof approval !== "object") return false;
  const a = approval as Record<string, unknown>;
  return (
    typeof a.tool === "string" && typeof a.pattern === "string" && typeof covers === "function"
  );
}

/**
 * Drain `queue` of any request a grant now covers whenever `permission.grant`
 * fires (see PermissionGateOptions.onGrant for where that event originates).
 * Any approval surface — TUI or headless — gets reconciliation for free by
 * enqueuing its pending requests into a PermissionRequestQueue and calling
 * this once, instead of reimplementing the walk.
 */
export function wirePermissionGrantReconciliation(
  emitter: EventEmitter,
  queue: PermissionRequestQueue,
): () => void {
  const onGrant = (payload: unknown): void => {
    if (!isPermissionGrantEvent(payload)) return;
    queue.reconcile(payload.covers);
  };
  emitter.on("permission.grant", onGrant);
  return () => emitter.off("permission.grant", onGrant);
}
