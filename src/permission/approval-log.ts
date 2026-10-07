/**
 * Approval log: one record every time the permission gate settles a
 * consequential action, from an operator prompt or auto mode.
 *
 * Records hold only fixed enums, counts, and timestamps — never command text,
 * paths, or model-authored free text. A sub-agent's free-text dispatch label
 * is deliberately left out even though it would enable a per-agent breakdown,
 * because nothing constrains what a model puts in it. Writes are fire-and-
 * forget and never throw: a diagnostic must not be able to fail a run.
 * MAX_RECORD_BYTES caps the serialized line against a future field
 * reintroducing free text.
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
  | "allow-once"
  | "allow-with-scope"
  | "deny"
  | "auto-allow"
  | "auto-deny"
  | "timeout"
  | "abort";

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
  /** Real (non-comment) shell chain segment count, for run_shell requests. */
  segments?: number;
  outcome: ApprovalOutcomeKind;
  /** ISO timestamp the request was raised (queued for an operator or a policy check). */
  queuedAt: string;
  /**
   * ISO timestamp the request actually reached the operator's screen. Equal
   * to queuedAt unless the request sat behind another overlay first — the gap
   * is the defect signal for timers arming before the operator can see the
   * request.
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
  segments?: number;
}

// Cap on the serialized record. Every field is a fixed enum, count, or
// timestamp, so a well-formed line never comes close — it exists only so a
// future field that reintroduces free text cannot grow this file into a
// content leak. Oversized lines are dropped, not truncated, so no partial
// secret survives half-written.
const MAX_RECORD_BYTES = 512;

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
    markDisplayed: () => undefined,
    settle: () => undefined,
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
export function createApprovalLog(
  dir: string,
  now: () => Date = () => new Date(),
): ApprovalLog & { flush: () => Promise<void> } {
  const path = join(dir, APPROVAL_LOG_FILE);
  const log = getLogger(`${LOG_NAMESPACE_ROOT}:approval-log`);
  let tail: Promise<void> = Promise.resolve();

  const append = (record: ApprovalRecord): void => {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      log.debug?.("approval log record dropped: exceeds max size");
      return;
    }
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
            ...(event.segments !== undefined
              ? { segments: event.segments }
              : {}),
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
    // Resolves once every append issued so far has settled. The decision
    // path never awaits it; tests use it instead of a sleep to read the
    // log deterministically.
    flush: () => tail,
  };
}
