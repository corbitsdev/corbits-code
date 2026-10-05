/**
 * Bounded worker decision digest (CL-9919). Workers may append one optional,
 * explicitly-delimited versioned JSON block to their report envelope:
 *
 * ```decision:v1
 * {"version":"1","verdict":"fail","required_action":"...","critical_findings":[],"checks":[]}
 * ```
 *
 * The digest never infers verdicts, actions, findings, or check outcomes
 * from prose — only a schema-valid block counts. Harness execution `status`
 * (done/failed/...) stays separate from the worker's claimed `verdict`
 * (pass/fail/blocked): done means the worker exited, not that it passed.
 * Check outcomes are labeled worker-reported/unverified unless trustworthy
 * execution evidence exists (none is wired yet, so all are unverified).
 */

import { type } from "arktype";

/** Fence language workers use; the `:v1` suffix is the format version. */
export const DECISION_FENCE_LANGUAGE = "decision:v1";

/** Inline caps keep any single decision bounded; the digest total cap lives in fleet-dry-drive. */
export const DECISION_REQUIRED_ACTION_CHARS = 512;
export const DECISION_FINDING_CHARS = 280;
export const DECISION_MAX_CRITICAL_FINDINGS = 5;
export const DECISION_MAX_CHECKS = 10;
export const DECISION_CHECK_NAME_CHARS = 128;
export const DECISION_CHECK_DETAIL_CHARS = 256;

const DecisionCheck = type({
  name: "string",
  status: "'passed' | 'failed' | 'skipped'",
  "detail?": "string",
});

const WorkerDecision = type({
  version: "'1'",
  verdict: "'pass' | 'fail' | 'blocked'",
  "required_action?": "string",
  "critical_findings?": "string[]",
  "checks?": DecisionCheck.array(),
});

export type WorkerDecision = typeof WorkerDecision.infer;
export type WorkerDecisionCheck = typeof DecisionCheck.infer;

export type DecisionVerdict = "pass" | "fail" | "blocked" | "unknown";
export type DecisionSource = "worker-v1" | "missing" | "invalid";

export type ParsedWorkerDecision =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly decision: WorkerDecision };

const FENCE_RE = /```\s*decision:([^\s`]*)\s*\r?\n([\s\S]*?)```/g;

function firstFence(text: string): { version: string; body: string } | null {
  FENCE_RE.lastIndex = 0;
  const match = FENCE_RE.exec(text);
  if (match === null) return null;
  return { version: match[1] ?? "", body: match[2] ?? "" };
}

/**
 * Strict boundary parse: only the delimited block counts. Prose around it —
 * however confident ("all checks passed") — never becomes a verdict.
 * When several blocks are present, the first fence wins.
 */
export function parseWorkerDecision(
  report: string | undefined,
): ParsedWorkerDecision {
  if (report === undefined) return { kind: "missing" };
  const fence = firstFence(report);
  if (fence === null) return { kind: "missing" };
  if (fence.version !== "v1") return { kind: "invalid" };
  let raw: unknown;
  try {
    raw = JSON.parse(fence.body);
  } catch {
    return { kind: "invalid" };
  }
  const checked = WorkerDecision(raw);
  if (checked instanceof type.errors) return { kind: "invalid" };
  return { kind: "ok", decision: checked };
}

export function formatWorkerDecisionBlock(decision: WorkerDecision): string {
  return [
    "```" + DECISION_FENCE_LANGUAGE,
    JSON.stringify(decision),
    "```",
  ].join("\n");
}

function clipWithSignal(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, max).trimEnd();
  const remaining = text.length - kept.length;
  return `${kept}… (+${remaining.toLocaleString()} more chars omitted)`;
}

export interface DigestDecisionCheck {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly verification: "worker-reported/unverified";
  readonly detail?: string;
}

/** Digest-ready decision fields: bounded, with visible truncation signals. */
export interface DigestDecision {
  readonly verdict: DecisionVerdict;
  readonly source: DecisionSource;
  readonly required_action?: string;
  readonly critical_findings?: string;
  readonly checks?: readonly DigestDecisionCheck[];
}

function toDigestChecks(
  checks: readonly WorkerDecisionCheck[] | undefined,
): readonly DigestDecisionCheck[] | undefined {
  if (checks === undefined || checks.length === 0) return undefined;
  if (checks.length <= DECISION_MAX_CHECKS) {
    return checks.map((check) => ({
      name: clipWithSignal(check.name, DECISION_CHECK_NAME_CHARS),
      status: check.status,
      verification: "worker-reported/unverified" as const,
      ...(check.detail !== undefined
        ? { detail: clipWithSignal(check.detail, DECISION_CHECK_DETAIL_CHARS) }
        : {}),
    }));
  }
  const kept = checks.slice(0, DECISION_MAX_CHECKS - 1).map((check) => ({
    name: clipWithSignal(check.name, DECISION_CHECK_NAME_CHARS),
    status: check.status,
    verification: "worker-reported/unverified" as const,
    ...(check.detail !== undefined
      ? { detail: clipWithSignal(check.detail, DECISION_CHECK_DETAIL_CHARS) }
      : {}),
  }));
  const omitted = checks.length - (DECISION_MAX_CHECKS - 1);
  return [
    ...kept,
    {
      name: `+${omitted} more check(s) omitted`,
      status: "skipped" as const,
      verification: "worker-reported/unverified" as const,
    },
  ];
}

function toDigestFindings(
  findings: readonly string[] | undefined,
): string | undefined {
  if (findings === undefined || findings.length === 0) return undefined;
  const clipped = findings
    .slice(0, DECISION_MAX_CRITICAL_FINDINGS)
    .map((finding) => clipWithSignal(finding, DECISION_FINDING_CHARS));
  if (findings.length > DECISION_MAX_CRITICAL_FINDINGS) {
    clipped.push(
      `+${findings.length - DECISION_MAX_CRITICAL_FINDINGS} more finding(s) omitted`,
    );
  }
  return clipped.join("\n");
}

export function toDigestDecision(parsed: ParsedWorkerDecision): DigestDecision {
  if (parsed.kind === "missing") {
    return { verdict: "unknown", source: "missing" };
  }
  if (parsed.kind === "invalid") {
    return { verdict: "unknown", source: "invalid" };
  }
  const { decision } = parsed;
  const findings = toDigestFindings(decision.critical_findings);
  const checks = toDigestChecks(decision.checks);
  return {
    verdict: decision.verdict,
    source: "worker-v1",
    ...(decision.required_action !== undefined &&
    decision.required_action.length > 0
      ? {
          required_action: clipWithSignal(
            decision.required_action,
            DECISION_REQUIRED_ACTION_CHARS,
          ),
        }
      : {}),
    ...(findings !== undefined ? { critical_findings: findings } : {}),
    ...(checks !== undefined ? { checks } : {}),
  };
}
