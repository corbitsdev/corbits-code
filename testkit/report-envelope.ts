// Canonical report-envelope fixtures shared by the subagent test suites.
// Values are load-bearing: tests assert on the exact headings and text, so
// keep them byte-identical.

export const REPORT_ENVELOPE = [
  "## Summary",
  "Reviewed gate.ts.",
  "",
  "## Findings",
  "Auth lives in gate.ts.",
  "",
  "## Blockers",
  "None.",
  "",
  "## Paths",
  "src/gate.ts",
].join("\n");

export const STUB_PLAN_ENVELOPE = [
  "## Summary",
  "Plan ready.",
  "",
  "## Findings",
  "None.",
  "",
  "## Blockers",
  "None.",
  "",
  "## Paths",
  "None.",
].join("\n");

export const PASS_PLAN_FINDINGS = [
  "### Files / paths",
  "src/subagent/report.ts",
  "",
  "### Acceptance criteria",
  "Stub plan Findings salvage as incomplete-report.",
  "",
  "### Non-goals",
  "Do not finish CL-6946.",
  "",
  "### Risks",
  "A headings-only complete would auto-dispatch builder on a stub.",
  "",
  "### Ordered steps",
  "Add hasPlanFindings, then wire evaluateSubAgentStop.",
].join("\n");

export const PASS_PLAN_ENVELOPE = [
  "## Summary",
  "Plan for the salvage gate.",
  "",
  "## Findings",
  PASS_PLAN_FINDINGS,
  "",
  "## Blockers",
  "None.",
  "",
  "## Paths",
  "src/subagent/report.ts",
].join("\n");
