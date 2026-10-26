// Resume path for reactor approval suspensions.
//
// When the reactor's authz hook suspends an ask-tier call, agent.send()
// settles with { type: "suspended", correlationId, approvalSnapshot }. The
// parked call has no tool result and no resolve closure — its identity is the
// correlationId, persisted as a PendingOperation by the reactor. This module
// rebuilds the operator-facing request from the snapshot, resolves it through
// the gate's requestApproval seam, and delivers the decision back to the
// reactor as a correlated inbound message: approved grants the call's one-shot
// bypass and the reactor re-dispatches the exact parked call; rejected answers
// it with an error result.

import type { Agent, SendResult } from "@intx/agent";
import type {
  ApprovalSnapshot,
  ContextStore,
  InboundMessage,
} from "@intx/types/runtime";
import { type } from "arktype";

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import type { DroppedApprovalCalls } from "../agent/director.js";
import {
  inspectShellSecretReference,
  shellSecretInspectionRequiresApproval,
  createExtraDeniedPathMatcher,
} from "../plugins/secret-guard-plugin.js";
import { APPROVAL_TIMEOUT_RESULT_TEXT } from "../permission/decline-markers.js";
import { buildRequests } from "../permission/classify.js";
import type { PermissionGate } from "../permission/gate.js";
import type { PermissionRequest } from "../permission/types.js";
import { scrubSecretShapedContent } from "../plugins/tool-result-secret-scrub.js";
import {
  LOCAL_APPROVAL_FROM,
  LOCAL_APPROVAL_MAILBOX,
} from "./approval-provenance.js";
import {
  redactedCorrelationId,
  scrubCorrelationShapedIds,
} from "./redacted-correlation.js";
import { snapshotArgumentsMatch } from "./pending-snapshot-scrub.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "approval-resume"]);

export const APPROVAL_DROPPED_NOTICE =
  "Approval dropped because the session changed.";

const ApprovalSnapshotShape = type({
  name: "string",
  "arguments?": "Record<string, unknown>",
  "approvalMode?": "'allow-once'",
});

export interface ApprovalResume {
  /**
   * Settle a suspended send: show the approval surface, then deliver the
   * operator's decision to the reactor on the correlationId signal channel.
   * Resolves once the decision is delivered (the resumed run continues
   * asynchronously on the reactor loop); returns false for non-suspension
   * results so callers forward them unchanged.
   */
  handle: (result: SendResult) => Promise<boolean>;
  /**
   * Where a correlation's settlement stands: `idle` when nothing is gating or
   * has been handed over, so a fresh `handle` would open the operator surface.
   */
  status: (correlationId: string) => "idle" | "in-flight" | "handed-over";
  /** Handed to every director the session builds. */
  readonly droppedCalls: DroppedApprovalCalls;
  /**
   * Between the outgoing agent's close and the next build, for a rebuild
   * that keeps the session: registers the call of each unsettled approval
   * `storage` still shows parked, so a rehydrated deadline that fires before
   * `settleOn` reads the rebuilt store still settles it without a turn, and
   * forgets the ones it shows closed. No reactor holds the store then, so a
   * closed call can never produce another result.
   */
  prepareRebuild: (storage: Pick<ContextStore, "load">) => Promise<void>;
  /**
   * After that rebuild: rejects each unsettled approval still parked in
   * `storage` on `agent`, the agent built from it, and forgets the ones the
   * store shows closed. One still parked is rejected again on every rebuild
   * until the store shows it closed, since a reactor closed before accepting
   * the rejection discards it; a rejection of a settled call is unmatched.
   */
  settleOn: (
    agent: Pick<Agent, "deliver">,
    storage: Pick<ContextStore, "load">,
  ) => Promise<void>;
  /** On rotation: nothing in the new session can settle these. */
  forgetUnsettled: () => void;
}

/**
 * What a watchdog resume attempt did. `code` is content-free (a fixed
 * vocabulary, never approval or tool payload) so it can go into a turn marker.
 * `detail` carries the failed attempt's cause — the error class plus a
 * secret-scrubbed message — for warn logs and diagnostics; it stays out of
 * turn markers, which inherit `code`'s content-free guarantee.
 */
export interface StallResumeResult {
  readonly handled: boolean;
  readonly code: string;
  readonly detail?: string;
}

/** The `reactor.gate.blocked` payload fields recovery reads. */
export interface ParkedGate {
  readonly reason: string;
  readonly correlationId?: string | undefined;
  readonly approvalSnapshot?: ApprovalSnapshot | undefined;
}

export interface SuspendedApprovalRecovery {
  capture: (
    result: Extract<SendResult, { type: "suspended" }>,
    stillCurrent: () => boolean,
  ) => void;
  /**
   * A gate parked outside a `send()` (a delivered wake, shell exit, or queued
   * prompt starts a cycle with no caller awaiting a result), so nothing else
   * hands the suspension to the operator. Presents it through the same
   * correlated approval path a send would, and keeps it as the watchdog's
   * candidate if presenting fails. A no-op when a settlement already exists.
   */
  observeParked: (gate: ParkedGate, stillCurrent: () => boolean) => void;
  clear: () => void;
  tryResumeOnce: (onPresenting?: () => void) => Promise<StallResumeResult>;
}

export function createSuspendedApprovalRecovery(args: {
  storage: () => Pick<ContextStore, "load"> | undefined;
  resume: ApprovalResume;
}): SuspendedApprovalRecovery {
  type Candidate = {
    readonly result: Extract<SendResult, { type: "suspended" }>;
    readonly stillCurrent: () => boolean;
    attempted: boolean;
  };
  let candidate: Candidate | undefined;
  const capture: SuspendedApprovalRecovery["capture"] = (
    result,
    stillCurrent,
  ) => {
    candidate = { result, stillCurrent, attempted: false };
  };
  // A refused attempt's cause: the error class plus a secret-scrubbed,
  // correlation-redacted message. Content is drained from thrown Errors,
  // never from approval or tool payloads, so warn lines stay safe to persist
  // unauthenticated: a bearer token or an embedded live correlation ID —
  // both re-grant a parked call — never lands in full form.
  const causeOf = (err: unknown): string => {
    const cls = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    return `${cls}: ${scrubCorrelationShapedIds(
      scrubSecretShapedContent(message),
    )}`;
  };
  const refused = (code: string, detail?: string): StallResumeResult => ({
    handled: false,
    code,
    ...(detail !== undefined ? { detail } : {}),
  });
  return {
    capture,
    observeParked: (gate, stillCurrent) => {
      const { correlationId, approvalSnapshot } = gate;
      if (
        gate.reason !== "approval" ||
        correlationId === undefined ||
        approvalSnapshot === undefined
      )
        return;
      // Whichever of this route and a send's suspended result arrives first
      // presents it and the other joins, so the operator is asked once.
      if (args.resume.status(correlationId) !== "idle") return;
      const result = {
        type: "suspended" as const,
        correlationId,
        approvalSnapshot,
      };
      capture(result, stillCurrent);
      const owned = candidate;
      args.resume.handle(result).then(
        () => {
          if (candidate === owned) candidate = undefined;
        },
        () => {
          logger.warn`parked approval not presented correlation=${redactedCorrelationId(correlationId)}`;
        },
      );
    },
    clear: () => {
      candidate = undefined;
    },
    tryResumeOnce: async (onPresenting) => {
      const current = candidate;
      if (current === undefined) return refused("no-candidate");
      if (current.attempted) {
        candidate = undefined;
        return refused("already-attempted");
      }
      if (!current.stillCurrent()) {
        candidate = undefined;
        return refused("stale");
      }
      current.attempted = true;
      const { correlationId } = current.result;
      // Re-running `handle` only helps when no settlement exists for this
      // correlation. An in-flight one would be joined (it is the wedge), and a
      // handed-over one would be ignored, so both fall back to the abort.
      const standing = args.resume.status(correlationId);
      if (standing !== "idle") return refused(`settlement-${standing}`);
      const storage = args.storage();
      if (storage === undefined) return refused("no-storage");
      try {
        const verified = await resolveSuspendedApprovalFromStore(
          storage,
          current.result,
        );
        if (!verified.ok) return refused(`unverified-${verified.code}`);
        if (!current.stillCurrent()) return refused("stale");
        onPresenting?.();
        await args.resume.handle(current.result);
        // `handle` also settles true when it dropped the decision (timed out,
        // superseded, unrenderable), so only a delivered decision counts.
        if (args.resume.status(correlationId) !== "handed-over")
          return refused("not-delivered");
        candidate = undefined;
        return { handled: true, code: "resumed" };
      } catch (err) {
        // Opaque "error" hid the case where the approval was dropped by a
        // real failure and looked system-declined. Keep the content-free
        // code for the turn marker; the scrubbed cause goes to the warn
        // log and the returned detail so diagnostics can tell a dropped
        // approval from a refusal.
        const detail = causeOf(err);
        logger.warn`stall resume attempt failed correlation=${redactedCorrelationId(correlationId)} error=${detail}`;
        return refused("error", detail);
      }
    },
  };
}

// Rebuild the operator-facing request from the persisted snapshot. The parked
// name is canonicalized first so resume matches live decide(). Scopes come
// from buildRequests (the same decomposition the middleware path shows), with
// the secret-path rule re-applied: secret shell never offers a persistent
// scope, because future secret-path shell always re-asks.
export function requestFromApprovalSnapshot(
  snapshot: ApprovalSnapshot,
  correlationId: string,
  extras: {
    cwd?: string;
    isExtraDenied?: (value: string) => boolean;
  } = {},
): PermissionRequest | null {
  const parsed = ApprovalSnapshotShape(snapshot);
  if (parsed instanceof type.errors) return null;
  const call = {
    id: correlationId,
    name: canonicalToolName(parsed.name),
    arguments: parsed.arguments ?? {},
  };
  const [builtRequest] = buildRequests(call);
  if (builtRequest === undefined) return null;
  const cwd = extras.cwd;
  const request = cwd === undefined ? builtRequest : { ...builtRequest, cwd };
  if (parsed.approvalMode === "allow-once") return { ...request, scopes: [] };
  if (request.tool !== "run_shell") return request;
  const secret = inspectShellSecretReference(
    request.subject,
    cwd,
    extras.isExtraDenied ?? (() => false),
  );
  return shellSecretInspectionRequiresApproval(secret)
    ? { ...request, scopes: [] }
    : request;
}

export async function resolveParkedCallIdFromStore(
  storage: Pick<ContextStore, "load">,
  correlationId: string,
): Promise<string | undefined> {
  return (await parkedCallIds(storage)).get(correlationId);
}

/**
 * Each approval's parked call id from one load. A correlation with more than
 * one approval resolves to none, so the gate's identity check and the
 * rebuild settle never pick different calls.
 */
async function parkedCallIds(
  storage: Pick<ContextStore, "load">,
): Promise<Map<string, string>> {
  const { pendingOperations } = await storage.load();
  const counts = new Map<string, number>();
  for (const operation of pendingOperations) {
    if (operation.kind !== "approval") continue;
    counts.set(
      operation.correlationId,
      (counts.get(operation.correlationId) ?? 0) + 1,
    );
  }
  const ids = new Map<string, string>();
  for (const operation of pendingOperations) {
    const callId = operation.suspendedCall?.id;
    if (
      operation.kind === "approval" &&
      counts.get(operation.correlationId) === 1 &&
      callId !== undefined
    ) {
      ids.set(operation.correlationId, callId);
    }
  }
  return ids;
}

export type SuspendedApprovalResolution =
  | { readonly ok: true; readonly parkedCallId: string }
  | {
      readonly ok: false;
      readonly code:
        | "not-pending"
        | "ambiguous-pending"
        | "snapshot-invalid"
        | "snapshot-mismatch"
        | "settled";
    };

/**
 * Proves that the suspended result still identifies the one persisted call.
 * Failure codes are intentionally content-free so watchdog diagnostics cannot
 * disclose approval or tool payloads.
 */
export async function resolveSuspendedApprovalFromStore(
  storage: Pick<ContextStore, "load">,
  result: Extract<SendResult, { type: "suspended" }>,
): Promise<SuspendedApprovalResolution> {
  const { pendingOperations } = await storage.load();
  const matches = pendingOperations.filter(
    (operation) =>
      operation.kind === "approval" &&
      operation.correlationId === result.correlationId,
  );
  if (matches.length === 0) return { ok: false, code: "not-pending" };
  if (matches.length !== 1) return { ok: false, code: "ambiguous-pending" };
  const operation = matches[0];
  if (operation === undefined) return { ok: false, code: "not-pending" };
  if (operation.timeoutAt !== undefined && operation.timeoutAt <= Date.now())
    return { ok: false, code: "settled" };
  const parked = operation.suspendedCall;
  const persisted = operation.approvalSnapshot;
  const captured = result.approvalSnapshot;
  const parsedPersisted = persisted && ApprovalSnapshotShape(persisted);
  const parsedCaptured = ApprovalSnapshotShape(captured);
  if (
    parked === undefined ||
    parked.id.length === 0 ||
    !parsedPersisted ||
    parsedPersisted instanceof type.errors ||
    parsedCaptured instanceof type.errors
  )
    return { ok: false, code: "snapshot-invalid" };
  if (
    parked.name !== parsedPersisted.name ||
    parked.name !== parsedCaptured.name ||
    parsedPersisted.approvalMode !== parsedCaptured.approvalMode ||
    // The persisted copy is redacted at rest, so its compare still accepts the
    // canonical scrub when that copy is fully redacted. The re-dispatch
    // snapshot is compared raw: different credential values are a mismatch
    // even though both would scrub to the same token.
    !snapshotArgumentsMatch(
      parked.arguments,
      parsedPersisted.arguments ?? {},
      true,
    ) ||
    !snapshotArgumentsMatch(
      parked.arguments,
      parsedCaptured.arguments ?? {},
      false,
    )
  )
    return { ok: false, code: "snapshot-mismatch" };
  return { ok: true, parkedCallId: parked.id };
}

function timeoutResult(
  turns: Awaited<ReturnType<Agent["history"]>>,
  parkedCallId: string,
): boolean {
  return turns.some((turn) =>
    turn.content.some(
      (block) =>
        block.type === "tool_result" &&
        block.callId === parkedCallId &&
        block.content.some(
          (part) =>
            part.type === "text" && part.text === APPROVAL_TIMEOUT_RESULT_TEXT,
        ),
    ),
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function timeoutResultFromHistory(
  history: () => ReturnType<Agent["history"]>,
  parkedCallId: string,
): Promise<boolean> {
  try {
    return timeoutResult(await history(), parkedCallId);
  } catch {
    return false;
  }
}

async function watchParkedTimeout(
  history: () => ReturnType<Agent["history"]>,
  parkedCallId: string,
  signal: AbortSignal,
  pollMs: number,
): Promise<boolean> {
  while (!signal.aborted) {
    await sleep(pollMs, signal);
    if (signal.aborted) return false;
    if (await timeoutResultFromHistory(history, parkedCallId)) return true;
  }
  return false;
}

function decisionMessage(
  correlationId: string,
  outcome: "approved" | "rejected",
  message?: string,
): InboundMessage {
  const body: { outcome: "approved" | "rejected"; message?: string } = {
    outcome,
  };
  if (message !== undefined && message.length > 0) body.message = message;
  return {
    ref: { uid: 0, mailbox: LOCAL_APPROVAL_MAILBOX },
    headers: {
      from: LOCAL_APPROVAL_FROM,
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `approval-${correlationId}`,
      interchangeCorrelationId: correlationId,
      interchangeType:
        outcome === "approved" ? "approval.granted" : "approval.denied",
    },
    flags: [],
    content: JSON.stringify(body),
    signatureStatus: "missing",
  } satisfies InboundMessage;
}

/**
 * What a host deliverer did with a decision: `skipped` when `stillCurrent()`
 * was false by the time it would have sent, so nothing reached the reactor.
 */
export type ApprovalDeliveryOutcome = "delivered" | "skipped";

export function createApprovalResume(args: {
  getAgent: () => Pick<Agent, "deliver" | "history"> | undefined;
  deliver?: (
    message: InboundMessage,
    stillCurrent: () => boolean,
  ) => ApprovalDeliveryOutcome | Promise<ApprovalDeliveryOutcome>;
  captureGeneration?: () => () => boolean;
  onDropped?: (text: string) => void;
  registerParkedCancel?: (cancel: (() => void) | undefined) => void;
  registerOverlayAbort?: (controller: AbortController | undefined) => void;
  parkedTimeoutPollMs?: number;
  resolveParkedCallId: (
    correlationId: string,
  ) => string | undefined | Promise<string | undefined>;
  gate: PermissionGate;
  // Workspace the parked shell ran in, and extras-denied config paths the live
  // decide()/resolveSuspended secret check already consults. Resume rebuilds
  // persistable scopes from the snapshot and must apply the same extras so
  // Always/Project are not offered for extras-secret shell.
  cwd?: string;
  extraDeniedPaths?: readonly string[];
}): ApprovalResume {
  const isExtraDenied = createExtraDeniedPathMatcher(
    args.extraDeniedPaths ?? [],
  );
  // Correlation ids whose decision was handed to the reactor reuse that
  // acceptance: a retry after an observed acceptance returns without opening
  // the gate or delivering again, so the parked call resumes exactly once and
  // a late duplicate acceptance is a no-op. Ids are recorded only when the
  // decision is actually handed over — a failed send (deliver threw, so
  // nothing reached the reactor) retries as before.
  const handedOver = new Set<string>();
  // Settlements currently gating-and-delivering, keyed by correlation id: a
  // concurrent duplicate handle shares the one in-flight outcome instead of
  // opening a second gate, so no waiter is lost and none double-resumes.
  const inflight = new Map<string, Promise<boolean>>();
  // Approvals a generation bump dropped or that were handed to a reactor,
  // keyed by correlation id with the parked call id once known. The reject a
  // drop sends the old agent can be discarded by its closing reactor, or
  // never sent when the drop lands before the parked call resolves; a
  // reactor closed after accepting a decision but before running it leaves
  // the call parked on disk. Each stays here until a rebuilt agent's store
  // shows its call closed.
  const unsettled = new Map<string, string | undefined>();
  const markUnsettled = (
    correlationId: string,
    callId: string | undefined,
  ): void => {
    unsettled.set(correlationId, callId ?? unsettled.get(correlationId));
  };
  // settleOn never removes an entry: with the rebuilt reactor running, its
  // store read can show a call closed between the result being written and
  // the director claiming it. Entries leave by claim, by rotation, or when
  // prepareRebuild finds the call closed with no reactor on the store.
  const silentCalls = new Set<string>();
  const droppedCalls: DroppedApprovalCalls = {
    claim: (callId) => silentCalls.delete(callId),
  };
  const settleSuspended = async (
    result: Extract<SendResult, { type: "suspended" }>,
  ): Promise<boolean> => {
    const generationCurrent = args.captureGeneration?.() ?? (() => true);
    const parkedAgent = args.getAgent();
    if (parkedAgent === undefined)
      throw new Error("approval resume: no live agent");
    const { correlationId, approvalSnapshot } = result;
    let cancelled = false;
    let canReject = false;
    let knownCallId: string | undefined;
    const stillCurrent = (): boolean => !cancelled && generationCurrent();
    const cancelParked = (): void => {
      if (cancelled) return;
      cancelled = true;
      markUnsettled(correlationId, knownCallId);
      if (canReject) {
        parkedAgent.deliver(
          decisionMessage(correlationId, "rejected", APPROVAL_DROPPED_NOTICE),
        );
      }
    };
    const dropParked = (): void => {
      args.onDropped?.(APPROVAL_DROPPED_NOTICE);
      cancelParked();
      // A bump while the call id was resolving recorded the drop without it.
      markUnsettled(correlationId, knownCallId);
    };
    args.registerParkedCancel?.(cancelParked);
    let overlayAbort: AbortController | undefined;
    try {
      // The resolver captures the paired store synchronously before its first await.
      const parkedCallId = await args.resolveParkedCallId(correlationId);
      knownCallId = parkedCallId;
      if (!stillCurrent()) {
        dropParked();
        return true;
      }
      if (parkedCallId === undefined) return true;
      const initialHistory = await parkedAgent.history();
      if (!stillCurrent()) {
        dropParked();
        return true;
      }
      if (timeoutResult(initialHistory, parkedCallId)) return true;
      canReject = true;

      // The parked cancel is unregistered before a decision is delivered,
      // so a bump from here on drops it without cancelParked. Record that
      // drop the moment the delivery is skipped: a rebuild queued behind the
      // delivery must find it.
      const currentOrDropped = (): boolean => {
        if (stillCurrent()) return true;
        markUnsettled(correlationId, parkedCallId);
        return false;
      };
      const deliverDecision = async (
        message: InboundMessage,
      ): Promise<boolean> => {
        if (!currentOrDropped()) return false;
        if (args.deliver !== undefined) {
          const outcome = await args.deliver(message, currentOrDropped);
          if (outcome === "skipped") return false;
        } else {
          parkedAgent.deliver(message);
        }
        handedOver.add(correlationId);
        markUnsettled(correlationId, parkedCallId);
        return true;
      };
      const request =
        approvalSnapshot === undefined
          ? null
          : requestFromApprovalSnapshot(approvalSnapshot, correlationId, {
              ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
              isExtraDenied,
            });
      if (request === null) {
        args.registerParkedCancel?.(undefined);
        await deliverDecision(
          decisionMessage(
            correlationId,
            "rejected",
            "approval surface unavailable",
          ),
        );
        return true;
      }

      overlayAbort = new AbortController();
      args.registerOverlayAbort?.(overlayAbort);
      const timeoutWatch = watchParkedTimeout(
        () => parkedAgent.history(),
        parkedCallId,
        overlayAbort.signal,
        args.parkedTimeoutPollMs ?? 250,
      ).then((timedOut) => {
        if (
          timedOut &&
          overlayAbort !== undefined &&
          !overlayAbort.signal.aborted
        ) {
          overlayAbort.abort(APPROVAL_TIMEOUT_RESULT_TEXT);
        }
        return timedOut;
      });

      const outcome = await args.gate
        .resolveSuspended(request, stillCurrent)
        .catch(async (err: unknown) => {
          // The surface resolves aborts and timeouts as outcomes, so a throw
          // is a real failure. A parked call is never retried (it is not a
          // stall), so reject it now instead of leaving it to the reactor's
          // own timeout, unless that timeout already answered it.
          if (!stillCurrent()) {
            dropParked();
            throw err;
          }
          args.registerParkedCancel?.(undefined);
          const timedOut =
            overlayAbort?.signal.reason === APPROVAL_TIMEOUT_RESULT_TEXT ||
            (await timeoutResultFromHistory(
              () => parkedAgent.history(),
              parkedCallId,
            ));
          // A bump during that history read already cleared this cancel, so
          // deliver the drop here. A call the reactor already timed out is not
          // rejected again.
          if (timedOut) canReject = false;
          if (!stillCurrent()) {
            dropParked();
            throw err;
          }
          if (!timedOut) {
            await deliverDecision(
              decisionMessage(
                correlationId,
                "rejected",
                "approval surface failed",
              ),
            ).catch((deliverErr: unknown) => {
              logger.warn`rejection after a failed approval surface not delivered correlation=${redactedCorrelationId(correlationId)} error=${deliverErr instanceof Error ? deliverErr.name : typeof deliverErr}`;
            });
          }
          throw err;
        });
      if (!overlayAbort.signal.aborted) overlayAbort.abort();
      // The overlay is gone, but its aborted controller still feeds every
      // permission prompt's signal while registered. A resumed call can prompt
      // (approve_worker_call checks the worker's frozen call) before delivery
      // below resolves, and would be denied unseen.
      args.registerOverlayAbort?.(undefined);
      const timedOutDuringOverlay =
        overlayAbort.signal.reason === APPROVAL_TIMEOUT_RESULT_TEXT ||
        (await timeoutWatch);
      if (!stillCurrent()) {
        dropParked();
        return true;
      }
      args.registerParkedCancel?.(undefined);
      const timedOut =
        timedOutDuringOverlay ||
        (await timeoutResultFromHistory(
          () => parkedAgent.history(),
          parkedCallId,
        ));
      if (timedOut) canReject = false;
      if (!stillCurrent()) {
        dropParked();
        return true;
      }
      if (timedOut) {
        logger.warn`late approval decision dropped correlation=${redactedCorrelationId(correlationId)} timeoutCall=${parkedCallId} outcome=${outcome?.allow === true ? "approved" : "rejected"}`;
        return true;
      }
      await deliverDecision(
        decisionMessage(
          correlationId,
          outcome?.allow === true ? "approved" : "rejected",
          outcome?.allow === true ? undefined : outcome?.message,
        ),
      );
      return true;
    } finally {
      if (overlayAbort !== undefined && !overlayAbort.signal.aborted) {
        overlayAbort.abort();
      }
      args.registerOverlayAbort?.(undefined);
      args.registerParkedCancel?.(undefined);
    }
  };

  return {
    status: (correlationId) =>
      handedOver.has(correlationId)
        ? "handed-over"
        : inflight.has(correlationId)
          ? "in-flight"
          : "idle",
    droppedCalls,
    prepareRebuild: async (storage) => {
      if (unsettled.size === 0) return;
      const parked = await parkedCallIds(storage);
      for (const [correlationId, known] of [...unsettled]) {
        const callId = parked.get(correlationId);
        if (callId === undefined) {
          unsettled.delete(correlationId);
          if (known !== undefined) silentCalls.delete(known);
          continue;
        }
        unsettled.set(correlationId, callId);
        silentCalls.add(callId);
      }
    },
    settleOn: async (agent, storage) => {
      if (unsettled.size === 0) return;
      const parked = await parkedCallIds(storage);
      for (const correlationId of [...unsettled.keys()]) {
        const callId = parked.get(correlationId);
        if (callId === undefined) {
          unsettled.delete(correlationId);
          continue;
        }
        unsettled.set(correlationId, callId);
        silentCalls.add(callId);
        agent.deliver(
          decisionMessage(correlationId, "rejected", APPROVAL_DROPPED_NOTICE),
        );
      }
    },
    forgetUnsettled: () => {
      unsettled.clear();
      silentCalls.clear();
    },
    handle: (result) => {
      if (result.type !== "suspended") return Promise.resolve(false);
      const { correlationId } = result;
      if (handedOver.has(correlationId)) {
        logger.warn`duplicate approval resume ignored correlation=${redactedCorrelationId(correlationId)}`;
        return Promise.resolve(true);
      }
      const ongoing = inflight.get(correlationId);
      if (ongoing !== undefined) return ongoing;
      const task = settleSuspended(result);
      inflight.set(correlationId, task);
      const forget = (): void => {
        if (inflight.get(correlationId) === task)
          inflight.delete(correlationId);
      };
      task.then(forget, forget);
      return task;
    },
  };
}
