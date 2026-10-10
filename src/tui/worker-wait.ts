/**
 * The WORKER WAITING strip: a standing, composer-adjacent line shown while a
 * root worker is parked on `ask_director`.
 *
 * The runtime already wakes the primary agent with the question, but a wake
 * turn can scroll out of a long transcript and leave the terminal looking
 * idle. The strip keeps the fact on screen and says who owns the answer: the
 * director, through `send_input`. It is display only. Nothing here routes
 * composer text to a worker or settles an ask.
 *
 * Pure: pending-ask snapshots in, a view model and styled parts out. The
 * snapshot is the only source of truth; an item leaves only when a later
 * snapshot omits its `sessionId + questionId`. Paint lives in
 * shell/chrome.ts; the row budget lives in geometry (zone `worker_wait`).
 */

import type { PendingAskWake } from "../subagent/fleet-report.js";
import type { EscalationAssessment } from "../subagent/escalation-policy.js";
import { stripTerminalControlSequences } from "../util/control-char-strip.js";
import { sliceToWidth, stringWidth } from "./view/height.js";

export interface WorkerWaitItem {
  /** Identity: `sessionId + questionId`, encoded so neither half can alias. */
  readonly key: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly agentId: string;
  readonly description: string;
  readonly question: string;
  /** Immutable policy detail for this live question; display only. */
  readonly assessment?: EscalationAssessment;
}

export interface WorkerWaitState {
  /** Live waits in snapshot order, one per session. */
  readonly items: readonly WorkerWaitItem[];
  /** Identity the strip shows, or null when nothing is waiting. */
  readonly selectedKey: string | null;
}

export const NO_WORKER_WAIT: WorkerWaitState = { items: [], selectedKey: null };

function identityKey(sessionId: string, questionId: string): string {
  return JSON.stringify([sessionId, questionId]);
}

function sameItem(a: WorkerWaitItem, b: WorkerWaitItem): boolean {
  return (
    a.key === b.key &&
    a.agentId === b.agentId &&
    a.description === b.description &&
    a.question === b.question &&
    a.assessment === b.assessment
  );
}

/**
 * Fold the next authoritative snapshot into the view model.
 *
 * One item per session, last report wins: a session has a single live
 * question, so a new `questionId` replaces the old one in place and starts
 * fresh (the old identity is gone, so it cannot keep the selection). The
 * selection survives while its identity is still live; otherwise it falls
 * back to the first item in snapshot order, because the source carries no
 * timestamps to order by. An unchanged snapshot returns `prev` itself so a
 * repeat report costs the chrome nothing.
 */
export function reduceWorkerWait(
  prev: WorkerWaitState,
  asks: readonly PendingAskWake[],
): WorkerWaitState {
  const bySession = new Map<string, WorkerWaitItem>();
  for (const ask of asks) {
    bySession.set(ask.sessionId, {
      key: identityKey(ask.sessionId, ask.questionId),
      sessionId: ask.sessionId,
      questionId: ask.questionId,
      agentId: ask.agentId,
      description: ask.description,
      question: ask.question,
      ...(ask.assessment === undefined ? {} : { assessment: ask.assessment }),
    });
  }
  const items = [...bySession.values()];
  const kept =
    prev.selectedKey !== null &&
    items.some((item) => item.key === prev.selectedKey);
  const selectedKey = kept ? prev.selectedKey : (items[0]?.key ?? null);
  if (
    selectedKey === prev.selectedKey &&
    items.length === prev.items.length &&
    items.every((item, i) => {
      const before = prev.items[i];
      return before !== undefined && sameItem(item, before);
    })
  ) {
    return prev;
  }
  return { items, selectedKey };
}

export function selectedWorkerWait(
  state: WorkerWaitState,
): WorkerWaitItem | null {
  return state.items.find((item) => item.key === state.selectedKey) ?? null;
}

/** Live waits beyond the one on screen. */
export function workerWaitMoreCount(state: WorkerWaitState): number {
  return Math.max(0, state.items.length - 1);
}

export type WorkerWaitRole =
  | "mark"
  | "label"
  | "separator"
  | "routing"
  | "requester"
  | "question"
  | "more";

export interface WorkerWaitPart {
  readonly text: string;
  readonly role: WorkerWaitRole;
}

/**
 * Worker-supplied text on one row. Terminal sequences are stripped so a
 * worker cannot restyle chrome or move the cursor; line breaks fold into
 * single spaces so the preview never claims a second row.
 */
export function oneLinePreview(text: string): string {
  return stripTerminalControlSequences(text).replace(/\s+/g, " ").trim();
}

/** Concise assessed-decision detail for the live panel; it never routes or resolves. */
export function workerWaitDecisionSummary(item: WorkerWaitItem): string {
  const assessment = item.assessment;
  if (assessment === undefined) return item.question;
  const recommendation = assessment.recommendation ?? assessment.safeDefault;
  return [
    `classification: ${assessment.classification}`,
    `outcome: ${assessment.blockedOutcome}`,
    `minimum: ${assessment.minimumAuthority ?? assessment.minimumAddition}`,
    `consequence: ${assessment.declineConsequence}`,
    ...(recommendation === undefined
      ? []
      : [`recommendation: ${recommendation}`]),
    `target: ${item.sessionId}`,
  ].join("; ");
}

const MARK = "◆";
const LABEL = "WORKER WAITING";
const LABEL_COMPACT = "WAITING";
const ROUTING_FULL = "director reply needed (send_input)";
const ROUTING = "director reply needed";
const ROUTING_COMPACT = "director reply";
const SEPARATOR = " · ";
const ELLIPSIS = "…";

/**
 * Narrowest question preview worth keeping. Below this the cells say more as
 * requester metadata than as a few characters of question.
 */
const QUESTION_MIN_CELLS = 12;

function partsWidth(parts: readonly WorkerWaitPart[]): number {
  return parts.reduce((sum, part) => sum + stringWidth(part.text), 0);
}

function fitQuestion(question: string, cells: number): string {
  if (stringWidth(question) <= cells) return question;
  if (cells <= stringWidth(ELLIPSIS)) return "";
  return sliceToWidth(question, cells - stringWidth(ELLIPSIS)) + ELLIPSIS;
}

interface Tier {
  readonly label: string;
  readonly routing: string | null;
  readonly requester: string | null;
  readonly question: boolean;
}

const COMPACT_TIER: Tier = {
  label: LABEL_COMPACT,
  routing: null,
  requester: null,
  question: false,
};

function head(tier: Tier): WorkerWaitPart[] {
  const parts: WorkerWaitPart[] = [
    { text: `${MARK} `, role: "mark" },
    { text: tier.label, role: "label" },
  ];
  if (tier.routing !== null) {
    parts.push({ text: SEPARATOR, role: "separator" });
    parts.push({ text: tier.routing, role: "routing" });
  }
  if (tier.requester !== null) {
    parts.push({ text: SEPARATOR, role: "separator" });
    parts.push({ text: tier.requester, role: "requester" });
  }
  return parts;
}

/**
 * The strip's styled parts for a content width, or [] when nothing waits.
 *
 * Degrades in a fixed order so the meaning that matters most survives
 * longest: the question truncates first, down to a short preview; then the
 * requester loses its description and the routing copy compacts; then the
 * preview drops, then the requester id, then the routing copy, then the
 * label shortens. The `(+N more)` count stays until only a hard slice of the
 * compact label is left.
 */
export function composeWorkerWaitLine(
  state: WorkerWaitState,
  width: number,
): readonly WorkerWaitPart[] {
  const item = selectedWorkerWait(state);
  if (item === null || width <= 0) return [];
  const agentId = oneLinePreview(item.agentId);
  const description = oneLinePreview(item.description);
  const question = oneLinePreview(workerWaitDecisionSummary(item));
  const requesterFull =
    description.length > 0 && description !== agentId
      ? agentId.length > 0
        ? `${agentId} (${description})`
        : description
      : agentId;
  const requesterId = agentId.length > 0 ? agentId : null;
  const more = workerWaitMoreCount(state);
  const moreParts: WorkerWaitPart[] =
    more > 0 ? [{ text: ` (+${more} more)`, role: "more" }] : [];
  const moreCost = partsWidth(moreParts);
  const hasQuestion = question.length > 0;
  const fullRequester = requesterFull.length > 0 ? requesterFull : null;

  const q = hasQuestion;
  const tiers: readonly Tier[] = [
    {
      label: LABEL,
      routing: ROUTING_FULL,
      requester: fullRequester,
      question: q,
    },
    { label: LABEL, routing: ROUTING, requester: fullRequester, question: q },
    { label: LABEL, routing: ROUTING, requester: requesterId, question: q },
    {
      label: LABEL,
      routing: ROUTING_COMPACT,
      requester: requesterId,
      question: q,
    },
    { label: LABEL, routing: ROUTING_COMPACT, requester: null, question: q },
    {
      label: LABEL,
      routing: ROUTING_COMPACT,
      requester: requesterId,
      question: false,
    },
    {
      label: LABEL,
      routing: ROUTING_COMPACT,
      requester: null,
      question: false,
    },
    { label: LABEL, routing: null, requester: null, question: false },
    COMPACT_TIER,
  ];

  for (const tier of tiers) {
    const parts = head(tier);
    if (tier.question) {
      const colon: WorkerWaitPart = {
        text: tier.requester !== null ? ": " : SEPARATOR,
        role: "separator",
      };
      const room =
        width - partsWidth(parts) - stringWidth(colon.text) - moreCost;
      const need = Math.min(QUESTION_MIN_CELLS, stringWidth(question));
      if (room < need) continue;
      parts.push(colon, {
        text: fitQuestion(question, room),
        role: "question",
      });
      return [...parts, ...moreParts];
    }
    if (partsWidth(parts) + moreCost <= width) return [...parts, ...moreParts];
  }

  // Narrower than even the compact label and its count: slice what is left.
  const last = [...head(COMPACT_TIER), ...moreParts];
  const sliced: WorkerWaitPart[] = [];
  let remaining = width;
  for (const part of last) {
    if (remaining <= 0) break;
    const text = sliceToWidth(part.text, remaining);
    if (text.length === 0) break;
    sliced.push({ text, role: part.role });
    remaining -= stringWidth(text);
  }
  return sliced;
}
