/**
 * Approval log: one record every time the permission gate settles a
 * consequential action — whether that settlement came from an operator
 * prompt or from auto mode deciding without one.
 *
 * Before this file, the only durable record of an approval was a lifetime
 * "Allow Always" grant (see store.ts) — every allow-once and every deny, the
 * overwhelming majority of answers, was discarded the moment it was given.
 * There was no way to answer how many approvals a session fires, which
 * classifier rule triggers them, or whether a prompt was even auto-allowed by
 * policy rather than shown to the operator (CL-5666).
 *
 * No command text, file content, path, or credential ever appears here — only
 * the tool name, the classifier/auto-shell rule that fired (reusing the rule
 * names already defined in auto-shell-policy.ts and classify.ts, not a new
 * taxonomy), a shell chain's segment count, and timing. Writes are
 * fire-and-forget and never throw: a diagnostic must not be able to fail a
 * run.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";

export const APPROVAL_LOG_FILE = "approvals.jsonl";

/** Whether the settlement came from an unattended policy decision or an operator prompt. */
export type ApprovalMode = "auto" | "interactive";

/**
 * How the request settled. `allow-once` / `allow-with-scope` / `deny` are
 * operator decisions; `auto-allow` / `auto-deny` are auto-mode policy
 * decisions made without a prompt; `timeout` / `abort` are the gate settling
 * itself because the operator never answered.
 */
export type ApprovalOutcomeKind =
  "allow-once" | "allow-with-scope" | "deny" | "auto-allow" | "auto-deny" | "timeout" | "abort";

export interface ApprovalRecord {
  /** Correlates this settlement with the ask that raised it. */
  id: string;
  tool: string;
  /**
   * The classifier/auto-shell rule name that triggered this decision (e.g.
   * "dependency-install", "sensitive-path" from auto-shell-policy.ts), when
   * one fired. Undefined for a plain interactive ask with no specific rule.
   */
  rule?: string;
  mode: ApprovalMode;
  /** The requesting sub-agent's label, when this request came from one. */
  agentLabel?: string;
  /** Real (non-comment) shell chain segment count, for run_shell requests. */
  segments?: number;
  outcome: ApprovalOutcomeKind;
  /** ISO timestamp the request was raised (queued for an operator or a policy check). */
  queuedAt: string;
  /**
   * ISO timestamp the request actually reached the operator's screen. Equal
   * to queuedAt unless the request sat behind another overlay first — the gap
   * between the two is the CL-5664 defect signal (timers arming before the
   * operator can see the request).
   */
  displayedAt: string;
  /** ISO timestamp the request settled (decided, auto-decided, timed out, or aborted). */
  settledAt: string;
  /** settledAt - queuedAt, in milliseconds. */
  durationMs: number;
  /** displayedAt - queuedAt, in milliseconds. */
  displayDelayMs: number;
}

export interface AskEvent {
  tool: string;
  rule?: string;
  mode: ApprovalMode;
  agentLabel?: string;
  segments?: number;
}

/** Handle for one in-flight ask, returned by ApprovalLog.ask(). */
export interface ApprovalAsk {
  readonly id: string;
  /** Mark the moment this request actually reached the operator's screen. Idempotent. */
  markDisplayed: () => void;
  /** Settle the ask and append its record. Safe to call at most meaningfully once. */
  settle: (outcome: ApprovalOutcomeKind) => void;
}

export interface ApprovalLog {
  ask: (event: AskEvent) => ApprovalAsk;
}

/** Log that drops everything — the default, so logging is never required. */
export const NOOP_APPROVAL_LOG: ApprovalLog = {
  ask: () => ({
    id: "",
    markDisplayed: () => {},
    settle: () => {},
  }),
};

/**
 * Append-only sink over `<dir>/approvals.jsonl`.
 *
 * Appends are fire-and-forget: the caller is on the permission-gate decision
 * path, and a diagnostic write must not add latency to it or fail the run.
 * Ordering within a session is preserved by chaining each append onto the
 * previous one.
 */
export function createApprovalLog(dir: string, now: () => Date = () => new Date()): ApprovalLog {
  const path = join(dir, APPROVAL_LOG_FILE);
  const log = getLogger(`${LOG_NAMESPACE_ROOT}:approval-log`);
  let tail: Promise<void> = Promise.resolve();

  const append = (record: ApprovalRecord): void => {
    const line = `${JSON.stringify(record)}\n`;
    tail = tail.then(
      () =>
        appendFile(path, line, "utf8").catch((err: unknown) => {
          log.debug?.(`approval log append failed: ${String(err)}`);
        }),
      () => undefined,
    );
  };

  return {
    ask: (event) => {
      const id = randomUUID();
      const queuedAt = now();
      let displayedAt: Date | undefined;
      let settled = false;
      return {
        id,
        markDisplayed: () => {
          if (displayedAt === undefined) displayedAt = now();
        },
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          const settledAt = now();
          const displayed = displayedAt ?? queuedAt;
          append({
            id,
            tool: event.tool,
            ...(event.rule !== undefined ? { rule: event.rule } : {}),
            mode: event.mode,
            ...(event.agentLabel !== undefined ? { agentLabel: event.agentLabel } : {}),
            ...(event.segments !== undefined ? { segments: event.segments } : {}),
            outcome,
            queuedAt: queuedAt.toISOString(),
            displayedAt: displayed.toISOString(),
            settledAt: settledAt.toISOString(),
            durationMs: settledAt.getTime() - queuedAt.getTime(),
            displayDelayMs: displayed.getTime() - queuedAt.getTime(),
          });
        },
      };
    },
  };
}
