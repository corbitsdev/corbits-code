// Sub-agent report envelope + dispatch brief formatting.
//
// The base layer of the sub-agent module graph: pure string shaping with no
// dependencies on other sub-agent modules. Parsed/formatted here so the stop
// policy (forcedStopReport / classifiers) and the run loop (activity summary)
// share one definition of the report shape.

import type { ReactorEmittedEvent } from "@intx/inference";

/** Typed spawn intent — optional on `task`; omit Intent section when unset. */
export type TaskIntent = "explore" | "implement" | "review" | "plan" | "general";

// Extract the tool name from a sub-agent stream event. tool.start carries the
// call name at execution time; counting starts only (not ends) keeps the
// activity summary at one entry per invocation.
export function subAgentToolName(event: ReactorEmittedEvent): string | null {
  if (event.type !== "tool.start") return null;
  const call = (event as { data?: { call?: { name?: unknown } } }).data?.call;
  if (typeof call?.name === "string" && call.name.length > 0) return call.name;
  return null;
}

// Append a short activity footer so the parent model (and the operator reading
// the tool result) can see what the sub-agent actually did. Without this the
// only signal is the free-form reply, which models often omit tool details from.
export function appendActivitySummary(reply: string, toolNames: readonly string[]): string {
  if (toolNames.length === 0) return reply;
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
  return `${reply}\n\n[tools: ${parts.join(", ")}]`;
}

// Build the user message handed to a sub-agent. Separates durable context from
// the actionable goal so workers follow the brief instead of treating one
// free-form blob as optional color. Optional goals seed a checklist hint
// (manage_tasks on the child owns the real list). Typed spawn fields
// (intent / success_criteria / do_not / report_focus) are rendered only when set.
export interface DispatchBrief {
  description: string;
  prompt: string;
  context?: string;
  goals?: readonly string[];
  intent?: TaskIntent;
  successCriteria?: readonly string[];
  doNot?: readonly string[];
  reportFocus?: string;
  /** Turn token (CL-6946) a leaf must echo back to `submit_result`. Leaf-tier dispatches only. */
  turnToken?: string;
}

export function buildDispatchBrief(brief: DispatchBrief): string {
  const parts: string[] = [`# Dispatch brief: ${brief.description}`, "", "## Goal", brief.prompt];
  if (brief.context !== undefined && brief.context.trim().length > 0) {
    parts.push("", "## Context", brief.context.trim());
  }
  // Omit Intent when unset for back-compat (do not default-render "general").
  if (brief.intent !== undefined) {
    parts.push("", "## Intent", brief.intent);
  }
  // Prefer success_criteria as the done-definition; goals stay as checklist seed.
  if (brief.successCriteria !== undefined && brief.successCriteria.length > 0) {
    parts.push(
      "",
      "## Success criteria",
      "Treat these as the done-definition — when all are met (or blocked), stop tools and emit the report envelope:",
      ...brief.successCriteria.map((c, i) => `${i + 1}. ${c}`),
    );
  }
  if (brief.doNot !== undefined && brief.doNot.length > 0) {
    parts.push("", "## Do not", ...brief.doNot.map((d, i) => `${i + 1}. ${d}`));
  }
  if (brief.goals !== undefined && brief.goals.length > 0) {
    parts.push(
      "",
      "## Suggested checklist",
      "Seed these into manage_tasks if the job is multi-step, then work them in order:",
      ...brief.goals.map((g, i) => `${i + 1}. ${g}`),
    );
  }
  const reportLines = [
    "When finished, reply with the ## Summary / ## Findings / ## Blockers / ## Paths envelope from your system prompt. Stay inside this brief.",
  ];
  if (brief.reportFocus !== undefined && brief.reportFocus.trim().length > 0) {
    reportLines.push(`Focus Findings on: ${brief.reportFocus.trim()}`);
  }
  parts.push("", "## Report shape", ...reportLines);
  if (brief.turnToken !== undefined && brief.turnToken.length > 0) {
    parts.push(
      "",
      "## Turn token",
      brief.turnToken,
      `If you call submit_result, pass turn_token="${brief.turnToken}" exactly. A mismatched token means this turn was superseded — do not resubmit under it.`,
    );
  }
  return parts.join("\n");
}

/** Headings `parseSubAgentReport` recognizes. Presence of all four is the completeness gate. */
const REPORT_ENVELOPE_HEADINGS = ["Summary", "Findings", "Blockers", "Paths"] as const;

/** True iff `text` has all four report headings (`^##\s+Name\s*$` per line, case-insensitive). */
export function hasReportEnvelope(text: string): boolean {
  return REPORT_ENVELOPE_HEADINGS.every((name) =>
    new RegExp(`^##\\s+${name}\\s*$`, "im").test(text),
  );
}

/** Demote ## Summary|Findings|Blockers|Paths lines so nested envelopes stay under Findings. */
export function demoteNestedReportHeadings(text: string): string {
  // Match parseSubAgentReport: flexible whitespace + case-insensitive section names.
  return text.replace(/^##\s+(Summary|Findings|Blockers|Paths)\b/gim, "### $1");
}

// Normalize a worker's final text into the structured report envelope. Missing
// sections fall back so a partial or free-form reply still returns something
// useful to the parent instead of a raw dump.
export interface SubAgentReport {
  summary: string;
  findings: string;
  blockers: string;
  paths: string;
  /**
   * Machine-readable termination reason for a forced stop (e.g.
   * `turn-budget — 40/40 turns`). Rendered as a dedicated
   * `Stopped:` line above the envelope; absent on successful completes.
   */
  stopped?: string;
}

const STOPPED_LINE_RE = /^Stopped:\s*(.+)$/m;

/** Machine-readable stop reason from a report's `Stopped:` line, or null. */
export function stopReasonFromReport(report: string): string | null {
  return parseSubAgentReport(report).stopped ?? null;
}

export function parseSubAgentReport(reply: string): SubAgentReport {
  const text = reply.trim();
  const sections: Record<string, string> = {};
  const headingRe = /^##\s+(Summary|Findings|Blockers|Paths)\s*$/gim;
  const matches = [...text.matchAll(headingRe)];
  // Only the preamble (before the first heading) can carry the report's own
  // Stopped: line — a nested forced-stop report quoted under Findings must
  // not be read as this report's reason.
  const preamble = matches.length > 0 ? text.slice(0, matches[0]?.index ?? 0) : "";
  const stopped = STOPPED_LINE_RE.exec(preamble)?.[1]?.trim();
  if (matches.length === 0) {
    return {
      summary: text.length > 0 ? text : "Sub-agent finished without a textual result.",
      findings: "",
      blockers: "",
      paths: "",
    };
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = m[1]!.toLowerCase();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    sections[name] = text.slice(start, end).trim();
  }
  return {
    summary: sections.summary ?? "",
    findings: sections.findings ?? "",
    blockers: sections.blockers ?? "",
    paths: sections.paths ?? "",
    ...(stopped !== undefined && stopped.length > 0 ? { stopped } : {}),
  };
}

export function formatSubAgentReport(report: SubAgentReport): string {
  const lines: string[] = [];
  if (report.stopped !== undefined && report.stopped.length > 0) {
    lines.push(`Stopped: ${report.stopped}`, "");
  }
  lines.push("## Summary", report.summary.length > 0 ? report.summary : "(no summary)");
  if (report.findings.length > 0) {
    lines.push("", "## Findings", report.findings);
  }
  if (report.blockers.length > 0) {
    lines.push("", "## Blockers", report.blockers);
  }
  if (report.paths.length > 0) {
    lines.push("", "## Paths", report.paths);
  }
  return lines.join("\n");
}
